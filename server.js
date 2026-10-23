const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CAPACITY_LIMIT = 200;
const SESSION_HOURS = 12;
const db = new Database(process.env.PARKWISE_DB_PATH || path.join(__dirname, 'parkwise.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  capacity INTEGER NOT NULL DEFAULT 200,
  hourly_rate REAL NOT NULL DEFAULT 30
);
INSERT OR IGNORE INTO settings(id, capacity, hourly_rate) VALUES(1, 200, 30);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  owner_name TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  phone TEXT DEFAULT '',
  slot_number INTEGER NOT NULL UNIQUE,
  entry_time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS parking_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vehicle_number TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  phone TEXT DEFAULT '',
  slot_number INTEGER NOT NULL,
  entry_time TEXT NOT NULL,
  exit_time TEXT NOT NULL,
  charged_hours INTEGER NOT NULL,
  fee REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  address TEXT NOT NULL DEFAULT '',
  capacity INTEGER NOT NULL,
  hourly_rate REAL NOT NULL,
  rates_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id INTEGER NOT NULL REFERENCES lots(id),
  vehicle_number TEXT NOT NULL COLLATE NOCASE,
  owner_name TEXT NOT NULL,
  vehicle_type TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','operator')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  username TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY
);
`);

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function addColumnIfMissing(table, name, definition) {
  if (!tableColumns(table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

const legacySettings = db.prepare('SELECT capacity, hourly_rate FROM settings WHERE id=1').get();
db.prepare(`
  INSERT OR IGNORE INTO lots(id, name, address, capacity, hourly_rate, rates_json, created_at)
  VALUES(1, 'Main Parking', '', ?, ?, '{}', ?)
`).run(legacySettings.capacity, legacySettings.hourly_rate, new Date().toISOString());
addColumnIfMissing('parking_history', 'lot_id', 'INTEGER NOT NULL DEFAULT 1');
addColumnIfMissing('parking_history', 'rate_applied', `REAL NOT NULL DEFAULT ${Number(legacySettings.hourly_rate)}`);
addColumnIfMissing('vehicles', 'lot_id', 'INTEGER NOT NULL DEFAULT 1');

const schemaVersion = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version || 0;
if (schemaVersion < 1) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE vehicles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vehicle_number TEXT NOT NULL COLLATE NOCASE,
        owner_name TEXT NOT NULL,
        vehicle_type TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        slot_number INTEGER NOT NULL,
        entry_time TEXT NOT NULL,
        lot_id INTEGER NOT NULL DEFAULT 1,
        UNIQUE(vehicle_number, lot_id),
        UNIQUE(slot_number, lot_id)
      );
      INSERT INTO vehicles_new(id, vehicle_number, owner_name, vehicle_type, phone, slot_number, entry_time, lot_id)
        SELECT id, vehicle_number, owner_name, vehicle_type, COALESCE(phone, ''), slot_number, entry_time, lot_id
        FROM vehicles;
      DROP TABLE vehicles;
      ALTER TABLE vehicles_new RENAME TO vehicles;
      CREATE INDEX vehicles_lot_entry ON vehicles(lot_id, entry_time DESC);
      CREATE INDEX history_lot_exit ON parking_history(lot_id, exit_time DESC);
      CREATE INDEX reservations_lot_times ON reservations(lot_id, status, starts_at, ends_at);
      INSERT INTO schema_migrations(version) VALUES(1);
    `);
  })();
}
db.pragma('foreign_keys = ON');

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use('/vendor/tesseract', express.static(path.join(path.dirname(require.resolve('tesseract.js')), '..', 'dist'), {
  immutable: true,
  maxAge: '1y'
}));
app.use(express.static(path.join(__dirname, 'public')));

const nowIso = () => new Date().toISOString();
const validObjectBody = body => body !== null && typeof body === 'object' && !Array.isArray(body);
const cleanText = (value, max = 100) => String(value ?? '').trim().slice(0, max);
const apiError = (res, status, message) => res.status(status).json({ error: message });
const getLot = db.prepare('SELECT id, name, address, capacity, hourly_rate AS rate, rates_json AS ratesJson FROM lots WHERE id=?');

function serializeLot(lot) {
  if (!lot) return null;
  let rates = {};
  try {
    rates = JSON.parse(lot.ratesJson);
  } catch (error) {
    console.error('Invalid parking rate configuration for lot', lot.id, error);
  }
  return { id: lot.id, name: lot.name, address: lot.address, capacity: lot.capacity, rate: lot.rate, rates };
}

function parseLotId(value) {
  const id = Number(value ?? 1);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored).split(':');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  return (req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(prefix))?.slice(prefix.length) || '';
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `parkwise_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'parkwise_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

function audit(req, action, details = {}) {
  db.prepare('INSERT INTO audit_log(user_id, username, action, details, created_at) VALUES(?,?,?,?,?)')
    .run(req.user.id, req.user.username, action, JSON.stringify(details), nowIso());
}

function authenticate(req, res, next) {
  const token = cookieValue(req, 'parkwise_session');
  if (!token) return apiError(res, 401, 'Please sign in to continue.');
  const session = db.prepare(`
    SELECT u.id, u.username, u.role
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1
  `).get(hashToken(token), nowIso());
  if (!session) {
    clearSessionCookie(res);
    return apiError(res, 401, 'Your session expired. Please sign in again.');
  }
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return apiError(res, 403, 'Administrator access is required.');
  next();
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 200;
}

function validPlate(value) {
  const plate = cleanText(value, 24).toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/.test(plate)
    || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(plate);
}

function normalizedPlate(value) {
  return cleanText(value, 24).toUpperCase().replace(/[\s-]/g, '');
}

function parseRates(value) {
  if (value == null) return {};
  if (!validObjectBody(value)) return null;
  const rates = {};
  for (const [type, rateValue] of Object.entries(value)) {
    const rate = Number(rateValue);
    if (type.length > 30 || !Number.isFinite(rate) || rate < 1 || rate > 100000) return null;
    rates[type] = rate;
  }
  return rates;
}

function lotFromRequest(req, res) {
  const lotId = parseLotId(req.query.lotId ?? req.body?.lotId);
  if (!lotId) {
    apiError(res, 400, 'A valid parking lot is required.');
    return null;
  }
  const lot = getLot.get(lotId);
  if (!lot) {
    apiError(res, 404, 'Parking lot not found.');
    return null;
  }
  return lot;
}

function historyRows(lotId, query = {}) {
  const search = cleanText(query.q, 100);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '';
  const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit, 10) || 100));
  const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
  const where = ['lot_id=?'];
  const params = [lotId];
  if (search) {
    where.push('(vehicle_number LIKE ? OR owner_name LIKE ? OR vehicle_type LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (from) {
    where.push('exit_time >= ?');
    params.push(`${from}T00:00:00.000Z`);
  }
  if (to) {
    where.push('exit_time < ?');
    const next = new Date(`${to}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    params.push(next.toISOString());
  }
  const condition = where.join(' AND ');
  const rows = db.prepare(`
    SELECT id, vehicle_number AS number, owner_name AS owner, vehicle_type AS type, phone,
      slot_number AS slot, entry_time AS entryTime, exit_time AS exitTime,
      charged_hours AS hours, fee, rate_applied AS rate, lot_id AS lotId
    FROM parking_history WHERE ${condition} ORDER BY exit_time DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS count FROM parking_history WHERE ${condition}`).get(...params).count;
  return { rows, total, limit, offset };
}

app.get('/api/health', (_req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true, service: 'Parkwise API' });
});

app.get('/api/auth/status', (_req, res) => {
  const token = cookieValue(_req, 'parkwise_session');
  const user = token && db.prepare(`
    SELECT u.id, u.username, u.role FROM sessions s
    JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.active=1
  `).get(hashToken(token), nowIso());
  const setupRequired = db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
  res.json({
    setupRequired,
    setupKeyRequired: setupRequired && process.env.NODE_ENV === 'production',
    user: user || null
  });
});

app.post('/api/auth/setup', (req, res) => {
  if (!validObjectBody(req.body)) return apiError(res, 400, 'A JSON object is required.');
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) return apiError(res, 409, 'Administrator setup is already complete.');
  if (process.env.NODE_ENV === 'production') {
    const expectedKey = Buffer.from(process.env.PARKWISE_SETUP_KEY || '');
    const suppliedKey = Buffer.from(typeof req.body.setupKey === 'string' ? req.body.setupKey : '');
    if (!expectedKey.length || expectedKey.length !== suppliedKey.length || !crypto.timingSafeEqual(expectedKey, suppliedKey)) {
      return apiError(res, 403, 'A valid administrator setup key is required.');
    }
  }
  const username = cleanText(req.body.username, 40);
  const password = req.body.password;
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return apiError(res, 400, 'Username must be 3–40 letters, numbers, dots, underscores or hyphens.');
  if (!validatePassword(password)) return apiError(res, 400, 'Password must be between 12 and 200 characters.');
  const createAdmin = db.transaction(() => {
    const result = db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)')
      .run(username, hashPassword(password), 'admin', nowIso());
    return Number(result.lastInsertRowid);
  });
  const userId = createAdmin();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(hashToken(token), userId, new Date(Date.now() + SESSION_HOURS * 3600000).toISOString());
  setSessionCookie(res, token);
  res.status(201).json({ id: userId, username, role: 'admin' });
});

const loginAttempts = new Map();
app.post('/api/auth/login', (req, res) => {
  const username = cleanText(req.body?.username, 40);
  const key = `${req.ip}:${username.toLowerCase()}`;
  const attempts = loginAttempts.get(key) || { count: 0, since: Date.now() };
  if (Date.now() - attempts.since < 10 * 60 * 1000 && attempts.count >= 10) {
    return apiError(res, 429, 'Too many sign-in attempts. Please wait 10 minutes.');
  }
  const user = db.prepare('SELECT id, username, password_hash AS passwordHash, role FROM users WHERE username=? COLLATE NOCASE AND active=1').get(username);
  if (!user || typeof req.body?.password !== 'string' || !verifyPassword(req.body.password, user.passwordHash)) {
    attempts.count = Date.now() - attempts.since >= 10 * 60 * 1000 ? 1 : attempts.count + 1;
    attempts.since = attempts.count === 1 ? Date.now() : attempts.since;
    loginAttempts.set(key, attempts);
    return apiError(res, 401, 'Username or password is incorrect.');
  }
  loginAttempts.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(hashToken(token), user.id, new Date(Date.now() + SESSION_HOURS * 3600000).toISOString());
  setSessionCookie(res, token);
  res.json({ id: user.id, username: user.username, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  const token = cookieValue(req, 'parkwise_session');
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.get('host')) return apiError(res, 403, 'Cross-origin requests are not allowed.');
    } catch {
      return apiError(res, 403, 'Invalid request origin.');
    }
  }
  return authenticate(req, res, next);
});

app.get('/api/me', (req, res) => res.json(req.user));

app.get('/api/lots', (_req, res) => {
  res.json(db.prepare('SELECT id, name, address, capacity, hourly_rate AS rate, rates_json AS ratesJson FROM lots ORDER BY id')
    .all().map(serializeLot));
});

app.post('/api/lots', requireAdmin, (req, res) => {
  if (!validObjectBody(req.body)) return apiError(res, 400, 'A JSON object is required.');
  const name = cleanText(req.body.name, 80);
  const address = cleanText(req.body.address, 200);
  const capacity = Number(req.body.capacity);
  const rate = Number(req.body.rate);
  const rates = parseRates(req.body.rates);
  if (!name) return apiError(res, 400, 'Parking lot name is required.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > CAPACITY_LIMIT) return apiError(res, 400, 'Capacity must be between 1 and 200.');
  if (!Number.isFinite(rate) || rate < 1 || rate > 100000 || rates === null) return apiError(res, 400, 'Provide valid hourly rates between ₹1 and ₹100,000.');
  try {
    const result = db.prepare('INSERT INTO lots(name,address,capacity,hourly_rate,rates_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(name, address, capacity, rate, JSON.stringify(rates), nowIso());
    const lot = serializeLot(getLot.get(Number(result.lastInsertRowid)));
    audit(req, 'lot.created', { lotId: lot.id, name: lot.name });
    res.status(201).json(lot);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return apiError(res, 409, 'A parking lot with that name already exists.');
    throw error;
  }
});

app.put('/api/lots/:id', requireAdmin, (req, res) => {
  const lotId = parseLotId(req.params.id);
  const current = lotId && getLot.get(lotId);
  if (!current) return apiError(res, 404, 'Parking lot not found.');
  const name = cleanText(req.body?.name, 80);
  const address = cleanText(req.body?.address, 200);
  const capacity = Number(req.body?.capacity);
  const rate = Number(req.body?.rate);
  const rates = parseRates(req.body?.rates);
  if (!name) return apiError(res, 400, 'Parking lot name is required.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > CAPACITY_LIMIT) return apiError(res, 400, 'Capacity must be between 1 and 200.');
  if (capacity < db.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE lot_id=?').get(lotId).count) return apiError(res, 400, 'Capacity cannot be less than the number of vehicles parked in this lot.');
  if (!Number.isFinite(rate) || rate < 1 || rate > 100000 || rates === null) return apiError(res, 400, 'Provide valid hourly rates between ₹1 and ₹100,000.');
  try {
    db.prepare('UPDATE lots SET name=?,address=?,capacity=?,hourly_rate=?,rates_json=? WHERE id=?')
      .run(name, address, capacity, rate, JSON.stringify(rates), lotId);
    if (lotId === 1) db.prepare('UPDATE settings SET capacity=?,hourly_rate=? WHERE id=1').run(capacity, rate);
    const lot = serializeLot(getLot.get(lotId));
    audit(req, 'lot.updated', { lotId, name });
    res.json(lot);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return apiError(res, 409, 'A parking lot with that name already exists.');
    throw error;
  }
});

app.get('/api/dashboard', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const occupied = db.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE lot_id=?').get(lot.id).count;
  const revenue = db.prepare('SELECT COALESCE(SUM(fee),0) AS total, COUNT(*) AS count FROM parking_history WHERE lot_id=?').get(lot.id);
  const reservations = db.prepare(`SELECT COUNT(*) AS count FROM reservations WHERE lot_id=? AND status='reserved' AND starts_at<=? AND ends_at>?`)
    .get(lot.id, nowIso(), nowIso()).count;
  res.json({
    settings: serializeLot(lot),
    capacity: lot.capacity,
    occupied,
    available: lot.capacity - occupied,
    reserved: reservations,
    revenue: revenue.total,
    completedSessions: revenue.count,
    parkedVehicles: db.prepare('SELECT id,vehicle_number AS number,owner_name AS owner,vehicle_type AS type,slot_number AS slot,entry_time AS entryTime FROM vehicles WHERE lot_id=? ORDER BY entry_time DESC LIMIT 8').all(lot.id)
  });
});

app.get('/api/settings', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (lot) res.json(serializeLot(lot));
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const capacity = Number(req.body?.capacity);
  const rate = Number(req.body?.rate);
  const rates = parseRates(req.body?.rates ?? {});
  const name = cleanText(req.body?.name ?? lot.name, 80);
  const address = cleanText(req.body?.address ?? lot.address, 200);
  const occupied = db.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE lot_id=?').get(lot.id).count;
  if (!name) return apiError(res, 400, 'Parking lot name is required.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > CAPACITY_LIMIT) return apiError(res, 400, 'Capacity must be an integer from 1 to 200.');
  if (capacity < occupied) return apiError(res, 400, 'Capacity cannot be less than the number of vehicles currently parked.');
  if (!Number.isFinite(rate) || rate < 1 || rate > 100000 || rates === null) return apiError(res, 400, 'Rates must be between ₹1 and ₹100,000.');
  db.prepare('UPDATE lots SET name=?,address=?,capacity=?,hourly_rate=?,rates_json=? WHERE id=?')
    .run(name, address, capacity, rate, JSON.stringify(rates), lot.id);
  if (lot.id === 1) db.prepare('UPDATE settings SET capacity=?,hourly_rate=? WHERE id=1').run(capacity, rate);
  audit(req, 'lot.settings_updated', { lotId: lot.id, capacity, rate, rates });
  res.json(serializeLot(getLot.get(lot.id)));
});

app.delete('/api/admin/data', requireAdmin, (req, res) => {
  if (!validObjectBody(req.body) || req.body.confirmation !== 'CLEAR ALL DATA') {
    return apiError(res, 400, 'Type CLEAR ALL DATA to confirm the reset.');
  }

  const resetData = db.transaction(() => {
    const counts = {
      vehicles: db.prepare('SELECT COUNT(*) AS count FROM vehicles').get().count,
      history: db.prepare('SELECT COUNT(*) AS count FROM parking_history').get().count,
      reservations: db.prepare('SELECT COUNT(*) AS count FROM reservations').get().count,
      locations: db.prepare('SELECT COUNT(*) AS count FROM lots').get().count
    };

    db.prepare('DELETE FROM vehicles').run();
    db.prepare('DELETE FROM parking_history').run();
    db.prepare('DELETE FROM reservations').run();
    db.prepare('DELETE FROM lots').run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('vehicles','parking_history','reservations','lots')`).run();

    const createdAt = nowIso();
    db.prepare(`
      INSERT INTO lots(id,name,address,capacity,hourly_rate,rates_json,created_at)
      VALUES(1,'Main Parking','',200,30,'{}',?)
    `).run(createdAt);
    db.prepare('UPDATE settings SET capacity=200,hourly_rate=30 WHERE id=1').run();

    audit(req, 'data.cleared', { ...counts, preserved: ['users', 'sessions', 'audit_log'] });
    return counts;
  });

  res.json({ ok: true, cleared: resetData(), defaultLotId: 1 });
});

app.get('/api/vehicles', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (lot) res.json(db.prepare(`
    SELECT id, vehicle_number AS number, owner_name AS owner, vehicle_type AS type, phone,
      slot_number AS slot, entry_time AS entryTime, lot_id AS lotId
    FROM vehicles WHERE lot_id=? ORDER BY entry_time DESC
  `).all(lot.id));
});

app.get('/api/tickets/:number/qr', async (req, res, next) => {
  const number = normalizedPlate(req.params.number);
  if (!validPlate(number)) return apiError(res, 400, 'QR tickets require a valid Indian vehicle registration number.');
  try {
    const image = await QRCode.toBuffer(number, {
      errorCorrectionLevel: 'M',
      margin: 2,
      type: 'png',
      width: 240
    });
    res.type('png').set('Cache-Control', 'no-store').send(image);
  } catch (error) {
    next(error);
  }
});

app.get('/api/vehicles/:number', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const vehicle = db.prepare(`
    SELECT id,vehicle_number AS number,owner_name AS owner,vehicle_type AS type,phone,
      slot_number AS slot,entry_time AS entryTime,lot_id AS lotId FROM vehicles
    WHERE vehicle_number=? COLLATE NOCASE AND lot_id=?
  `).get(normalizedPlate(req.params.number), lot.id);
  if (!vehicle) return apiError(res, 404, 'Vehicle is not currently parked in this lot.');
  res.json(vehicle);
});

app.post('/api/vehicles', (req, res) => {
  if (!validObjectBody(req.body)) return apiError(res, 400, 'A JSON object is required.');
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  for (const [field, max] of [['number', 24], ['owner', 80], ['type', 30], ['phone', 20]]) {
    if (req.body[field] != null && String(req.body[field]).length > max) return apiError(res, 400, `${field} must be ${max} characters or fewer.`);
  }
  const number = normalizedPlate(req.body.number);
  const owner = cleanText(req.body.owner, 80);
  const type = cleanText(req.body.type, 30);
  const phone = cleanText(req.body.phone, 20);
  if (!number || !owner || !type) return apiError(res, 400, 'Vehicle number, owner name, and vehicle type are required.');
  if (db.prepare('SELECT 1 FROM vehicles WHERE vehicle_number=? COLLATE NOCASE AND lot_id=?').get(number, lot.id)) return apiError(res, 409, 'This vehicle is already parked in this lot.');
  const occupied = db.prepare('SELECT slot_number FROM vehicles WHERE lot_id=?').all(lot.id);
  const usedSlots = new Set(occupied.map(row => row.slot_number));
  const slot = req.body.slot == null || req.body.slot === '' ? Array.from({ length: lot.capacity }, (_, i) => i + 1).find(value => !usedSlots.has(value)) : Number(req.body.slot);
  if (!Number.isInteger(slot) || slot < 1 || slot > lot.capacity) return apiError(res, 400, `Space must be an integer from 1 to ${lot.capacity}.`);
  if (usedSlots.has(slot)) return apiError(res, 409, 'That parking space is already occupied.');
  const activeReservations = db.prepare(`
    SELECT 1 FROM reservations WHERE lot_id=? AND vehicle_number=? COLLATE NOCASE
      AND status='reserved' AND starts_at<=? AND ends_at>?
  `).get(lot.id, number, nowIso(), nowIso());
  const entryTime = nowIso();
  try {
    const result = db.prepare(`
      INSERT INTO vehicles(vehicle_number,owner_name,vehicle_type,phone,slot_number,entry_time,lot_id)
      VALUES(?,?,?,?,?,?,?)
    `).run(number, owner, type, phone, slot, entryTime, lot.id);
    if (activeReservations) {
      db.prepare(`UPDATE reservations SET status='checked_in'
        WHERE lot_id=? AND vehicle_number=? COLLATE NOCASE AND status='reserved'
          AND starts_at<=? AND ends_at>?`)
        .run(lot.id, number, entryTime, entryTime);
    }
    audit(req, 'vehicle.checked_in', { lotId: lot.id, number, slot });
    res.status(201).json({ id: Number(result.lastInsertRowid), number, owner, type, phone, slot, entryTime, lotId: lot.id });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return apiError(res, 409, 'The vehicle or parking space is already assigned.');
    throw error;
  }
});

app.post('/api/vehicles/:number/exit', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const vehicle = db.prepare(`
    SELECT id,vehicle_number AS number,owner_name AS owner,vehicle_type AS type,phone,
      slot_number AS slot,entry_time AS entryTime,lot_id AS lotId
    FROM vehicles WHERE vehicle_number=? COLLATE NOCASE AND lot_id=?
  `).get(normalizedPlate(req.params.number), lot.id);
  if (!vehicle) return apiError(res, 404, 'Vehicle not found in active parking.');
  const exitTime = new Date();
  const hours = Math.max(1, Math.ceil((exitTime.getTime() - new Date(vehicle.entryTime).getTime()) / 3600000));
  let rates = {};
  try {
    rates = JSON.parse(lot.ratesJson);
  } catch (error) {
    console.error('Could not parse lot rates:', error);
  }
  const rate = Number(rates[vehicle.type] ?? lot.rate);
  const fee = Number((hours * rate).toFixed(2));
  db.transaction(() => {
    db.prepare(`
      INSERT INTO parking_history(vehicle_number,owner_name,vehicle_type,phone,slot_number,entry_time,exit_time,charged_hours,fee,lot_id,rate_applied)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(vehicle.number, vehicle.owner, vehicle.type, vehicle.phone, vehicle.slot, vehicle.entryTime, exitTime.toISOString(), hours, fee, lot.id, rate);
    db.prepare('DELETE FROM vehicles WHERE id=?').run(vehicle.id);
    audit(req, 'vehicle.checked_out', { lotId: lot.id, number: vehicle.number, slot: vehicle.slot, hours, fee });
  })();
  res.json({ ...vehicle, exitTime: exitTime.toISOString(), hours, rate, fee });
});

app.get('/api/history', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const result = historyRows(lot.id, req.query);
  res.json({ ...result, rows: result.rows });
});

app.get('/api/history/suggestions', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  res.json(db.prepare(`
    SELECT h.vehicle_number AS number,h.owner_name AS owner,h.vehicle_type AS type,h.phone
    FROM parking_history h JOIN (
      SELECT vehicle_number,MAX(id) AS latest_id FROM parking_history WHERE lot_id=? GROUP BY vehicle_number
    ) latest ON latest.latest_id=h.id ORDER BY h.exit_time DESC
  `).all(lot.id));
});

app.get('/api/reports', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const sessions = historyRows(lot.id, { ...req.query, limit: 500, offset: 0 }).rows;
  const daily = db.prepare(`
    SELECT substr(exit_time,1,10) AS day,COUNT(*) AS sessions,ROUND(SUM(fee),2) AS revenue
    FROM parking_history WHERE lot_id=? GROUP BY day ORDER BY day DESC LIMIT 30
  `).all(lot.id);
  const revenue = sessions.reduce((sum, row) => sum + row.fee, 0);
  const count = sessions.length;
  const averageStayMinutes = count
    ? sessions.reduce((sum, row) => sum + (new Date(row.exitTime) - new Date(row.entryTime)) / 60000, 0) / count
    : 0;
  const peakOccupancy = sessions.reduce((peak, arrival) => Math.max(
    peak,
    sessions.filter(session => new Date(session.entryTime) <= new Date(arrival.entryTime)
      && new Date(session.exitTime) > new Date(arrival.entryTime)).length
  ), 0);
  res.json({
    revenue,
    completedSessions: count,
    averageFee: count ? revenue / count : 0,
    averageStayMinutes,
    peakOccupancy,
    currentlyParked: db.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE lot_id=?').get(lot.id).count,
    daily,
    history: sessions
  });
});

app.get('/api/reservations', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const currentTime = nowIso();
  const expired = db.prepare(`
    SELECT id,vehicle_number AS number FROM reservations
    WHERE lot_id=? AND status='reserved' AND ends_at<=?
  `).all(lot.id, currentTime);
  if (expired.length) {
    db.prepare(`UPDATE reservations SET status='no_show'
      WHERE lot_id=? AND status='reserved' AND ends_at<=?`).run(lot.id, currentTime);
    for (const reservation of expired) {
      audit(req, 'reservation.no_show', { lotId: lot.id, reservationId: reservation.id, number: reservation.number });
    }
  }
  res.json(db.prepare(`
    SELECT id,vehicle_number AS number,owner_name AS owner,vehicle_type AS type,phone,
      starts_at AS startsAt,ends_at AS endsAt,status,created_at AS createdAt
    FROM reservations WHERE lot_id=? ORDER BY starts_at DESC LIMIT 500
  `).all(lot.id));
});

app.post('/api/reservations', (req, res) => {
  if (!validObjectBody(req.body)) return apiError(res, 400, 'A JSON object is required.');
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const number = normalizedPlate(req.body.number);
  const owner = cleanText(req.body.owner, 80);
  const type = cleanText(req.body.type, 30);
  const phone = cleanText(req.body.phone, 20);
  const startsAt = new Date(req.body.startsAt);
  const endsAt = new Date(req.body.endsAt);
  if (!number || !owner || !type) return apiError(res, 400, 'Vehicle number, owner and vehicle type are required.');
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt <= new Date() || endsAt <= startsAt) return apiError(res, 400, 'Choose a future arrival time and a later end time.');
  if (endsAt - startsAt > 30 * 86400000) return apiError(res, 400, 'Reservations cannot exceed 30 days.');
  const overlap = db.prepare(`
    SELECT 1 FROM reservations WHERE lot_id=? AND vehicle_number=? COLLATE NOCASE AND status='reserved'
      AND starts_at < ? AND ends_at > ?
  `).get(lot.id, number, endsAt.toISOString(), startsAt.toISOString());
  if (overlap) return apiError(res, 409, 'This vehicle already has an overlapping reservation.');
  const activeVehicle = db.prepare('SELECT 1 FROM vehicles WHERE lot_id=? AND vehicle_number=? COLLATE NOCASE').get(lot.id, number);
  if (activeVehicle) return apiError(res, 409, 'This vehicle is already parked in this lot.');
  const overlappingReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations WHERE lot_id=? AND status='reserved'
      AND starts_at < ? AND ends_at > ?
  `).get(lot.id, endsAt.toISOString(), startsAt.toISOString()).count;
  const currentlyParked = db.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE lot_id=?').get(lot.id).count;
  if (currentlyParked + overlappingReservations >= lot.capacity) {
    return apiError(res, 409, 'There are not enough guaranteed spaces for that reservation time.');
  }
  const result = db.prepare(`
    INSERT INTO reservations(lot_id,vehicle_number,owner_name,vehicle_type,phone,starts_at,ends_at,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(lot.id, number, owner, type, phone, startsAt.toISOString(), endsAt.toISOString(), nowIso());
  const reservation = db.prepare('SELECT id,vehicle_number AS number,owner_name AS owner,vehicle_type AS type,phone,starts_at AS startsAt,ends_at AS endsAt,status FROM reservations WHERE id=?').get(Number(result.lastInsertRowid));
  audit(req, 'reservation.created', { lotId: lot.id, reservationId: reservation.id, number });
  res.status(201).json(reservation);
});

app.post('/api/reservations/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const reservation = db.prepare('SELECT id,lot_id AS lotId,status FROM reservations WHERE id=? AND lot_id=?').get(id, lot.id);
  if (!reservation) return apiError(res, 404, 'Reservation not found.');
  if (reservation.status !== 'reserved') return apiError(res, 409, 'Only active reservations can be cancelled.');
  db.prepare(`UPDATE reservations SET status='cancelled' WHERE id=?`).run(id);
  audit(req, 'reservation.cancelled', { reservationId: id, lotId: reservation.lotId });
  res.json({ ok: true });
});

app.post('/api/reservations/:id/check-in', (req, res) => {
  if (!validObjectBody(req.body)) return apiError(res, 400, 'A JSON object is required.');
  const id = Number(req.params.id);
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  if (!Number.isSafeInteger(id) || id < 1) return apiError(res, 400, 'Invalid reservation ID.');

  const checkIn = db.transaction(() => {
    const reservation = db.prepare(`
      SELECT id,vehicle_number AS number,owner_name AS owner,vehicle_type AS type,phone,
        starts_at AS startsAt,ends_at AS endsAt,status
      FROM reservations WHERE id=? AND lot_id=?
    `).get(id, lot.id);
    if (!reservation) return { status: 404, error: 'Reservation not found.' };
    if (reservation.status !== 'reserved') return { status: 409, error: 'Only active reservations can be checked in.' };

    const entryTime = nowIso();
    if (reservation.endsAt <= entryTime) {
      db.prepare(`UPDATE reservations SET status='no_show' WHERE id=? AND status='reserved'`).run(id);
      audit(req, 'reservation.no_show', { lotId: lot.id, reservationId: id, number: reservation.number });
      return { status: 409, error: 'This reservation has expired and was marked as a no-show.' };
    }
    if (reservation.startsAt > entryTime) {
      return { status: 409, error: 'This reservation is not yet within its check-in window.' };
    }

    if (db.prepare('SELECT 1 FROM vehicles WHERE lot_id=? AND vehicle_number=? COLLATE NOCASE')
      .get(lot.id, reservation.number)) {
      return { status: 409, error: 'This vehicle is already parked in this location.' };
    }
    const usedSlots = new Set(db.prepare('SELECT slot_number AS slot FROM vehicles WHERE lot_id=?')
      .all(lot.id).map(vehicle => vehicle.slot));
    const requestedSlot = req.body.slot === '' || req.body.slot == null ? null : Number(req.body.slot);
    const slot = requestedSlot ?? Array.from({ length: lot.capacity }, (_, index) => index + 1)
      .find(candidate => !usedSlots.has(candidate));
    if (!Number.isInteger(slot) || slot < 1 || slot > lot.capacity) {
      return { status: 409, error: 'No available parking spaces remain for this reservation.' };
    }
    if (usedSlots.has(slot)) return { status: 409, error: 'That parking space is already occupied.' };

    const result = db.prepare(`
      INSERT INTO vehicles(vehicle_number,owner_name,vehicle_type,phone,slot_number,entry_time,lot_id)
      VALUES(?,?,?,?,?,?,?)
    `).run(reservation.number, reservation.owner, reservation.type, reservation.phone, slot, entryTime, lot.id);
    db.prepare(`UPDATE reservations SET status='checked_in'
      WHERE id=? AND status='reserved'`).run(id);
    audit(req, 'reservation.checked_in', { lotId: lot.id, reservationId: id, number: reservation.number, slot });
    return {
      status: 201,
      vehicle: {
        id: Number(result.lastInsertRowid),
        number: reservation.number,
        owner: reservation.owner,
        type: reservation.type,
        phone: reservation.phone,
        slot,
        entryTime,
        lotId: lot.id
      }
    };
  });

  try {
    const result = checkIn();
    if (result.error) return apiError(res, result.status, result.error);
    res.status(result.status).json(result.vehicle);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return apiError(res, 409, 'The vehicle or parking space is already assigned.');
    throw error;
  }
});

app.get('/api/users', requireAdmin, (_req, res) => {
  res.json(db.prepare('SELECT id,username,role,active,created_at AS createdAt FROM users ORDER BY id').all());
});

app.post('/api/users', requireAdmin, (req, res) => {
  const username = cleanText(req.body?.username, 40);
  const password = req.body?.password;
  const role = req.body?.role;
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return apiError(res, 400, 'Username must be 3–40 letters, numbers, dots, underscores or hyphens.');
  if (!validatePassword(password)) return apiError(res, 400, 'Password must be between 12 and 200 characters.');
  if (!['admin', 'operator'].includes(role)) return apiError(res, 400, 'Role must be admin or operator.');
  try {
    const result = db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)')
      .run(username, hashPassword(password), role, nowIso());
    audit(req, 'user.created', { userId: Number(result.lastInsertRowid), username, role });
    res.status(201).json({ id: Number(result.lastInsertRowid), username, role });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return apiError(res, 409, 'That username is already taken.');
    throw error;
  }
});

app.get('/api/audit', requireAdmin, (req, res) => {
  const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  res.json(db.prepare(`
    SELECT id,username,action,details,created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT ?
  `).all(limit).map(row => ({ ...row, details: JSON.parse(row.details) })));
});

app.get('/api/export/history.csv', (req, res) => {
  const lot = lotFromRequest(req, res);
  if (!lot) return;
  const rows = historyRows(lot.id, { ...req.query, limit: 2147483647, offset: 0 }).rows;
  const quote = value => {
    const text = String(value ?? '');
    const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const lines = [
    ['Vehicle Number','Owner','Type','Phone','Lot','Slot','Entry Time','Exit Time','Hours','Rate (INR)','Fee (INR)'],
    ...rows.map(row => [row.number,row.owner,row.type,row.phone,lot.name,row.slot,row.entryTime,row.exitTime,row.hours,row.rate,row.fee])
  ];
  res.type('text/csv').attachment('parkwise-history.csv').send('\uFEFF' + lines.map(row => row.map(quote).join(',')).join('\r\n'));
});

app.get('/api/admin/backup', requireAdmin, async (req, res, next) => {
  const file = path.join(os.tmpdir(), `parkwise-backup-${crypto.randomUUID()}.sqlite`);
  try {
    await db.backup(file);
    audit(req, 'database.backup_downloaded');
    res.download(file, `parkwise-backup-${new Date().toISOString().slice(0, 10)}.sqlite`, error => {
      fs.rm(file, { force: true }, cleanupError => {
        if (cleanupError) console.error('Unable to remove temporary backup:', cleanupError);
      });
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    fs.rm(file, { force: true }, cleanupError => {
      if (cleanupError) console.error('Unable to remove temporary backup:', cleanupError);
    });
    next(error);
  }
});

app.use('/api', (_req, res) => apiError(res, 404, 'API endpoint not found.'));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error.type === 'entity.too.large') return apiError(res, 413, 'Request body is too large.');
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return apiError(res, 400, 'Request body must contain valid JSON.');
  console.error('Unexpected request error:', error);
  apiError(res, 500, 'An unexpected server error occurred.');
});

app.listen(PORT, () => console.log(`Parkwise running at http://localhost:${PORT}`));

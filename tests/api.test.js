const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const Database = require('better-sqlite3');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'parkwise-api-'));
const databasePath = path.join(temporaryDirectory, 'parkwise.sqlite');
const serverPath = path.join(__dirname, '..', 'server.js');
const setupKey = 'AutomatedTestOnly-Setup-Key-37';
let serverProcess;
let baseUrl;
let sessionCookie = '';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function apiRequest(route, { method = 'GET', body, origin } = {}) {
  const headers = {};
  if (sessionCookie) headers.cookie = sessionCookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) sessionCookie = setCookie.split(';', 1)[0];
  const text = await response.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { response, data };
}

before(async () => {
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), capacity INTEGER NOT NULL, hourly_rate REAL NOT NULL);
    INSERT INTO settings VALUES(1, 20, 45);
    CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
      owner_name TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      phone TEXT DEFAULT '',
      slot_number INTEGER NOT NULL UNIQUE,
      entry_time TEXT NOT NULL
    );
    INSERT INTO vehicles(vehicle_number,owner_name,vehicle_type,phone,slot_number,entry_time)
      VALUES('MH12AB1234','Legacy Owner','Car','','3','${new Date(Date.now() - 600000).toISOString()}');
    CREATE TABLE parking_history (
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
  `);
  database.close();

  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      PARKWISE_DB_PATH: databasePath,
      PARKWISE_SETUP_KEY: setupKey
    },
    stdio: 'ignore'
  });

  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server exited with code ${serverProcess.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start: ${lastError?.message || 'timeout'}`);
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise(resolve => {
      serverProcess.once('exit', resolve);
      setTimeout(resolve, 3000).unref();
    });
  }
  for (const file of ['parkwise.sqlite', 'parkwise.sqlite-shm', 'parkwise.sqlite-wal']) {
    fs.rmSync(path.join(temporaryDirectory, file), { force: true });
  }
  fs.rmdirSync(temporaryDirectory);
});

test('migrates existing data and supports secured parking workflows', async t => {
  await t.test('preserves legacy records and requires account setup', async () => {
    const status = await apiRequest('/api/auth/status');
    assert.equal(status.data.setupRequired, true);
    assert.equal(status.data.setupKeyRequired, true);
    const unauthorized = await apiRequest('/api/vehicles');
    assert.equal(unauthorized.response.status, 401);

    const missingSetupKey = await apiRequest('/api/auth/setup', {
      method: 'POST',
      body: { username: 'testadmin', password: 'TestAdminPassphrase!2026' }
    });
    assert.equal(missingSetupKey.response.status, 403);

    const invalidSetupKey = await apiRequest('/api/auth/setup', {
      method: 'POST',
      body: { username: 'testadmin', password: 'TestAdminPassphrase!2026', setupKey: 'incorrect' }
    });
    assert.equal(invalidSetupKey.response.status, 403);

    const setup = await apiRequest('/api/auth/setup', {
      method: 'POST',
      body: { username: 'testadmin', password: 'TestAdminPassphrase!2026', setupKey }
    });
    assert.equal(setup.response.status, 201);

    const lots = await apiRequest('/api/lots');
    assert.equal(lots.data[0].capacity, 20);
    assert.equal(lots.data[0].rate, 45);
    const vehicles = await apiRequest('/api/vehicles?lotId=1');
    assert.equal(vehicles.data.length, 1);
    assert.equal(vehicles.data[0].number, 'MH12AB1234');
    assert.equal(vehicles.data[0].slot, 3);

    const ticketQr = await apiRequest('/api/tickets/MH12AB1234/qr');
    assert.equal(ticketQr.response.status, 200);
    assert.match(ticketQr.response.headers.get('content-type'), /image\/png/);
    const invalidTicketQr = await apiRequest('/api/tickets/not-a-plate/qr');
    assert.equal(invalidTicketQr.response.status, 400);
  });

  await t.test('supports locations, type pricing, and manual space assignment', async () => {
    const createdLot = await apiRequest('/api/lots', {
      method: 'POST',
      body: { name: 'Test Annex', address: 'North wing', capacity: 3, rate: 30, rates: { Bike: 12 } }
    });
    assert.equal(createdLot.response.status, 201);
    const lotId = createdLot.data.id;

    const entry = await apiRequest('/api/vehicles', {
      method: 'POST',
      body: { lotId, number: 'MH01AB1001', owner: 'Test Rider', type: 'Bike', slot: 2 }
    });
    assert.equal(entry.response.status, 201);
    assert.equal(entry.data.slot, 2);

    const takenSpace = await apiRequest('/api/vehicles', {
      method: 'POST',
      body: { lotId, number: 'MH01AB1002', owner: 'Another Rider', type: 'Bike', slot: 2 }
    });
    assert.equal(takenSpace.response.status, 409);

    const checkout = await apiRequest(`/api/vehicles/MH01AB1001/exit?lotId=${lotId}`, {
      method: 'POST',
      body: {}
    });
    assert.equal(checkout.response.status, 200);
    assert.equal(checkout.data.rate, 12);
    assert.equal(checkout.data.fee, 12);

    const history = await apiRequest(`/api/history?lotId=${lotId}`);
    assert.equal(history.data.total, 1);
    assert.equal(history.data.rows[0].rate, 12);

    const csv = await apiRequest(`/api/export/history.csv?lotId=${lotId}`);
    assert.equal(csv.response.status, 200);
    assert.match(csv.response.headers.get('content-type'), /text\/csv/);
    assert.match(csv.data, /MH01AB1001/);
    assert.match(csv.data, /"12","12"$/);
  });

  await t.test('reserves capacity and reports completed sessions', async () => {
    const lotId = (await apiRequest('/api/lots')).data.find(lot => lot.name === 'Test Annex').id;
    const startsAt = new Date(Date.now() + 1000).toISOString();
    const endsAt = new Date(Date.now() + 3600000).toISOString();
    const created = await apiRequest('/api/reservations', {
      method: 'POST',
      body: { lotId, number: 'MH03AB9999', owner: 'Reservation Owner', type: 'Car', startsAt, endsAt }
    });
    assert.equal(created.response.status, 201);
    const duplicate = await apiRequest('/api/reservations', {
      method: 'POST',
      body: { lotId, number: 'MH03AB9999', owner: 'Reservation Owner', type: 'Car', startsAt, endsAt }
    });
    assert.equal(duplicate.response.status, 409);
    const tooEarly = await apiRequest(`/api/reservations/${created.data.id}/check-in?lotId=${lotId}`, {
      method: 'POST',
      body: {}
    });
    assert.equal(tooEarly.response.status, 409);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const checkedIn = await apiRequest(`/api/reservations/${created.data.id}/check-in?lotId=${lotId}`, {
      method: 'POST',
      body: {}
    });
    assert.equal(checkedIn.response.status, 201);
    assert.equal(checkedIn.data.number, 'MH03AB9999');
    const checkedInReservation = (await apiRequest(`/api/reservations?lotId=${lotId}`))
      .data.find(reservation => reservation.id === created.data.id);
    assert.equal(checkedInReservation.status, 'checked_in');
    const checkout = await apiRequest(`/api/vehicles/${checkedIn.data.number}/exit?lotId=${lotId}`, {
      method: 'POST',
      body: {}
    });
    assert.equal(checkout.response.status, 200);

    const expiresAt = new Date(Date.now() + 500).toISOString();
    const noShow = await apiRequest('/api/reservations', {
      method: 'POST',
      body: {
        lotId,
        number: 'MH04AB9999',
        owner: 'No Show Owner',
        type: 'Car',
        startsAt: new Date(Date.now() + 100).toISOString(),
        endsAt: expiresAt
      }
    });
    assert.equal(noShow.response.status, 201);
    await new Promise(resolve => setTimeout(resolve, 600));
    const noShowReservation = (await apiRequest(`/api/reservations?lotId=${lotId}`))
      .data.find(reservation => reservation.id === noShow.data.id);
    assert.equal(noShowReservation.status, 'no_show');

    const cancelledReservation = await apiRequest('/api/reservations', {
      method: 'POST',
      body: {
        lotId,
        number: 'MH05AB9999',
        owner: 'Cancelled Owner',
        type: 'Car',
        startsAt: new Date(Date.now() + 3600000).toISOString(),
        endsAt: new Date(Date.now() + 7200000).toISOString()
      }
    });
    assert.equal(cancelledReservation.response.status, 201);
    const cancelled = await apiRequest(`/api/reservations/${cancelledReservation.data.id}/cancel?lotId=${lotId}`, {
      method: 'POST',
      body: {}
    });
    assert.equal(cancelled.response.status, 200);

    const report = await apiRequest(`/api/reports?lotId=${lotId}`);
    assert.equal(report.data.completedSessions, 2);
    assert.equal(report.data.revenue, 42);
    assert.equal(report.data.peakOccupancy, 1);
  });

  await t.test('enforces roles and exports auditable backups', async () => {
    const user = await apiRequest('/api/users', {
      method: 'POST',
      body: { username: 'operator', password: 'OperatorPassphrase!2026', role: 'operator' }
    });
    assert.equal(user.response.status, 201);

    const backup = await apiRequest('/api/admin/backup');
    assert.equal(backup.response.status, 200);
    assert.match(backup.response.headers.get('content-type'), /application\/octet-stream/);
    const audit = await apiRequest('/api/audit');
    assert.ok(audit.data.some(row => row.action === 'vehicle.checked_out'));

    const invalidReset = await apiRequest('/api/admin/data', {
      method: 'DELETE',
      body: { confirmation: 'CLEAR' }
    });
    assert.equal(invalidReset.response.status, 400);
    assert.ok((await apiRequest('/api/lots')).data.length > 1);

    const reset = await apiRequest('/api/admin/data', {
      method: 'DELETE',
      body: { confirmation: 'CLEAR ALL DATA' }
    });
    assert.equal(reset.response.status, 200);
    assert.ok(reset.data.cleared.vehicles > 0);
    assert.ok(reset.data.cleared.history > 0);
    assert.ok(reset.data.cleared.reservations > 0);
    assert.ok(reset.data.cleared.locations > 1);
    assert.equal(reset.data.defaultLotId, 1);
    assert.deepEqual(await apiRequest('/api/vehicles?lotId=1').then(result => result.data), []);
    assert.equal((await apiRequest('/api/history?lotId=1')).data.total, 0);
    assert.deepEqual((await apiRequest('/api/reservations?lotId=1')).data, []);
    assert.deepEqual((await apiRequest('/api/lots')).data.map(lot => ({
      id: lot.id, name: lot.name, capacity: lot.capacity, rate: lot.rate, rates: lot.rates
    })), [{ id: 1, name: 'Main Parking', capacity: 200, rate: 30, rates: {} }]);
    assert.equal((await apiRequest('/api/users')).data.length, 2);
    assert.ok((await apiRequest('/api/audit')).data.some(row => row.action === 'data.cleared'));

    const retainedEntry = await apiRequest('/api/vehicles', {
      method: 'POST',
      body: { lotId: 1, number: 'MH12AB4321', owner: 'Retained Admin Check', type: 'Car' }
    });
    assert.equal(retainedEntry.response.status, 201);

    await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
    sessionCookie = '';
    const login = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { username: 'operator', password: 'OperatorPassphrase!2026' }
    });
    assert.equal(login.response.status, 200);
    const forbidden = await apiRequest('/api/admin/data', {
      method: 'DELETE',
      body: { confirmation: 'CLEAR ALL DATA' }
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal((await apiRequest('/api/vehicles?lotId=1')).data.length, 1);
  });
});

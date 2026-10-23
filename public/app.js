(() => {
  const $ = id => document.getElementById(id);
  let settings = { capacity: 200, rate: 30 };
  let parked = [];
  let history = [];
  let reservations = [];
  let currentUser = null;
  let lots = [];
  let currentLotId = Number(localStorage.getItem('parkwise-lot-id')) || 1;
  let selectedSlot = null;
  let cameraStream = null;
  let scanTimer = null;
  let ocrWorker = null;
  let scannerBusy = false;
  let scannerMode = null;
  let scannerTarget = 'entry';
  let refreshInProgress = false;
  let historyOffset = 0;
  let historyTotal = 0;
  const historyPageSize = 100;

  const money = value => `₹${Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? 'Unknown'
      : parsed.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  async function api(url, options = {}) {
    const { headers = {}, ...requestOptions } = options;
    const response = await fetch(url, {
      ...requestOptions,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers }
    });
    let data;
    try {
      const body = await response.text();
      data = body ? JSON.parse(body) : null;
    } catch {
      throw new Error(`The server returned invalid JSON (${response.status}).`);
    }
    if (!response.ok) {
      const message = data && typeof data === 'object' && typeof data.error === 'string'
        ? data.error
        : `Request failed (${response.status})`;
      throw new Error(message);
    }
    if (data === null || typeof data !== 'object') {
      throw new Error('The server returned an empty or invalid response.');
    }
    return data;
  }

  function notify(message, error = false) {
    const element = $('notice');
    element.textContent = message;
    element.className = error ? 'error' : '';
    element.style.display = 'block';
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => { element.style.display = 'none'; }, 5000);
  }

  function setBackendStatus(connected) {
    const status = $('backend-status');
    status.textContent = connected ? '● Backend connected' : '● Backend unavailable';
    status.classList.toggle('offline', !connected);
  }

  function setTab(tab) {
    const tabButton = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (!tabButton || tabButton.hidden) return;
    document.querySelectorAll('.tab').forEach(button => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    document.querySelectorAll('.view').forEach(view => {
      view.classList.toggle('active', view.id === `view-${tab}`);
    });
  }

  function filterRows(inputId, bodyId) {
    const query = $(inputId).value.trim().toLowerCase();
    document.querySelectorAll(`#${bodyId} tr`).forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(query) ? '' : 'none';
    });
    if (bodyId === 'parked-body') {
      document.querySelectorAll('.parking-space').forEach(space => {
        const vehicle = parked.find(item => item.slot === Number(space.dataset.slot));
        space.hidden = Boolean(query) && (!vehicle || !`${vehicle.number} ${vehicle.owner}`.toLowerCase().includes(query));
      });
    }
  }

  function lotQuery() {
    return `lotId=${encodeURIComponent(currentLotId)}`;
  }

  function showAuth(setupRequired, setupKeyRequired = false) {
    $('auth-screen').hidden = false;
    $('app-main').hidden = true;
    $('account-controls').hidden = true;
    $('confirm-password-wrap').hidden = !setupRequired;
    $('setup-key-wrap').hidden = !setupRequired || !setupKeyRequired;
    $('setup-key').required = setupRequired && setupKeyRequired;
    $('auth-heading').textContent = setupRequired ? 'Create your administrator account' : 'Sign in';
    $('auth-description').textContent = setupRequired
      ? 'Set up Parkwise before using the parking system. Choose a strong password and keep it private.'
      : 'Sign in to manage parking operations.';
    $('auth-submit').textContent = setupRequired ? 'Create administrator' : 'Sign in';
    $('auth-password').autocomplete = setupRequired ? 'new-password' : 'current-password';
    $('auth-notice').textContent = '';
    $('auth-form').dataset.setup = String(setupRequired);
    $('auth-form').dataset.setupKeyRequired = String(setupKeyRequired);
    document.body.classList.remove('authenticated');
  }

  async function loadLots() {
    lots = await api('/api/lots');
    if (!lots.length) throw new Error('No parking locations are configured.');
    if (!lots.some(lot => lot.id === currentLotId)) currentLotId = lots[0].id;
    $('lot-select').innerHTML = lots.map(lot =>
      `<option value="${lot.id}">${esc(lot.name)}</option>`
    ).join('');
    $('lot-select').value = String(currentLotId);
    localStorage.setItem('parkwise-lot-id', String(currentLotId));
  }

  async function enterApplication(user) {
    currentUser = user;
    $('auth-screen').hidden = true;
    $('app-main').hidden = false;
    $('account-controls').hidden = false;
    $('signed-in-user').textContent = `${user.username} · ${user.role}`;
    document.body.classList.add('authenticated');
    document.querySelectorAll('.admin-only').forEach(element => {
      element.hidden = user.role !== 'admin';
    });
    $('clear-data-confirmation').value = '';
    await loadLots();
    await refresh();
  }

  async function checkAuthentication() {
    const status = await api('/api/auth/status');
    setBackendStatus(true);
    if (status.user) return enterApplication(status.user);
    showAuth(status.setupRequired, status.setupKeyRequired);
  }

  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const setup = form.dataset.setup === 'true';
    const notice = $('auth-notice');
    const password = $('auth-password').value;
    if (setup && password !== $('auth-confirm-password').value) {
      notice.textContent = 'Passwords do not match.';
      notice.className = 'error';
      return;
    }
    const button = $('auth-submit');
    button.disabled = true;
    try {
      const user = await api(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('auth-username').value,
          password,
          ...(setup && form.dataset.setupKeyRequired === 'true' ? { setupKey: $('setup-key').value } : {})
        })
      });
      form.reset();
      if (user.role === 'admin' && $('clear-data-panel')) $('clear-data-panel').hidden = false;
      await enterApplication(user);
    } catch (error) {
      notice.textContent = error.message;
      notice.className = 'error';
    } finally {
      button.disabled = false;
    }
  });

  $('logout-button').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
      currentUser = null;
      showAuth(false);
    } catch (error) {
      notify(error.message, true);
    }
  });

  $('lot-select').addEventListener('change', async () => {
    currentLotId = Number($('lot-select').value);
    historyOffset = 0;
    localStorage.setItem('parkwise-lot-id', String(currentLotId));
    selectedSlot = null;
    await refresh();
  });

  function renderSlotDetails(slotNumber) {
    const vehicle = parked.find(item => item.slot === slotNumber);
    const details = $('slot-details');
    if (!vehicle) {
      details.innerHTML = `<div class="slot-detail-heading"><h3>Space P-${String(slotNumber).padStart(3, '0')}</h3><span class="space-status available">Available</span></div>
        <p class="muted">This parking space is empty and ready for the next vehicle.</p>
        <button type="button" class="secondary assign-slot" data-slot="${slotNumber}">Assign this space to next entry</button>`;
      return;
    }

    const elapsedMs = Math.max(0, Date.now() - new Date(vehicle.entryTime).getTime());
    const elapsedHours = Math.floor(elapsedMs / 3600000);
    const elapsedMinutes = Math.floor((elapsedMs % 3600000) / 60000);
    details.innerHTML = `<div class="slot-detail-heading"><h3>Space P-${String(vehicle.slot).padStart(3, '0')}</h3><span class="space-status occupied">Occupied</span></div>
      <dl class="slot-detail-list">
        <div><dt>Vehicle number</dt><dd>${esc(vehicle.number)}</dd></div>
        <div><dt>Owner</dt><dd>${esc(vehicle.owner)}</dd></div>
        <div><dt>Vehicle type</dt><dd>${esc(vehicle.type)}</dd></div>
        <div><dt>Contact number</dt><dd>${esc(vehicle.phone || 'Not provided')}</dd></div>
        <div><dt>Entry time</dt><dd>${date(vehicle.entryTime)}</dd></div>
        <div><dt>Parked for</dt><dd>${elapsedHours} hr ${elapsedMinutes} min</dd></div>
      </dl>
      <button type="button" class="primary exit-now" data-number="${esc(vehicle.number)}">Process this vehicle's exit</button>`;
  }

  function renderSlotMap(capacity) {
    const map = $('slot-map');
    map.innerHTML = Array.from({ length: capacity }, (_, index) => {
      const slotNumber = index + 1;
      const vehicle = parked.find(item => item.slot === slotNumber);
      const occupied = Boolean(vehicle);
      const label = `Space P-${String(slotNumber).padStart(3, '0')}: ${occupied ? `occupied by ${vehicle.number}, owner ${vehicle.owner}` : 'available'}`;
      return `<button type="button" class="parking-space ${occupied ? 'occupied' : 'available'}${selectedSlot === slotNumber ? ' selected' : ''}" data-slot="${slotNumber}" aria-label="${esc(label)}" aria-pressed="${selectedSlot === slotNumber}">
        <span class="space-number">P-${String(slotNumber).padStart(3, '0')}</span>
        <span class="space-vehicle">${occupied ? esc(vehicle.number) : 'Available'}</span>
      </button>`;
    }).join('');
    if (selectedSlot !== null && selectedSlot <= capacity) {
      renderSlotDetails(selectedSlot);
    } else {
      selectedSlot = null;
      $('slot-details').innerHTML = '<p class="muted">Select a parking space to see its details.</p>';
    }
  }

  document.querySelectorAll('.tab').forEach(button => {
    button.addEventListener('click', async () => {
      setTab(button.dataset.tab);
      if (button.dataset.tab === 'reports') {
        try { await loadReports(); } catch (error) { notify(error.message, true); }
      }
      if (button.dataset.tab === 'admin') {
        try { await loadAdmin(); } catch (error) { notify(error.message, true); }
      }
    });
  });

  function renderHistory() {
    $('history-body').innerHTML = history.length
      ? history.map(vehicle => `<tr>
          <td><b>${esc(vehicle.number)}</b></td>
          <td>${esc(vehicle.owner)}</td>
          <td>${esc(vehicle.type)}</td>
          <td>${date(vehicle.entryTime)}</td>
          <td>${date(vehicle.exitTime)}</td>
          <td>${vehicle.hours}</td>
          <td><b>${money(vehicle.fee)}</b></td>
        </tr>`).join('')
      : `<tr><td colspan="7" class="empty">${$('history-search').value.trim() ? 'No completed sessions match this search.' : 'No completed parking sessions yet.'}</td></tr>`;
    const start = historyTotal ? historyOffset + 1 : 0;
    const end = Math.min(historyOffset + history.length, historyTotal);
    $('history-page-label').textContent = `${start}–${end} of ${historyTotal} sessions`;
    $('history-prev').disabled = historyOffset === 0;
    $('history-next').disabled = historyOffset + history.length >= historyTotal;
    filterRows('history-search', 'history-body');
  }

  function renderReservations() {
    const currentTime = Date.now();
    $('reservations-body').innerHTML = reservations.length
      ? reservations.map(reservation => {
        const checkInAvailable = reservation.status === 'reserved'
          && new Date(reservation.startsAt).getTime() <= currentTime
          && new Date(reservation.endsAt).getTime() > currentTime;
        return `<tr>
          <td><b>${esc(reservation.number)}</b></td>
          <td>${esc(reservation.owner)}</td>
          <td>${date(reservation.startsAt)}</td>
          <td>${date(reservation.endsAt)}</td>
          <td>${esc(reservation.status)}</td>
          <td>${reservation.status === 'reserved'
            ? `${checkInAvailable ? `<button type="button" class="primary checkin-reservation" data-id="${reservation.id}">Check in</button>` : ''}
              <button type="button" class="secondary cancel-reservation" data-id="${reservation.id}">Cancel</button>`
            : '—'}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="6" class="empty">No reservations for this location.</td></tr>';
  }

  async function loadReports() {
    const params = new URLSearchParams(lotQuery());
    if ($('report-from').value) params.set('from', $('report-from').value);
    if ($('report-to').value) params.set('to', $('report-to').value);
    const report = await api(`/api/reports?${params}`);
    $('report-revenue').textContent = money(report.revenue);
    $('report-sessions').textContent = report.completedSessions;
    $('report-average').textContent = money(report.averageFee);
    $('report-parked').textContent = report.currentlyParked;
    $('report-peak').textContent = report.peakOccupancy;
    $('report-stay').textContent = `${Math.round(report.averageStayMinutes)} min`;
    const max = Math.max(1, ...report.daily.map(day => Number(day.revenue)));
    $('daily-report').innerHTML = report.daily.length
      ? report.daily.map(day => `<div class="daily-report-row">
          <time>${esc(day.day)}</time>
          <div class="daily-report-track"><span style="width:${Math.max(2, Number(day.revenue) / max * 100)}%"></span></div>
          <b>${money(day.revenue)}</b><small>${day.sessions} sessions</small>
        </div>`).join('')
      : '<p class="muted">No completed parking sessions in this date range.</p>';
    $('report-export').href = `/api/export/history.csv?${params}`;
  }

  async function loadAdmin() {
    if (currentUser?.role !== 'admin') return;
    const [users, auditLog] = await Promise.all([api('/api/users'), api('/api/audit')]);
    $('users-body').innerHTML = users.map(user => `<tr>
      <td>${esc(user.username)}</td><td>${esc(user.role)}</td><td>${user.active ? 'Active' : 'Disabled'}</td><td>${date(user.createdAt)}</td>
    </tr>`).join('');
    $('audit-body').innerHTML = auditLog.length
      ? auditLog.map(row => `<tr><td>${date(row.createdAt)}</td><td>${esc(row.username)}</td><td>${esc(row.action)}</td><td>${esc(JSON.stringify(row.details))}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">No changes recorded yet.</td></tr>';
  }

  async function refresh() {
    if (refreshInProgress) return false;
    refreshInProgress = true;
    try {
      const [dashboard, activeVehicles, historyResult, reservationsResult, locations] = await Promise.all([
        api(`/api/dashboard?${lotQuery()}`),
        api(`/api/vehicles?${lotQuery()}`),
        api(`/api/history?${lotQuery()}&q=${encodeURIComponent($('history-search').value.trim())}&from=${encodeURIComponent($('history-from').value)}&to=${encodeURIComponent($('history-to').value)}&limit=${historyPageSize}&offset=${historyOffset}`),
        api(`/api/reservations?${lotQuery()}`),
        api('/api/lots')
      ]);
      settings = dashboard.settings;
      parked = activeVehicles;
      history = historyResult.rows;
      historyTotal = historyResult.total;
      reservations = reservationsResult;
      lots = locations;
      if (!lots.some(lot => lot.id === currentLotId)) {
        currentLotId = lots[0].id;
        $('lot-select').value = String(currentLotId);
        localStorage.setItem('parkwise-lot-id', String(currentLotId));
      }
      setBackendStatus(true);

      $('capacity').textContent = dashboard.capacity;
      $('s-capacity').textContent = dashboard.capacity;
      $('s-occupied').textContent = dashboard.occupied;
      $('s-available').textContent = dashboard.available;
      $('s-revenue').textContent = money(dashboard.revenue);
      $('setting-name').value = settings.name;
      $('setting-address').value = settings.address;
      $('setting-capacity').value = settings.capacity;
      $('setting-rate').value = settings.rate;
      document.querySelectorAll('[data-rate-type]').forEach(input => {
        input.value = settings.rates[input.dataset.rateType] ?? '';
      });
      $('lot-select').innerHTML = lots.map(lot => `<option value="${lot.id}">${esc(lot.name)}</option>`).join('');
      $('lot-select').value = String(currentLotId);
      $('entry-slot').innerHTML = `<option value="">Auto-assign first available</option>${Array.from({ length: settings.capacity }, (_, index) => {
        const slot = index + 1;
        const occupiedVehicle = parked.find(vehicle => vehicle.slot === slot);
        return `<option value="${slot}" ${occupiedVehicle ? 'disabled' : ''}>P-${String(slot).padStart(3, '0')}${occupiedVehicle ? ` · occupied by ${esc(occupiedVehicle.number)}` : ''}</option>`;
      }).join('')}`;
      renderSlotMap(dashboard.capacity);

      $('parked-body').innerHTML = parked.length
        ? parked.map(vehicle => `<tr>
            <td><b>${esc(vehicle.number)}</b></td>
            <td>${esc(vehicle.owner)}</td>
            <td>${esc(vehicle.type)}</td>
            <td>${date(vehicle.entryTime)}</td>
            <td>P-${String(vehicle.slot).padStart(3, '0')}</td>
            <td><button type="button" class="secondary exit-now" data-number="${esc(vehicle.number)}">Process exit</button></td>
          </tr>`).join('')
        : '<tr><td colspan="6" class="empty">No vehicles are currently parked.</td></tr>';

      renderHistory();
      renderReservations();

      $('past-suggestions').innerHTML = [...new Map(
        historyResult.rows.map(vehicle => [vehicle.number.toUpperCase(), vehicle])
      ).values()].map(vehicle =>
        `<option value="${esc(vehicle.number)}">${esc(vehicle.owner)} · ${esc(vehicle.type)}</option>`
      ).join('');
      $('active-suggestions').innerHTML = parked.map(vehicle =>
        `<option value="${esc(vehicle.number)}">${esc(vehicle.owner)} · slot ${vehicle.slot}</option>`
      ).join('');
      $('year').textContent = new Date().getFullYear();
      $('last-refreshed').textContent = `Last refreshed ${new Date().toLocaleTimeString()}`;
      const exportParams = new URLSearchParams(lotQuery());
      if ($('history-search').value.trim()) exportParams.set('q', $('history-search').value.trim());
      if ($('history-from').value) exportParams.set('from', $('history-from').value);
      if ($('history-to').value) exportParams.set('to', $('history-to').value);
      $('history-export').href = `/api/export/history.csv?${exportParams}`;
      filterRows('parked-search', 'parked-body');
      if (document.querySelector('.tab.active')?.dataset.tab === 'reports') await loadReports();
      if (document.querySelector('.tab.active')?.dataset.tab === 'admin') await loadAdmin();
      return true;
    } catch (error) {
      if (error.message.includes('sign in') || error.message.includes('session expired')) {
        currentUser = null;
        showAuth(false);
        $('auth-notice').textContent = 'Your session expired. Please sign in again.';
        return false;
      }
      setBackendStatus(false);
      if (currentUser) notify(`Could not refresh parking data: ${error.message}`, true);
      return false;
    } finally {
      refreshInProgress = false;
    }
  }

  $('vehicle-number').addEventListener('change', async () => {
    const number = $('vehicle-number').value.trim().toUpperCase();
    if (!number) return;
    try {
      const suggestions = await api('/api/history/suggestions');
      const previous = suggestions.find(vehicle => vehicle.number.toUpperCase() === number);
      if (!previous) return;
      $('owner-name').value = previous.owner || '';
      $('vehicle-type').value = previous.type || 'Car';
      $('phone').value = previous.phone || '';
      notify('Previous customer details filled from parking history.');
    } catch (error) {
      notify(error.message, true);
    }
  });

  $('entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const created = await api('/api/vehicles', {
        method: 'POST',
        body: JSON.stringify({
          number: $('vehicle-number').value,
          owner: $('owner-name').value,
          type: $('vehicle-type').value,
          phone: $('phone').value,
          lotId: currentLotId,
          slot: $('entry-slot').value || undefined
        })
      });
      if (typeof created.slot !== 'number') {
        throw new Error('The server did not confirm the assigned parking slot. Check Parked vehicles before retrying.');
      }
      form.reset();
      const refreshed = await refresh();
      showEntryTicket(created);
      setTab('entry');
      if (refreshed) {
        notify(`Vehicle registered successfully in slot P-${String(created.slot).padStart(3, '0')}. Active vehicles are shown under Parked vehicles; history is recorded after checkout.`);
      } else {
        notify(`Vehicle registered in slot P-${String(created.slot).padStart(3, '0')}, but the dashboard could not refresh. Reload the page to verify the active vehicle.`, true);
      }
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  async function showEntryTicket(vehicle) {
    const lot = lots.find(location => location.id === vehicle.lotId);
    const qr = isValidPlate(vehicle.number)
      ? `<img class="ticket-qr" src="/api/tickets/${encodeURIComponent(vehicle.number)}/qr" alt="QR code for vehicle ${esc(vehicle.number)}">`
      : '';
    const qrNote = qr
      ? 'The QR code contains only the vehicle registration number.'
      : 'QR scanning is available only for valid Indian vehicle registration formats.';
    $('entry-ticket').innerHTML = `
      <div>
        <p class="eyebrow">PARKING TICKET</p>
        <h3>Entry confirmed</h3>
        <p>Vehicle: <b>${esc(vehicle.number)}</b></p>
        <p>Owner: <b>${esc(vehicle.owner)}</b></p>
        <p>Location: <b>${esc(lot?.name || 'Parking location')}</b></p>
        <p>Space: <b>P-${String(vehicle.slot).padStart(3, '0')}</b></p>
        <p>Entry time: <b>${esc(date(vehicle.entryTime))}</b></p>
        <button id="print-entry-ticket" class="secondary" type="button">Print parking ticket</button>
      </div>
      ${qr}
      <p class="ticket-note muted">${qrNote}</p>`;
    $('entry-ticket').hidden = false;
  }

  $('entry-ticket').addEventListener('click', event => {
    if (!event.target.closest('#print-entry-ticket')) return;
    document.body.classList.add('printing-ticket');
    window.print();
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('printing-ticket'));

  function showExitReceipt(vehicle, hours, fee, confirm = true) {
    $('exit-result').innerHTML = `<div class="receipt">
      <h3>${confirm ? 'Checkout estimate' : 'Checkout complete'}</h3>
      <p><span>Vehicle</span><b>${esc(vehicle.number)}</b></p>
      <p><span>Owner</span><b>${esc(vehicle.owner)}</b></p>
      <p><span>Slot</span><b>P-${String(vehicle.slot).padStart(3, '0')}</b></p>
      <p><span>Charged duration</span><b>${hours} hour(s)</b></p>
      <p><span>${confirm ? 'Estimated parking fee' : 'Parking fee charged'}</span><b>${money(fee)}</b></p>
      ${confirm ? '<p class="muted">The final fee is calculated by the server when the exit is confirmed.</p><button id="confirm-exit" class="primary" type="button">Confirm exit & record fee</button>' : '<button id="print-receipt" class="secondary" type="button">Print receipt</button>'}
    </div>`;
    $('print-receipt')?.addEventListener('click', () => window.print());
  }

  async function exitPreview(number) {
    const vehicle = parked.find(item => item.number.toUpperCase() === number.trim().toUpperCase());
    if (!vehicle) {
      $('exit-result').innerHTML = '<p class="muted">Vehicle not found in current parking.</p>';
      return;
    }

    const hours = Math.max(1, Math.ceil((Date.now() - new Date(vehicle.entryTime).getTime()) / 3600000));
    const hourlyRate = Number(settings.rates?.[vehicle.type] ?? settings.rate);
    showExitReceipt(vehicle, hours, hours * hourlyRate);

    $('confirm-exit').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api(`/api/vehicles/${encodeURIComponent(vehicle.number)}/exit?${lotQuery()}`, {
          method: 'POST',
          body: '{}'
        });
        showExitReceipt(result, result.hours, result.fee, false);
        $('exit-number').value = '';
        await refresh();
        notify(`Exit completed. Fee recorded: ${money(result.fee)}.`);
      } catch (error) {
        button.disabled = false;
        notify(error.message, true);
      }
    });
  }

  $('exit-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (await refresh()) await exitPreview($('exit-number').value);
  });

  document.addEventListener('click', event => {
    const space = event.target.closest('.parking-space');
    if (space) {
      selectedSlot = Number(space.dataset.slot);
      document.querySelectorAll('.parking-space').forEach(button => {
        const selected = Number(button.dataset.slot) === selectedSlot;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      renderSlotDetails(selectedSlot);
      return;
    }
    const button = event.target.closest('.exit-now');
    if (button) {
    $('exit-number').value = button.dataset.number;
    setTab('exit');
    exitPreview(button.dataset.number);
    return;
    }
    const assignButton = event.target.closest('.assign-slot');
    if (assignButton) {
    $('entry-slot').value = assignButton.dataset.slot;
    setTab('entry');
    $('vehicle-number').focus();
    }
  });

  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          lotId: currentLotId,
          name: $('setting-name').value,
          address: $('setting-address').value,
          capacity: Number($('setting-capacity').value),
          rate: Number($('setting-rate').value),
          rates: Object.fromEntries([...document.querySelectorAll('[data-rate-type]')]
            .filter(input => input.value !== '')
            .map(input => [input.dataset.rateType, Number(input.value)]))
        })
      });
      await loadLots();
      await refresh();
      notify('Settings saved successfully.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('clear-data-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const confirmation = $('clear-data-confirmation').value;
    if (confirmation !== 'CLEAR ALL DATA') {
      notify('Type CLEAR ALL DATA exactly to confirm the reset.', true);
      return;
    }
    button.disabled = true;
    try {
      const result = await api('/api/admin/data', {
        method: 'DELETE',
        body: JSON.stringify({ confirmation })
      });
      currentLotId = result.defaultLotId;
      localStorage.setItem('parkwise-lot-id', String(currentLotId));
      historyOffset = 0;
      selectedSlot = null;
      $('history-search').value = '';
      $('history-from').value = '';
      $('history-to').value = '';
      $('entry-ticket').hidden = true;
      form.reset();
      await loadLots();
      const refreshed = await refresh();
      if (!refreshed) {
        notify('Data was cleared, but the dashboard could not refresh. Reload the page to verify the reset.', true);
        return;
      }
      try {
        await loadAdmin();
      } catch (error) {
        notify(`Data was cleared, but the admin view could not refresh: ${error.message}`, true);
        return;
      }
      notify('All operational data was cleared. Your accounts and audit log were preserved.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('parked-search').addEventListener('input', () => filterRows('parked-search', 'parked-body'));
  let historySearchTimer;
  $('history-search').addEventListener('input', () => {
    window.clearTimeout(historySearchTimer);
    historySearchTimer = window.setTimeout(() => {
      historyOffset = 0;
      refresh();
    }, 250);
  });
  $('history-apply').addEventListener('click', () => {
    historyOffset = 0;
    refresh();
  });
  $('history-prev').addEventListener('click', () => {
    historyOffset = Math.max(0, historyOffset - historyPageSize);
    refresh();
  });
  $('history-next').addEventListener('click', () => {
    if (historyOffset + history.length >= historyTotal) return;
    historyOffset += historyPageSize;
    refresh();
  });
  $('refresh-button').addEventListener('click', async () => {
    const refreshed = await refresh();
    if (refreshed) {
      try {
        await loadReports();
        await loadAdmin();
      } catch (error) {
        if (currentUser?.role === 'admin') notify(error.message, true);
      }
      notify('Parking data refreshed.');
    }
  });
  $('refresh-reports').addEventListener('click', async () => {
    try { await loadReports(); } catch (error) { notify(error.message, true); }
  });

  $('reservation-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/reservations', {
        method: 'POST',
        body: JSON.stringify({
          lotId: currentLotId,
          number: $('reservation-number').value,
          owner: $('reservation-owner').value,
          type: $('reservation-type').value,
          phone: $('reservation-phone').value,
          startsAt: new Date($('reservation-start').value).toISOString(),
          endsAt: new Date($('reservation-end').value).toISOString()
        })
      });
      form.reset();
      await refresh();
      notify('Reservation created successfully.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('lot-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const lot = await api('/api/lots', {
        method: 'POST',
        body: JSON.stringify({
          name: $('lot-name').value,
          address: $('lot-address').value,
          capacity: Number($('lot-capacity').value),
          rate: Number($('lot-rate').value)
        })
      });
      form.reset();
      await loadLots();
      currentLotId = lot.id;
      $('lot-select').value = String(lot.id);
      localStorage.setItem('parkwise-lot-id', String(lot.id));
      await refresh();
      notify('Parking location added.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $('user-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: $('new-username').value,
          password: $('new-password').value,
          role: $('new-role').value
        })
      });
      form.reset();
      await loadAdmin();
      notify('User account created.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener('click', async event => {
    const checkInButton = event.target.closest('.checkin-reservation');
    if (checkInButton) {
      checkInButton.disabled = true;
      try {
        const vehicle = await api(`/api/reservations/${checkInButton.dataset.id}/check-in?${lotQuery()}`, {
          method: 'POST',
          body: '{}'
        });
        await refresh();
        showEntryTicket(vehicle);
        setTab('entry');
        notify(`Reservation checked in successfully in slot P-${String(vehicle.slot).padStart(3, '0')}.`);
      } catch (error) {
        checkInButton.disabled = false;
        notify(error.message, true);
        await refresh();
      }
      return;
    }
    const button = event.target.closest('.cancel-reservation');
    if (!button) return;
    button.disabled = true;
    try {
      await api(`/api/reservations/${button.dataset.id}/cancel?${lotQuery()}`, { method: 'POST', body: '{}' });
      await refresh();
      notify('Reservation cancelled.');
    } catch (error) {
      button.disabled = false;
      notify(error.message, true);
    }
  });

  $('download-backup').addEventListener('click', async () => {
    const button = $('download-backup');
    button.disabled = true;
    try {
      const response = await fetch('/api/admin/backup');
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `Backup failed (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `parkwise-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
      link.click();
      URL.revokeObjectURL(url);
      notify('Database backup downloaded.');
      await loadAdmin();
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  async function startCamera(mode, target = 'entry') {
    await stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      notify('Camera access requires HTTPS or localhost and a supported browser.', true);
      return;
    }
    if (mode === 'qr' && !('BarcodeDetector' in window)) {
      notify('QR scanning is not supported by this browser. Try Chrome or Edge, or use plate text scanning.', true);
      return;
    }
    if (mode === 'ocr' && !window.Tesseract) {
      notify('The plate text scanner could not load its OCR engine. Check your connection and reload.', true);
      return;
    }
    try {
      scannerMode = mode;
      scannerTarget = target;
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      $('scanner-video').srcObject = cameraStream;
      $('scanner-panel').hidden = false;
      $('stop-scan').hidden = false;
      await $('scanner-video').play();
      $('scanner-status').textContent = mode === 'qr'
        ? 'Point the camera at a QR code containing only a valid Indian registration number.'
        : 'Hold the number plate steady in good light. OCR runs in your browser; verify the detected text.';
      let detector;
      if (mode === 'qr') detector = new BarcodeDetector({ formats: ['qr_code'] });
      else if (window.Tesseract) {
        ocrWorker = await window.Tesseract.createWorker('eng', 1, {
          workerPath: '/vendor/tesseract/worker.min.js',
          corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js',
          langPath: 'https://tessdata.projectnaptha.com/4.0.0',
          logger: progress => {
            if (scannerMode === 'ocr' && progress.status === 'recognizing text') {
              $('scanner-status').textContent = `Reading plate… ${Math.round(progress.progress * 100)}%`;
            }
          }
        });
      }
      scanTimer = window.setInterval(async () => {
        if (scannerBusy || !$('scanner-video').videoWidth) return;
        scannerBusy = true;
        try {
          let candidate = '';
          if (scannerMode === 'qr') {
            const codes = await detector.detect($('scanner-video'));
            candidate = codes[0]?.rawValue || '';
          } else {
            const canvas = document.createElement('canvas');
            canvas.width = $('scanner-video').videoWidth;
            canvas.height = $('scanner-video').videoHeight;
            canvas.getContext('2d').drawImage($('scanner-video'), 0, 0);
            const result = await ocrWorker.recognize(canvas);
            const text = result.data.text.toUpperCase();
            candidate = (text.match(/[A-Z0-9][A-Z0-9 -]{5,20}/g) || [])
              .map(value => value.replace(/[\s-]/g, ''))
              .find(isValidPlate) || '';
            if (!candidate) $('scanner-status').textContent = 'No valid number plate found yet. Hold the plate steady and try again.';
          }
          const plate = normalizeScannedPlate(candidate);
          if (plate) {
            const destination = scannerTarget;
            await stopCamera();
            if (destination === 'exit') {
              setTab('exit');
              $('exit-number').value = plate;
              notify(`Ticket QR scanned for ${plate}. Confirm the vehicle and fee before checkout.`);
              if (await refresh()) await exitPreview(plate);
            } else {
              $('vehicle-number').value = plate;
              $('vehicle-number').dispatchEvent(new Event('change', { bubbles: true }));
              notify(`Detected registration ${plate}. Verify it before saving.`);
            }
          } else if (candidate && scannerMode === 'qr') {
            $('scanner-status').textContent = 'QR found, but it does not contain a valid Indian registration number. Scanner accepts number plates only.';
          }
        } catch (error) {
          $('scanner-status').textContent = `Scanner error: ${error.message}`;
        } finally {
          scannerBusy = false;
        }
      }, mode === 'qr' ? 300 : 1200);
    } catch (error) {
      await stopCamera();
      notify(`Could not start the camera: ${error.message}`, true);
    }
  }

  function isValidPlate(value) {
    return /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/.test(value)
      || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(value);
  }

  function normalizeScannedPlate(value) {
    const plate = String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
    return isValidPlate(plate) ? plate : '';
  }

  async function stopCamera() {
    if (scanTimer !== null) window.clearInterval(scanTimer);
    scanTimer = null;
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    $('scanner-video').srcObject = null;
    $('scanner-panel').hidden = true;
    $('stop-scan').hidden = true;
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
    scannerMode = null;
  }

  $('start-plate-scan').addEventListener('click', () => startCamera('ocr'));
  $('start-qr-scan').addEventListener('click', () => startCamera('qr'));
  $('start-ticket-scan').addEventListener('click', () => startCamera('qr', 'exit'));
  $('stop-scan').addEventListener('click', () => stopCamera());
  window.addEventListener('beforeunload', () => {
    if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  });

  $('report-from').addEventListener('change', () => loadReports().catch(error => notify(error.message, true)));
  $('report-to').addEventListener('change', () => loadReports().catch(error => notify(error.message, true)));
  window.setInterval(() => {
    if (currentUser && document.visibilityState === 'visible') refresh();
  }, 15000);
  checkAuthentication().catch(error => {
    setBackendStatus(false);
    showAuth(false);
    $('auth-notice').textContent = `Cannot connect to backend: ${error.message}. Start the server with npm start.`;
    $('auth-notice').className = 'error';
  });
})();

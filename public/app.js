import TableRenderer from './TableRenderer.js';

const API_BASE = '/plugins/speedandcurrent';

// ─── Unit conversion ──────────────────────────────────────────────────────────
const DEFAULTS = {
  speed: { convert: v => v * 1.943844, invert: v => v / 1.943844, symbol: 'kn', decimals: 1 },
  angle: { convert: v => v * (180 / Math.PI), invert: v => v * (Math.PI / 180), symbol: '°', decimals: 0 },
};

const _converterCache = new Map();

function isSafeFormula(f) {
  return typeof f === 'string' && /^[\d\s+\-*/.()eE]*$/.test(f.replace(/\bvalue\b/g, '0'));
}

function buildConverter(displayUnits) {
  if (!displayUnits || !isSafeFormula(displayUnits.formula)) return null;
  const key = displayUnits.formula + '|' + (displayUnits.symbol || '') + '|' + (displayUnits.displayFormat || '');
  if (_converterCache.has(key)) return _converterCache.get(key);
  let fn;
  try { fn = new Function('value', 'return ' + displayUnits.formula); fn(1); }
  catch (e) { _converterCache.set(key, null); return null; }
  let invertFn = null;
  if (isSafeFormula(displayUnits.inverseFormula)) {
    try { invertFn = new Function('value', 'return ' + displayUnits.inverseFormula); invertFn(1); }
    catch (e) { }
  }
  const parts = (displayUnits.displayFormat || '0.0').split('.');
  const decimals = parts.length > 1 ? parts[1].length : 0;
  const result = { convert: fn, invert: invertFn, symbol: displayUnits.symbol || displayUnits.targetUnit || '', decimals };
  _converterCache.set(key, result);
  return result;
}

const unitConverters = { speed: null, angle: null };

function updateUnitConverters() {
  const speedMeta = metaById['boatSpeed.smoothed'] || metaById['boatSpeed'];
  unitConverters.speed = buildConverter(speedMeta?.magnitude?.displayUnits) || null;
  const heelMeta = metaById['attitude.smoothed'] || metaById['attitude'];
  unitConverters.angle = buildConverter(heelMeta?.displayUnits) || null;
}

function applyUnitLabels() {
  const speedSym = (unitConverters.speed || DEFAULTS.speed).symbol;
  const angleSym = (unitConverters.angle || DEFAULTS.angle).symbol;
  ['create', 'resize'].forEach(prefix => {
    const setLabel = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setLabel(`${prefix}-maxSpeed-label`,  `Max speed (${speedSym})`);
    setLabel(`${prefix}-speedStep-label`, `Speed step (${speedSym})`);
    setLabel(`${prefix}-maxHeel-label`,   `Max heel (${angleSym})`);
    setLabel(`${prefix}-heelStep-label`,  `Heel step (${angleSym})`);
  });
}

// ─── TableRenderer instance ───────────────────────────────────────────────────
const tableRenderer = new TableRenderer();

// ─── Live state ───────────────────────────────────────────────────────────────
let state = {
  polarsAll: [], deltasAll: [], attitudesAll: [],
  polarsById: {}, deltasById: {}, attitudesById: {},
  tablesById: {}
};

function normaliseState(data) {
  const polarsById    = {};
  const deltasById    = {};
  const attitudesById = {};
  const tablesById    = {};
  for (const [id, v] of Object.entries(data.polars    || {})) polarsById[id]    = { ...v, id };
  for (const [id, v] of Object.entries(data.deltas    || {})) deltasById[id]    = { ...v, id };
  for (const [id, v] of Object.entries(data.attitudes || {})) attitudesById[id] = { ...v, id };
  for (const [id, v] of Object.entries(data.tables    || {})) tablesById[id]    = { ...v, id };
  const polarsAll    = Object.values(polarsById);
  const deltasAll    = Object.values(deltasById);
  const attitudesAll = Object.values(attitudesById);
  state = { polarsAll, deltasAll, attitudesAll, polarsById, deltasById, attitudesById, tablesById };
}

// ─── Static meta ─────────────────────────────────────────────────────────────
let metaById = {};
let lifecycleWarnings = [];

async function loadMeta() {
  const data = await apiGet('/api/meta');
  if (!data) return;
  metaById = {};
  for (const category of ['polars', 'deltas', 'attitudes', 'tables']) {
    const bucket = data[category] || {};
    for (const [id, m] of Object.entries(bucket)) {
      metaById[id] = { ...m, id };
    }
  }
  updateUnitConverters();
  applyUnitLabels();
}

function isNotReady(item) {
  if (!item) return true;
  return item.state?.ready !== true;
}

function getNotReadyReason(item) {
  if (!item) return 'not available';
  const s = item.state;
  if (!s) return 'not available';

  let subscribed, pathKnown;
  if (s.handler !== undefined) {
    subscribed = s.handler.subscribed;
    pathKnown  = s.handler.pathKnown;
  } else if (s.magnitude !== undefined || s.angle !== undefined) {
    const mag = s.magnitude, ang = s.angle;
    subscribed = (mag?.subscribed !== false) && (ang?.subscribed !== false);
    pathKnown  = (mag?.pathKnown  !== false) && (ang?.pathKnown  !== false);
  } else {
    subscribed = s.subscribed;
    pathKnown  = s.pathKnown;
  }

  if (subscribed === false) return 'not subscribed to Signal K';
  if (pathKnown  === false) return 'path not found in Signal K';
  if (!s.hasDelta)          return 'waiting for first data';
  if (s.isStale)            return 'data is stale';
  return 'not available';
}

function getAnyItem(id) {
  return state.polarsById[id] || state.deltasById[id] || state.attitudesById[id] || null;
}

function renderInputWarnings(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const lines = [];
  lifecycleWarnings.forEach(w => {
    if (w && typeof w.message === 'string') lines.push(w.message);
  });
  if (lines.length === 0) return;
  const h = document.createElement('h6');
  h.className = 'text-uppercase fw-bold text-muted border-bottom pb-1 mt-3 mb-1 small';
  h.textContent = 'Warnings';
  el.appendChild(h);
  const ul = document.createElement('ul');
  ul.className = 'list-unstyled text-danger small ps-3';
  lines.forEach(line => {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  });
  el.appendChild(ul);
}

// ─── Config ───────────────────────────────────────────────────────────────────
let config = null;

async function apiGet(path) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin' });
  } catch (err) {
    showMessage(`Cannot reach server: ${err.message}`);
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    showMessage('Not signed in. Please <a href="/">sign in</a>.', true);
    return null;
  }
  if (res.status === 503) { showMessage('Plugin is not running.'); return null; }
  if (!res.ok) { showMessage(`Server error ${res.status}`); return null; }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) { showMessage('Unexpected server response.'); return null; }
  showMessage('');
  return res.json();
}

async function apiPutSettings(body) {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  config = await res.json();
  renderSettingsPanel();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  return res.json();
}

function showMessage(html) {
  _explicitMsg = html;
  _refreshMessage();
}

let _pluginStatus = '';
let _explicitMsg  = '';

function _refreshMessage() {
  const el = document.getElementById('message');
  if (!el) return;
  if (_explicitMsg) {
    el.style.color = '#842029';
    if (_explicitMsg.includes('<')) el.innerHTML = _explicitMsg;
    else el.textContent = _explicitMsg;
    return;
  }
  const isRunningOk = (_pluginStatus === 'Running' || _pluginStatus === 'Stabilizing' || _pluginStatus === '');
  if (!isRunningOk) {
    el.textContent = _pluginStatus;
  } else {
    el.style.color = '';
    el.textContent = '';
  }
}

// ─── Settings ─────────────────────────────────────────────────────────────────
const paramMeta = {
  estimateBoatSpeed:                 { label: 'Estimate boat speed',                       type: 'boolean' },
  updateCorrectionTable:             { label: 'Update correction table',                   type: 'boolean' },
  suspendLearningOnNavigationState: { label: 'Suspend on navigation.state = motoring', type: 'boolean', description: 'Suspend learning when navigation.state is motoring. Anchored and moored always suspend learning when the path is available.' },
  assumeCurrent:                     { label: 'Assume current during update',         type: 'boolean', description: 'Experimental, works best when currents are relatively stable.' },
  sogFallback:                       { label: 'Groundspeed fallback',                 type: 'boolean', description: 'Output Groundspeed as Boatspeed when the paddlewheel sensor is malfunctioning or stalled.' },
  stability:                         { label: 'Stability (1–20)',                     type: 'number', min: 1, max: 20, step: 1, default: 7, description: 'How quickly the correction table adapts to new observations. Higher values mean slower, more stable changes.' },
  showStatistics:                    { label: 'Show statistics (σ)',                  type: 'boolean', description: 'Display standard deviation alongside smoothed values for debugging.' },
  smootherClass: {
    label: 'Smoother type', type: 'select',
    description: 'Smoothing applied to all sensor inputs for learning only.',
    options: [
      { value: 'MovingAverageSmoother', label: 'Moving average (window)' },
      { value: 'ExponentialSmoother',   label: 'Exponential (τ)' },
      { value: 'KalmanSmoother',        label: 'Kalman filter' },
    ]
  },
  smootherTau: {
    label: 'Time constant (τ)', type: 'number', unit: 's',
    min: 1, max: 60, step: 0.5, default: 3,
    description: 'Time constant in seconds.'
  },
  smootherTimeSpan: {
    label: 'Window size', type: 'number', unit: 's',
    min: 2, max: 60, step: 0.5, default: 5,
    description: 'Moving-average window in seconds.'
  },
  smootherSteadyState: {
    label: 'Kalman gain', type: 'number',
    min: 0.01, max: 0.99, step: 0.01, default: 0.2,
    description: 'Steady-state Kalman gain (0 ≈ slow/smooth, 1 ≈ fast/raw). Clamped to 0.01–0.99.'
  },
};

const ESTIMATION_SETTING_KEYS = ['sogFallback'];
const LEARNING_SETTING_KEYS   = ['stability', 'suspendLearningOnNavigationState', 'assumeCurrent', 'showStatistics'];
const SMOOTHER_SETTING_KEYS   = [
  'smootherClass',
  { key: 'smootherTau',         showIf: cfg => cfg.smootherClass === 'ExponentialSmoother' },
  { key: 'smootherTimeSpan',    showIf: cfg => (cfg.smootherClass || 'MovingAverageSmoother') === 'MovingAverageSmoother' },
  { key: 'smootherSteadyState', showIf: cfg => cfg.smootherClass === 'KalmanSmoother' },
];

function createSettingControl(key, meta, value) {
  if (meta.type === 'boolean') {
    const lbl = document.createElement('label');
    lbl.className = 'switch switch-text switch-primary';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'switch-input form-check-input'; cb.checked = !!value;
    cb.addEventListener('change', () => apiPutSettings({ [key]: cb.checked }).catch(e => showMessage(`Save failed: ${e.message}`)));
    const sl = document.createElement('span');
    sl.className = 'switch-label'; sl.setAttribute('data-on', 'On'); sl.setAttribute('data-off', 'Off');
    const sh = document.createElement('span');
    sh.className = 'switch-handle';
    lbl.appendChild(cb); lbl.appendChild(sl); lbl.appendChild(sh);
    return lbl;
  }

  if (meta.type === 'number') {
    const wrap = document.createElement('span');
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'form-control form-control-sm d-inline-block';
    inp.style.width = '80px';
    inp.value = value !== undefined ? value : (meta.default !== undefined ? meta.default : '');
    if (meta.min !== undefined) inp.min = meta.min;
    if (meta.max !== undefined) inp.max = meta.max;
    if (meta.step !== undefined) inp.step = meta.step;
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (Number.isFinite(v)) apiPutSettings({ [key]: v }).catch(e => showMessage(`Save failed: ${e.message}`));
    });
    wrap.appendChild(inp);
    if (meta.default !== undefined && value !== meta.default) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-link btn-sm p-0 ms-1';
      btn.title = `Reset to default (${meta.default})`;
      btn.textContent = '↺';
      btn.addEventListener('click', () => apiPutSettings({ [key]: meta.default }).catch(e => showMessage(`Save failed: ${e.message}`)));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  if (meta.type === 'select') {
    const sel = document.createElement('select');
    sel.className = 'form-select form-select-sm d-inline-block';
    sel.style.width = '220px';
    (meta.options || []).forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value; o.textContent = opt.label;
      sel.appendChild(o);
    });
    sel.value = value !== undefined && value !== null ? value : (meta.options[0]?.value || '');
    sel.addEventListener('change', () => {
      apiPutSettings({ [key]: sel.value }).catch(e => showMessage(`Save failed: ${e.message}`));
    });
    return sel;
  }

  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'form-control form-control-sm';
  inp.value = (value || '').trim();
  let debounce;
  inp.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => apiPutSettings({ [key]: inp.value.trim() || ' ' }).catch(e => showMessage(`Save failed: ${e.message}`)), 600);
  });
  return inp;
}

function renderSettingsRows(tableId, keys) {
  const table = document.getElementById(tableId);
  const tbody = table && table.querySelector('tbody');
  if (!tbody || !config) return;
  tbody.innerHTML = '';
  keys.forEach(entry => {
    const key  = typeof entry === 'string' ? entry : entry.key;
    if (entry.showIf && !entry.showIf(config)) return;
    const meta = paramMeta[key];
    if (!meta) return;
    const value = config[key];
    const tr = document.createElement('tr');
    const tdL = document.createElement('td');
    tdL.textContent = meta.label;
    if (meta.description) {
      const desc = document.createElement('small');
      desc.className = 'text-muted d-block';
      desc.textContent = meta.description;
      tdL.appendChild(desc);
    }
    const tdC = document.createElement('td'); tdC.appendChild(createSettingControl(key, meta, value));
    tr.appendChild(tdL); tr.appendChild(tdC);
    tbody.appendChild(tr);
  });
}

function renderSectionToggles() {
  if (!config) return;
  [['toggle-estimateBoatSpeed', 'estimateBoatSpeed'], ['toggle-updateCorrectionTable', 'updateCorrectionTable']].forEach(([id, key]) => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.checked = !!config[key];
    cb.onchange = () => apiPutSettings({ [key]: cb.checked }).catch(e => showMessage(`Save failed: ${e.message}`));
  });
}

function renderSettingsPanel() {
  if (!config) return;
  renderSettingsRows('estimation-settings-table', ESTIMATION_SETTING_KEYS);
  renderSettingsRows('smoother-settings-table',   SMOOTHER_SETTING_KEYS);
  renderSettingsRows('learning-settings-table',   LEARNING_SETTING_KEYS);
  renderSectionToggles();
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function formatPolarValue(p) {
  if (!p) return '—';
  const m = metaById[p.id];
  const speedC = buildConverter(m?.magnitude?.displayUnits) || DEFAULTS.speed;
  const angleC = buildConverter(m?.angle?.displayUnits)     || DEFAULTS.angle;
  const spd = typeof p.magnitude === 'number' ? speedC.convert(p.magnitude).toFixed(speedC.decimals) : '—';
  const ang = typeof p.angle    === 'number' ? angleC.convert(p.angle).toFixed(angleC.decimals)      : '—';
  const sigma = (config?.showStatistics && p.id.endsWith('.smoothed') && typeof p.trace === 'number')
    ? ` (σ=${speedC.convert(Math.sqrt(p.trace)).toFixed(speedC.decimals + 2)})` : '';
  return `${spd} ${speedC.symbol} / ${ang}${angleC.symbol}${sigma}`;
}

function formatDeltaValue(d) {
  if (!d || typeof d.value !== 'number') return '—';
  const m = metaById[d.id];
  const uc = buildConverter(m?.displayUnits)
    || (m?.units === 'm/s' ? DEFAULTS.speed : DEFAULTS.angle);
  const sigma = (config?.showStatistics && d.id.endsWith('.smoothed') && typeof d.variance === 'number')
    ? ` (σ=${uc.convert(Math.sqrt(d.variance)).toFixed(uc.decimals + 2)})` : '';
  return `${uc.convert(d.value).toFixed(uc.decimals)} ${uc.symbol}${sigma}`;
}

function formatAttitudeValue(a) {
  const v = (a && a.value) || {};
  const variance = a && a.variance;
  const m = metaById[a?.id];
  const angleC = buildConverter(m?.displayUnits) || DEFAULTS.angle;
  const roll  = typeof v.roll  === 'number' ? angleC.convert(v.roll).toFixed(angleC.decimals)  : '—';
  const showSigma = config?.showStatistics && a?.id?.endsWith('.smoothed');
  const sigmaRoll  = (showSigma && variance && typeof variance.roll  === 'number') ? ` (σ=${angleC.convert(Math.sqrt(variance.roll)).toFixed(angleC.decimals + 2)})`  : '';
  return `heel ${roll} ${angleC.symbol} ${sigmaRoll} `;
}

function itemLabel(item) {
  return metaById[item.id]?.displayName ?? item.path ?? item.id;
}

function buildDataTable(rows) {
  const tbl = document.createElement('table');
  tbl.className = 'table table-sm table-borderless mb-0';
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const tr = document.createElement('tr');
    if (row.stale) tr.className = 'stale';
    const tdL = document.createElement('td'); tdL.textContent = row.label;
    const tdV = document.createElement('td'); tdV.textContent = row.value;
    tr.appendChild(tdL); tr.appendChild(tdV);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  return tbl;
}

function filterById(arr, ids) {
  return ids.flatMap(id => {
    const item = arr.find(item => item.id === id);
    return item ? [item] : [];
  });
}

function renderGroupInto(elId, polars, deltas, attitudes) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const rows = [
    ...polars   .map(p => ({ label: itemLabel(p), value: formatPolarValue(p),    stale: isNotReady(p) })),
    ...deltas   .map(d => ({ label: itemLabel(d), value: formatDeltaValue(d),    stale: isNotReady(d) })),
    ...attitudes.map(a => ({ label: itemLabel(a), value: formatAttitudeValue(a), stale: isNotReady(a) }))
  ];
  if (rows.length) el.appendChild(buildDataTable(rows));
}

function renderLiveSections() {
  const learningState = state.learningState || null;
  const inputPolars = filterById(state.polarsAll, ['groundSpeed']);
  const inputDeltas = filterById(state.deltasAll, ['heading.angle', 'boatSpeed']);
  const inputAttitudes = filterById(state.attitudesAll, ['attitude']);
  const fallbackInputPolars = inputPolars.length ? inputPolars : filterById(state.polarsAll, ['groundSpeed.smoothed']);
  const fallbackInputDeltas = inputDeltas.length ? inputDeltas : filterById(state.deltasAll, ['heading.smoothed', 'boatSpeed.smoothed']);
  const fallbackInputAttitudes = inputAttitudes.length ? inputAttitudes : filterById(state.attitudesAll, ['attitude.smoothed']);

  renderGroupInto('inputs-values',
    fallbackInputPolars,
    fallbackInputDeltas,
    fallbackInputAttitudes
  );
  renderInputWarnings('inputs-warnings');

  renderGroupInto('estimation-inputs',
    filterById(state.polarsAll,    ['groundSpeed']),
    filterById(state.deltasAll,    ['heading.angle', 'boatSpeed']),
    filterById(state.attitudesAll, ['attitude'])
  );
  renderGroupInto('estimation-intermediates',
    filterById(state.polarsAll, ['boatSpeedRefGround', 'speedCorrection', 'residual', 'residual.smoothed']),
    [], []
  );
  renderGroupInto('estimation-outputs',
    filterById(state.polarsAll, ['correctedBoatSpeed', 'current.smoothed']),
    [], []
  );

  const learningCurrentPolars = (config && config.assumeCurrent)
    ? filterById(state.polarsAll, ['current.smoothed'])
    : [];
  renderGroupInto('learning-inputs',
    [...filterById(state.polarsAll, ['groundSpeed.smoothed']), ...learningCurrentPolars],
    filterById(state.deltasAll,    ['heading.smoothed', 'boatSpeed.smoothed']),
    filterById(state.attitudesAll, ['attitude.smoothed'])
  );

  const statusTbody = document.querySelector('#learning-status-table tbody');
  if (statusTbody) {
    const learningTextMap = { off: 'Off', stabilizing: 'Stabilising', active: 'Active', suspended: 'Suspended' };
    const observationTextMap = { accepted: 'Accepted', rejected: 'Rejected', invalid: 'Invalid', skipped: 'Skipped' };
    const reasonTextMap = {
      manual: 'Manual toggle off', startup: 'Startup stabilising window',
      observation_reset: 'Recent rejected or invalid observation',
      nav_state_change: 'navigation.state changed', nav_state: 'Blocked by navigation.state',
      cog_override: 'Blocked by COG override', accepted: 'Observation recorded',
      estimator_outlier: 'Estimator rejected observation', missing_input: 'Required learning input unavailable',
      missing_current_when_required: 'Current estimate unavailable', learning_off: 'Learning is off',
      stabilizing: 'Stabilising window active', nav_state_blocked: 'Learning blocked by navigation.state',
      cog_override_active: 'Learning blocked by COG override', stw_below_threshold: 'Below minimum STW for learning',
      sog_below_threshold: 'Below minimum SOG for learning',
    };
    const learningText = learningTextMap[learningState?.state] || '—';
    const obsText = observationTextMap[learningState?.observationState] || '—';
    const reason = reasonTextMap[learningState?.observationReason] || reasonTextMap[learningState?.reason] || '—';
    statusTbody.innerHTML =
      `<tr><td class="text-muted small">Learning</td><td class="small">${learningText}</td></tr>` +
      `<tr><td class="text-muted small">Observation</td><td class="small">${obsText}</td></tr>` +
      `<tr><td class="text-muted small">Reason</td><td class="small">${reason}</td></tr>`;
  }

  const tableEl = document.getElementById('table-container');
  if (tableEl) {
    tableEl.innerHTML = '';
    const speedC = unitConverters.speed || DEFAULTS.speed;
    const angleC = unitConverters.angle || DEFAULTS.angle;
    const tableOpts = {
      fmtSpeed:    v => speedC.convert(v).toFixed(speedC.decimals),
      fmtHeel:     v => angleC.convert(v).toFixed(angleC.decimals),
      speedSymbol: speedC.symbol,
      heelSymbol:  angleC.symbol,
    };
    Object.values(state.tablesById).forEach(t => tableEl.appendChild(tableRenderer.render(t, tableOpts)));
  }
}

// ─── Polling ──────────────────────────────────────────────────────────────────
let updateTimer = null;
let lastTickOk = false;

async function tick() {
  const data = await apiGet('/api/report');
  if (data) {
    if (!lastTickOk) {
      await loadMeta();
      config = await apiGet('/api/settings');
      if (config && config.tableName) setTableName(config.tableName);
      renderSettingsPanel();
    }
    lastTickOk = true;
    normaliseState(data);
    state.learningState = data.learningState || null;
    renderLiveSections();
  } else {
    lastTickOk = false;
    state.learningState = null;
  }

  const statusData = await fetch(`${API_BASE}/api/status`, { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  _pluginStatus = statusData?.status ?? '';
  lifecycleWarnings = Array.isArray(statusData?.lifecycleWarnings) ? statusData.lifecycleWarnings : [];
  _refreshMessage();
}

function startUpdates() {
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(tick, 1000);
}

// ─── Vanilla Modal Helpers ────────────────────────────────────────────────────
function showModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  if (!document.getElementById('app-modal-backdrop')) {
    const bd = document.createElement('div');
    bd.id = 'app-modal-backdrop';
    bd.className = 'modal-backdrop show';
    document.body.appendChild(bd);
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.style.display = 'none'; el.classList.remove('show'); el.setAttribute('aria-hidden', 'true'); }
  document.body.classList.remove('modal-open');
  const bd = document.getElementById('app-modal-backdrop');
  if (bd) bd.remove();
}

// ─── Correction Table Manager ─────────────────────────────────────────────────
function setTableName(name) {
  const el = document.getElementById('active-table-name');
  if (el) el.textContent = name ? `(${name})` : '';
}

function modalStatus(modalId, msg, ok = false) {
  const el = document.getElementById('modal-' + modalId + '-status');
  if (el) { el.textContent = msg; el.className = 'small mr-auto ' + (ok ? 'text-success' : 'text-danger'); }
}

function initTableManager() {
  if (config && config.tableName) setTableName(config.tableName);

  ['modal-create', 'modal-load', 'modal-copy', 'modal-resize'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll('.close, [data-dismiss="modal"]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(id));
    });
    el.addEventListener('click', e => { if (e.target === el) closeModal(id); });
  });

  document.getElementById('btn-tbl-new')?.addEventListener('click', () => {
    modalStatus('create', '');
    showModal('modal-create');
  });

  document.getElementById('create-mode')?.addEventListener('change', (e) => {
    const isHeel = e.target.value === 'heel';
    document.getElementById('row-create-maxDim2').style.display = isHeel ? '' : 'none';
    document.getElementById('row-create-dim2Step').style.display = isHeel ? '' : 'none';
  });

  document.getElementById('btn-create-confirm')?.addEventListener('click', async () => {
    modalStatus('create', '');
    const mode = document.getElementById('create-mode')?.value || 'twa';
    const speedC = unitConverters.speed || DEFAULTS.speed;
    const angleC = unitConverters.angle || DEFAULTS.angle;
    const invertSpeed = speedC.invert || DEFAULTS.speed.invert;
    const invertAngle = angleC.invert || DEFAULTS.angle.invert;

    const body = {
      name: (document.getElementById('create-name')?.value || '').trim(),
      dimensionTwoMode: mode,
      maxSpeed: invertSpeed(Number(document.getElementById('create-maxSpeed')?.value)),
      speedStep: invertSpeed(Number(document.getElementById('create-speedStep')?.value)),
    };

    if (mode === 'heel') {
      body.maxDim2 = invertAngle(Number(document.getElementById('create-maxHeel')?.value));
      body.dim2Step = invertAngle(Number(document.getElementById('create-heelStep')?.value));
    }

    if (!body.name) { modalStatus('create', 'Name is required.'); return; }
    try {
      const r = await apiPost('/api/tables/create', body);
      setTableName(r.name);
      if (config) config.tableName = r.name;
      closeModal('modal-create');
      await tick();
    } catch (e) { modalStatus('create', e.message); }
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function start() {
  initTableManager();

  config = await apiGet('/api/settings');
  if (config && config.tableName) setTableName(config.tableName);
  renderSettingsPanel();

  await loadMeta();
  await tick();
  renderSettingsPanel();
  startUpdates();
}

window.addEventListener('DOMContentLoaded', () => {
  start();
});

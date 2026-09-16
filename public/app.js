import TableRenderer from './TableRenderer.js';

const API_BASE = '/plugins/speedandcurrent';

// ─── Unit conversion (respects SK server unitPreferences via displayUnits in meta) ─
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
  const dim2Meta = metaById['attitude.smoothed'] || metaById['windAngle.angle'] || metaById['attitude'];
  unitConverters.angle = buildConverter(dim2Meta?.displayUnits) || null;
}

function applyUnitLabels() {
  const speedSym = (unitConverters.speed || DEFAULTS.speed).symbol;
  const angleSym = (unitConverters.angle || DEFAULTS.angle).symbol;
  const mode = config?.dimensionTwoMode || 'heel';
  const dim2Title = mode === 'heel' ? 'heel' : (mode === 'awa' ? 'AWA' : 'TWA');

  ['create', 'resize'].forEach(prefix => {
    const setLabel = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setLabel(`${prefix}-maxSpeed-label`,  `Max speed (${speedSym})`);
    setLabel(`${prefix}-speedStep-label`, `Speed step (${speedSym})`);
    setLabel(`${prefix}-maxDim2-label`,   `Max ${dim2Title} (${angleSym})`);
    setLabel(`${prefix}-dim2Step-label`,  `${dim2Title} step (${angleSym})`);
  });
}

const tableRenderer = new TableRenderer();

let state = {
  polarsAll: [], deltasAll: [], attitudesAll: [],
  polarsById: {}, deltasById: {}, attitudesById: {},
  tablesById: {}
};

function normaliseState(data) {
  if (!data) return;
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
  applyUnitLabels();
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

function showMessage(html, isLink = false) {
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

// ─── Settings: paramMeta ──────────────────────────────────────────────────────
const paramMeta = {
  estimateBoatSpeed:     { label: 'Estimate boat speed',                 type: 'boolean' },
  updateCorrectionTable: { label: 'Update correction table',              type: 'boolean' },
  dimensionTwoMode: {
    label: 'Table 2nd Dimension', type: 'select',
    description: 'Select variable for table columns (Heel for monohulls; AWA or TWA for catamarans).',
    options: [
      { value: 'heel', label: 'Heel angle (roll)' },
      { value: 'awa',  label: 'Apparent wind angle (AWA)' },
      { value: 'twa',  label: 'True wind angle (TWA)' }
    ]
  },
  suspendLearningOnNavigationState: { label: 'Suspend on navigation.state = motoring', type: 'boolean', description: 'Suspend learning when navigation.state is motoring.' },
  assumeCurrent:          { label: 'Assume current during update',         type: 'boolean', description: 'Experimental, works best when currents are relatively stable.' },
  sogFallback:            { label: 'Groundspeed fallback',                 type: 'boolean', description: 'Output Groundspeed as Boatspeed when paddlewheel sensor is stalled.' },
  stability:              { label: 'Stability (1–20)',                     type: 'number', min: 1, max: 20, step: 1, default: 7, description: 'How quickly the correction table adapts.' },
  showStatistics:         { label: 'Show statistics (σ)',                  type: 'boolean', description: 'Display standard deviation alongside smoothed values.' },
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
    description: 'Steady-state Kalman gain.'
  },
};

const ESTIMATION_SETTING_KEYS = ['sogFallback'];
const LEARNING_SETTING_KEYS   = ['dimensionTwoMode', 'stability', 'suspendLearningOnNavigationState', 'assumeCurrent', 'showStatistics'];
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
  if (!a) return '—';
  const m = metaById[a?.id];
  const angleC = buildConverter(m?.displayUnits) || DEFAULTS.angle;
  if (typeof a.value === 'number') {
    return `${angleC.convert(a.value).toFixed(angleC.decimals)} ${angleC.symbol}`;
  }
  const v = a.value || {};
  const roll = typeof v.roll === 'number' ? angleC.convert(v.roll).toFixed(angleC.decimals) : '—';
  return `heel ${roll} ${angleC.symbol}`;
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
  if (!Array.isArray(arr)) return [];
  return ids.flatMap(id => {
    const item = arr.find(item => item && item.id === id);
    return item ? [item] : [];
  });
}

function renderGroupInto(elId, polars = [], deltas = [], attitudes = []) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  const rows = [
    ...(polars   || []).map(p => ({ label: itemLabel(p), value: formatPolarValue(p),    stale: isNotReady(p) })),
    ...(deltas   || []).map(d => ({ label: itemLabel(d), value: formatDeltaValue(d),    stale: isNotReady(d) })),
    ...(attitudes|| []).map(a => ({ label: itemLabel(a), value: formatAttitudeValue(a), stale: isNotReady(a) }))
  ];
  if (rows.length) el.appendChild(buildDataTable(rows));
}

function renderLiveSections() {
  const learningState = state.learningState || null;

  // ── Inputs Section ──
  const inputPolars = filterById(state.polarsAll, ['groundSpeed']);
  const inputDeltas = filterById(state.deltasAll, ['heading.angle', 'boatSpeed', 'windAngle.angle']);
  const inputAttitudes = filterById(state.attitudesAll, ['attitude']);
  const fallbackInputPolars = inputPolars.length ? inputPolars : filterById(state.polarsAll, ['groundSpeed.smoothed']);
  const fallbackInputDeltas = inputDeltas.length ? inputDeltas : filterById(state.deltasAll, ['heading.smoothed', 'boatSpeed.smoothed', 'windAngle.smoothed']);
  const fallbackInputAttitudes = inputAttitudes.length ? inputAttitudes : filterById(state.attitudesAll, ['attitude.smoothed']);

  renderGroupInto('inputs-values', fallbackInputPolars, fallbackInputDeltas, fallbackInputAttitudes);
  renderInputWarnings('inputs-warnings');

  // ── Estimation Section ──
  renderGroupInto('estimation-inputs',
    filterById(state.polarsAll, ['groundSpeed']),
    filterById(state.deltasAll, ['heading.angle', 'boatSpeed']),
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

  // ── Learning Section ──
  const learningCurrentPolars = (config && config.assumeCurrent)
    ? filterById(state.polarsAll, ['current.smoothed'])
    : [];
  renderGroupInto('learning-inputs',
    [...filterById(state.polarsAll, ['groundSpeed.smoothed']), ...learningCurrentPolars],
    filterById(state.deltasAll, ['heading.smoothed', 'boatSpeed.smoothed', 'windAngle.smoothed']),
    filterById(state.attitudesAll, ['attitude.smoothed'])
  );

  // ── Table Section ──
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
      dim2Mode:    config?.dimensionTwoMode || 'heel'
    };
    Object.values(state.tablesById || {}).forEach(t => tableEl.appendChild(tableRenderer.render(t, tableOpts)));
  }
}

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

function showModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = 'block';
  el.classList.add('show');
  document.body.classList.add('modal-open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.style.display = 'none'; el.classList.remove('show'); }
  document.body.classList.remove('modal-open');
}

function setTableName(name) {
  const el = document.getElementById('active-table-name');
  if (el) el.textContent = name ? `(${name})` : '';
}

function modalStatus(modalId, msg) {
  const el = document.getElementById('modal-' + modalId + '-status');
  if (el) el.textContent = msg;
}

function initTableManager() {
  if (config && config.tableName) setTableName(config.tableName);

  ['modal-create', 'modal-load', 'modal-copy', 'modal-resize'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.querySelectorAll('.close, [data-dismiss="modal"]').forEach(btn => {
      btn.addEventListener('click', () => closeModal(id));
    });
  });

  document.getElementById('btn-tbl-new')?.addEventListener('click', () => {
    applyUnitLabels();
    showModal('modal-create');
  });

  document.getElementById('btn-tbl-resize')?.addEventListener('click', () => {
    applyUnitLabels();
    const t = Object.values(state.tablesById)[0];
    if (t && t.row && t.col) {
      const speedC = unitConverters.speed || DEFAULTS.speed;
      const angleC = unitConverters.angle || DEFAULTS.angle;
      const setVal = (id, v, dec) => { const el = document.getElementById(id); if (el) el.value = +v.toFixed(dec); };
      setVal('resize-maxSpeed',  speedC.convert(t.row.max),  Math.max(speedC.decimals, 1));
      setVal('resize-speedStep', speedC.convert(t.row.step), Math.max(speedC.decimals, 1));
      setVal('resize-maxDim2',   angleC.convert(t.col.max),  Math.max(angleC.decimals, 0));
      setVal('resize-dim2Step',  angleC.convert(t.col.step), Math.max(angleC.decimals, 0));
    }
    showModal('modal-resize');
  });

  document.getElementById('btn-create-confirm')?.addEventListener('click', async () => {
    modalStatus('create', '');
    const speedC = unitConverters.speed || DEFAULTS.speed;
    const angleC = unitConverters.angle || DEFAULTS.angle;
    const body = {
      name:      (document.getElementById('create-name')?.value || '').trim(),
      maxSpeed:  (speedC.invert || DEFAULTS.speed.invert)(Number(document.getElementById('create-maxSpeed')?.value)),
      speedStep: (speedC.invert || DEFAULTS.speed.invert)(Number(document.getElementById('create-speedStep')?.value)),
      maxDim2:   (angleC.invert || DEFAULTS.angle.invert)(Number(document.getElementById('create-maxDim2')?.value)),
      dim2Step:  (angleC.invert || DEFAULTS.angle.invert)(Number(document.getElementById('create-dim2Step')?.value)),
    };
    if (!body.name) { modalStatus('create', 'Name is required.'); return; }
    try {
      const r = await apiPost('/api/tables/create', body);
      setTableName(r.name);
      closeModal('modal-create');
      await tick();
    } catch (e) { modalStatus('create', e.message); }
  });

  document.getElementById('btn-resize-confirm')?.addEventListener('click', async () => {
    modalStatus('resize', '');
    const speedC = unitConverters.speed || DEFAULTS.speed;
    const angleC = unitConverters.angle || DEFAULTS.angle;
    const body = {
      maxSpeed:  (speedC.invert || DEFAULTS.speed.invert)(Number(document.getElementById('resize-maxSpeed')?.value)),
      speedStep: (speedC.invert || DEFAULTS.speed.invert)(Number(document.getElementById('resize-speedStep')?.value)),
      maxDim2:   (angleC.invert || DEFAULTS.angle.invert)(Number(document.getElementById('resize-maxDim2')?.value)),
      dim2Step:  (angleC.invert || DEFAULTS.angle.invert)(Number(document.getElementById('resize-dim2Step')?.value)),
    };
    try {
      await apiPost('/api/tables/resize', body);
      closeModal('modal-resize');
      await tick();
    } catch (e) { modalStatus('resize', e.message); }
  });
}

async function start() {
  initTableManager();
  config = await apiGet('/api/settings');
  if (config && config.tableName) setTableName(config.tableName);
  renderSettingsPanel();
  await loadMeta();
  await tick();
  startUpdates();
}

window.addEventListener('DOMContentLoaded', () => {
  start();
});

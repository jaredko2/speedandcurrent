const path = require('path');
const fs = require('fs');

const {
  SmoothedAngle,
  SI,
  MessageHandler,
  Polar,
  Reporter,
  BaseSmoother,
  MovingAverageSmoother,
  ExponentialSmoother,
  KalmanSmoother,
  PolarSmoother,
  createSmoothedPolar,
  createSmoothedHandler,
  Table2D
} = require('signalkutilities');

const { CorrectionTable } = require('./correctionTable.js');

const LONG_STABILIZING_MS = 60 * 1000;
const ALWAYS_BLOCKING_NAVIGATION_STATES = new Set(['anchored', 'moored']);
const OPTIONAL_BLOCKING_NAVIGATION_STATES = new Set(['motoring']);

function normalizeNavigationState(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function getShortStabilizingMs(options = {}) {
  return Math.max(0, Number(options.smootherTimeSpan) || 5) * 1000;
}

function isCogOverrideActive(groundSpeedPolar, speedThreshold) {
  const sogHandler = groundSpeedPolar?.magnitudeHandler;
  return !groundSpeedPolar?.ready
    && sogHandler?.ready
    && Number.isFinite(sogHandler.value)
    && sogHandler.value < speedThreshold;
}

/**
 * Leeway is the angle of the corrected boatspeed vector, so a small lateral
 * correction divided by a near-zero magnitude yields a large, meaningless angle.
 */
function isLeewayValid(speed, speedThreshold, navigationStateHandler) {
  if (!(speed >= speedThreshold)) return false;
  const state = navigationStateHandler?.state;
  if (state?.ready !== true) return true;
  return !ALWAYS_BLOCKING_NAVIGATION_STATES.has(normalizeNavigationState(navigationStateHandler.value));
}

function evaluateLearningMode({ options = {}, navigationState, stabilizingUntil = 0, stabilizingReason = null, now = Date.now() }) {
  const normalizedNavigationState = normalizeNavigationState(navigationState?.value);
  const navigationGateReady = navigationState?.ready === true;
  const navigationGateBlocking = navigationGateReady && (
    ALWAYS_BLOCKING_NAVIGATION_STATES.has(normalizedNavigationState)
    || (!!options.suspendLearningOnNavigationState && OPTIONAL_BLOCKING_NAVIGATION_STATES.has(normalizedNavigationState))
  );

  if (!options.updateCorrectionTable) {
    return { state: 'off', reason: 'manual', navigationGateBlocking, normalizedNavigationState };
  }

  if (navigationGateBlocking) {
    return { state: 'suspended', reason: 'nav_state', navigationGateBlocking, normalizedNavigationState };
  }

  if (now < stabilizingUntil) {
    return { state: 'stabilizing', reason: stabilizingReason || 'startup', navigationGateBlocking, normalizedNavigationState };
  }

  return { state: 'active', reason: null, navigationGateBlocking, normalizedNavigationState };
}

function evaluateObservationGate({
  learningMode,
  inputsReady,
  assumeCurrent,
  currentReady,
  stw,
  sog,
  speedThreshold,
}) {
  if (learningMode.state === 'off') {
    return { state: 'skipped', reason: 'learning_off' };
  }
  if (learningMode.state === 'suspended') {
    return { state: 'skipped', reason: learningMode.reason === 'cog_override' ? 'cog_override_active' : 'nav_state_blocked' };
  }
  if (learningMode.state === 'stabilizing') {
    return { state: 'skipped', reason: 'stabilizing' };
  }
  if (!inputsReady) {
    return { state: 'invalid', reason: assumeCurrent && !currentReady ? 'missing_current_when_required' : 'missing_input' };
  }
  if (!(stw > speedThreshold)) {
    return { state: 'skipped', reason: 'stw_below_threshold' };
  }
  if (!(sog >= speedThreshold)) {
    return { state: 'skipped', reason: 'sog_below_threshold' };
  }
  return { state: 'pending', reason: null };
}

function buildNavigationStateStatus(handler, gateEnabled) {
  if (!handler) {
    return {
      enabled: !!gateEnabled,
      path: 'navigation.state',
      pathKnown: false,
      ready: false,
      value: null,
      blocking: false
    };
  }

  const state = handler.state;
  const value = handler.value ?? null;
  const normalized = normalizeNavigationState(value);
  return {
    enabled: !!gateEnabled,
    path: handler.path,
    pathKnown: state.pathKnown,
    ready: state.ready,
    isStale: state.isStale,
    value,
    blocking: state.ready && (
      ALWAYS_BLOCKING_NAVIGATION_STATES.has(normalized)
      || (!!gateEnabled && OPTIONAL_BLOCKING_NAVIGATION_STATES.has(normalized))
    )
  };
}

function getDerivedObservationStatus(learningMode, lastState, lastReason) {
  if (learningMode.state === 'off') {
    return { state: 'skipped', reason: 'learning_off' };
  }
  if (learningMode.state === 'stabilizing') {
    return { state: 'skipped', reason: 'stabilizing' };
  }
  if (learningMode.state === 'suspended') {
    return { state: 'skipped', reason: learningMode.reason === 'cog_override' ? 'cog_override_active' : 'nav_state_blocked' };
  }
  return { state: lastState, reason: lastReason };
}

module.exports = function (app) {

  const DEFAULT_DIMS = { maxSpeed: 9, speedStep: 1, maxHeel: 32, heelStep: 8 };

  let options = {};
  let changedOptions = {};
  const defaultOptions = {
    sogFallback: true,
    estimateBoatSpeed: false,
    updateCorrectionTable: true,
    stability: 7,
    assumeCurrent: false,
    suspendLearningOnNavigationState: false,
    tableName: 'correctionTable',
    configVersion: 2,
    smootherClass: 'MovingAverageSmoother',
    smootherTau: 3,
    smootherTimeSpan: 5,
    smootherSteadyState: 0.2,
    showStatistics: false
  };

  function readOptions() {
    const stored = app.readPluginOptions();
    const raw = stored && stored.configuration ? stored.configuration : (stored || {});
    // Strip embedded table — stored separately on disk
    const { correctionTable: _drop, ...rest } = raw;
    options = { ...defaultOptions, ...rest };
  }

  function saveOptions() {
    app.savePluginOptions({ ...options }, (err) => {
      if (err) app.error(`Error saving plugin options: ${err.message}`);
    });
  }

  function saveTableName(name) {
    options.tableName = name;
    saveOptions();
  }

  /**
   * Strips obsolete source-selection fields from the persisted config and
   * writes it back if anything changed. Called once on every start().
   */
  function migrateConfig() {
    const obsoleteKeys = ['headingSource', 'boatSpeedSource', 'SOGSource', 'attitudeSource', 'preventDuplication', 'minSogForLearning'];
    const hadObsolete = obsoleteKeys.some(k => k in options);
    for (const k of obsoleteKeys) delete options[k];
    if (hadObsolete || (options.configVersion || 0) < 2) {
      options.configVersion = 2;
      saveOptions();
      app.debug('Config migrated to v2: removed obsolete source-selection fields');
    }
  }

  /**
   * Derives { SmootherClass, smootherOptions } from the current options.
   */
  function resolveSmootherConfig() {
    const cls = options.smootherClass || 'MovingAverageSmoother';
    if (cls === 'ExponentialSmoother') {
      return {
        SmootherClass: ExponentialSmoother,
        smootherOptions: { timeConstant: Math.max(1, Number(options.smootherTau) || 3) }
      };
    }
    if (cls === 'KalmanSmoother') {
      const K = Math.min(0.99, Math.max(0.01, Number(options.smootherSteadyState) || 0.2));
      return {
        SmootherClass: KalmanSmoother,
        smootherOptions: { steadyState: K }
      };
    }
    return {
      SmootherClass: MovingAverageSmoother,
      smootherOptions: { timeSpan: Math.max(2, Number(options.smootherTimeSpan) || 5) }
    };
  }

  function swapTable(newTable) {
    table = newTable;
    minSpeed = (table.step && Number.isFinite(table.step[0])) ? table.step[0] : (table.row?.step ?? 0.5144);
    if (reportFull) reportFull.setTables([table]);
    lastSave = Date.now();
  }

  let isRunning = false;
  let pluginStatus = 'Stopped';
  let smoothedHeading = null;
  let smoothedAttitude = null;
  let smoothedTwa = null;
  let rawCurrent = null;
  let smoothedCurrent = null;
  let smoothedBoatSpeed = null;
  let correctedBoatSpeed = null;
  let lrnBoatSpeed = null;
  let boatSpeedRefGround = null;
  let smoothedGroundSpeed = null;
  let speedCorrection = null;
  let residual = null;
  let smoothedResidual = null;
  let reportFull = null;
  let table = null;

  let rawHeading = null;
  let rawAttitude = null;
  let rawTwa = null;
  let noCurrent = null;
  let rawBoatSpeed = null;
  let rawGroundSpeed = null;
  let minSpeed = 0;
  let lastSave = 0;
  let navigationStateHandler = null;
  let lastNavigationStateValue = null;
  let learningStabilizingUntil = 0;
  let learningStabilizingReason = 'startup';
  let lastObservationState = null;
  let lastObservationReason = null;
  let lifecycleWarningMap = new Map();
  let lifecycleWarnings = [];

  function setObservationStatus(state, reason = null) {
    lastObservationState = state;
    lastObservationReason = reason;
    if (table) {
      table.lastUpdateResult = state;
      table.lastUpdateReason = reason;
    }
  }

  function resetLearningStabilization(reason, durationMs) {
    const delay = Math.max(0, Number(durationMs) || 0);
    learningStabilizingUntil = Date.now() + delay;
    learningStabilizingReason = reason;
  }

  function handleNavigationStateDelta() {
    const normalized = normalizeNavigationState(navigationStateHandler?.value);
    if (normalized === lastNavigationStateValue) return;
    if (lastNavigationStateValue !== null) {
      resetLearningStabilization('nav_state_change', LONG_STABILIZING_MS);
    }
    lastNavigationStateValue = normalized;
  }

  function getLearningStatePayload() {
    const navigationState = buildNavigationStateStatus(navigationStateHandler, options.suspendLearningOnNavigationState);
    const learningMode = evaluateLearningMode({
      options,
      navigationState,
      stabilizingUntil: learningStabilizingUntil,
      stabilizingReason: learningStabilizingReason,
      now: Date.now()
    });
    if (learningMode.state === 'active' && isCogOverrideActive(rawGroundSpeed, minSpeed)) {
      learningMode.state = 'suspended';
      learningMode.reason = 'cog_override';
    }
    const observation = getDerivedObservationStatus(learningMode, lastObservationState, lastObservationReason);

    return {
      state: learningMode.state,
      reason: learningMode.reason,
      observationState: observation.state,
      observationReason: observation.reason,
      minStwForLearning: minSpeed,
      minSogForLearning: minSpeed,
      navigationState
    };
  }

  function setLifecycleWarning(id, status, path) {
    const safePath = path || 'unknown path';
    const message = status === 'idle'
      ? `Input ${id} is idle on ${safePath}; resubscribing`
      : status === 'incomplete'
      ? `Input ${id} is missing ${safePath}`
      : `Input ${id} is stale on ${safePath}`;
    lifecycleWarningMap.set(id, {
      id,
      status,
      path: safePath,
      message,
      updatedAt: Date.now()
    });
    lifecycleWarnings = Array.from(lifecycleWarningMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function clearLifecycleWarning(id) {
    if (!lifecycleWarningMap.has(id)) return;
    lifecycleWarningMap.delete(id);
    lifecycleWarnings = Array.from(lifecycleWarningMap.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function buildLifecycleCallbacks(id, getPath, resubscribe) {
    return {
      onDelta: () => {
        clearLifecycleWarning(id);
      },
      onStale: () => {
        if (!isRunning) return;
        const path = getPath();
        app.debug(`[${plugin.id}] stale input ${id} on ${path}`);
        setLifecycleWarning(id, 'stale', path);
      },
      onIdle: () => {
        if (!isRunning) return;
        const path = getPath();
        app.debug(`[${plugin.id}] idle input ${id} on ${path}; resubscribing`);
        setLifecycleWarning(id, 'idle', path);
        try {
          resubscribe();
        } catch (e) {
          app.debug(`[${plugin.id}] resubscribe failed for ${id}: ${e.message}`);
        }
      }
    };
  }

  const plugin = {};
  plugin.id = "SpeedAndCurrent";
  plugin.name = "Speed and current";
  plugin.description = "A plugin that uses sensor fusion to get boat speed, current and leeway.";

  plugin.schema = {
    type: "object",
    description: "Speed and Current is configured through its own webapp. Open it from the Signal K app list.",
    properties: {}
  };

  plugin.registerWithRouter = function (router) {
    app.debug('registerWithRouter');
    readOptions();

    router.get('/api/report', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        const payload = reportFull.report();
        payload.lifecycleWarnings = lifecycleWarnings;
        payload.learningState = getLearningStatePayload();
        res.json(payload);
      }
    });

    router.get('/api/meta', (req, res) => {
      if (!isRunning) {
        res.status(503).json({ error: "Plugin is not running" });
      } else {
        res.json(reportFull.meta());
      }
    });

    router.get('/api/status', (req, res) => {
      res.json({ status: pluginStatus, isRunning, lifecycleWarnings, learningState: getLearningStatePayload() });
    });

    // --- Settings API ---
    router.get('/api/settings', (req, res) => {
      res.json({ ...options, ...changedOptions });
    });

    router.put('/api/settings', (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'JSON body required' });
      }
      // Reject keys managed by the table manager
      const blocked = ['correctionTable', 'tableName'];
      for (const k of blocked) {
        if (k in body) {
          return res.status(400).json({ error: `Key '${k}' is managed via the table manager` });
        }
      }
      changedOptions = { ...changedOptions, ...body };
      res.json({ ...options, ...changedOptions });
    });

    // --- Correction Table Manager API ---

    // List all table files in dataDir
    router.get('/api/tables', (req, res) => {
      const dataDir = app.getDataDirPath();
      let files;
      try { files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')); }
      catch (e) { return res.json([]); }
      const activeName = options.tableName || 'correctionTable';
      const tables = [];
      for (const file of files) {
        try {
          const data = Table2D.readFromFile(path.join(dataDir, file));
          if (data && Array.isArray(data.table) && data.table.length > 0) {
            const name = file.replace(/\.json$/, '');
            const dimensionTwoMode = data.dimensionTwoMode || (data.table[0]?.length === 6 ? 'twa' : 'heel');
            tables.push({ name, active: name === activeName, dimensionTwoMode });
          }
        } catch (e) { /* skip non-table files */ }
      }
      res.json(tables);
    });

    // Create a new table and hot-swap it
    router.post('/api/tables/create', (req, res) => {
      const body = req.body || {};
      const name = (body.name || '').trim();
      if (!name || !/^[\w-]+$/.test(name)) {
        return res.status(400).json({ error: 'Name must be alphanumeric (underscores and hyphens allowed)' });
      }
      const mode = body.dimensionTwoMode === 'twa' ? 'twa' : 'heel';

      if (!Number.isFinite(body.maxSpeed) || body.maxSpeed <= 0 ||
          !Number.isFinite(body.speedStep) || body.speedStep <= 0) {
        return res.status(400).json({ error: 'Invalid or missing speed dimensions' });
      }

      const row = { min: 0, max: body.maxSpeed, step: body.speedStep };
      let col;
      if (mode === 'twa') {
        const DEFAULT_TWA_BINS = [-145, -90, -40, 40, 90, 145].map(d => d * (Math.PI / 180));
        col = {
          min: DEFAULT_TWA_BINS[0],
          max: DEFAULT_TWA_BINS[5],
          step: (DEFAULT_TWA_BINS[5] - DEFAULT_TWA_BINS[0]) / 5,
          bins: DEFAULT_TWA_BINS
        };
      } else {
        if (!Number.isFinite(body.maxHeel) || body.maxHeel <= 0 ||
            !Number.isFinite(body.heelStep) || body.heelStep <= 0) {
          return res.status(400).json({ error: 'Invalid or missing heel dimensions' });
        }
        col = { min: -body.maxHeel, max: body.maxHeel, step: body.heelStep };
      }

      const newTable = new CorrectionTable(name, row, col, options.stability || 7, mode);
      newTable.setDisplayAttributes({ label: name });
      saveTable(newTable, path.join(app.getDataDirPath(), name + '.json'));
      if (isRunning) swapTable(newTable);
      saveTableName(name);
      res.json({ name, dimensionTwoMode: mode });
    });

    // Load a saved table and make it active
    router.post('/api/tables/load', (req, res) => {
      const body = req.body || {};
      const name = (body.name || '').trim();
      if (!name || !/^[\w-]+$/.test(name)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }
      const filePath = path.join(app.getDataDirPath(), name + '.json');
      const fileData = Table2D.readFromFile(filePath);
      if (!fileData) return res.status(404).json({ error: `Table '${name}' not found` });
      const loadedTable = CorrectionTable.fromJSON(fileData, options.stability || 7);
      if (!loadedTable) return res.status(400).json({ error: `Could not parse table '${name}'` });
      loadedTable.setDisplayAttributes({ label: name });
      // Ensure file on disk reflects any standardized format
      saveTableSync(loadedTable, filePath);
      if (isRunning) swapTable(loadedTable);
      saveTableName(name);
      res.json({ name, dimensionTwoMode: loadedTable.dimensionTwoMode });
    });

    // Copy active table under a new name and hot-swap to it
    router.post('/api/tables/copy', (req, res) => {
      if (!isRunning || !table) return res.status(503).json({ error: 'Plugin is not running' });
      const body = req.body || {};
      const newName = (body.newName || '').trim();
      if (!newName || !/^[\w-]+$/.test(newName)) {
        return res.status(400).json({ error: 'Name must be alphanumeric (underscores and hyphens allowed)' });
      }
      const data = table.toJSON();
      data.id = newName;
      const copiedTable = CorrectionTable.fromJSON(data, options.stability || 7);
      copiedTable.setDisplayAttributes({ label: newName });
      saveTableSync(copiedTable, path.join(app.getDataDirPath(), newName + '.json'));
      swapTable(copiedTable);
      saveTableName(newName);
      res.json({ name: newName, dimensionTwoMode: copiedTable.dimensionTwoMode });
    });

    // Resize the active table (resamples onto new grid, preserves name)
    router.post('/api/tables/resize', (req, res) => {
      if (!isRunning || !table) return res.status(503).json({ error: 'Plugin is not running' });
      const body = req.body || {};
      if (!Number.isFinite(body.maxSpeed) || body.maxSpeed <= 0 ||
          !Number.isFinite(body.speedStep) || body.speedStep <= 0) {
        return res.status(400).json({ error: 'Speed dimensions must be positive numbers' });
      }

      const newRow = { min: 0, max: body.maxSpeed, step: body.speedStep };
      let newCol;
      if (table.dimensionTwoMode === 'twa') {
        newCol = table.col;
      } else {
        if (!Number.isFinite(body.maxHeel) || body.maxHeel <= 0 ||
            !Number.isFinite(body.heelStep) || body.heelStep <= 0) {
          return res.status(400).json({ error: 'Heel dimensions must be positive numbers' });
        }
        newCol = { min: -body.maxHeel, max: body.maxHeel, step: body.heelStep };
      }

      const resized = CorrectionTable.resample(table, newRow, newCol, options.stability || 7, 1e-4);
      resized.setDisplayAttributes({ label: resized.id });
      saveTableSync(resized, path.join(app.getDataDirPath(), resized.id + '.json'));
      swapTable(resized);
      res.json({ name: resized.id, dimensionTwoMode: resized.dimensionTwoMode });
    });
  };

  function setStatus(msg) {
    pluginStatus = msg;
    app.setPluginStatus(msg);
  }

  plugin.start = (settings) => {
    setStatus('Starting');
    app.debug("Starting");
    lifecycleWarningMap = new Map();
    lifecycleWarnings = [];
    readOptions();
    migrateConfig();
    const tableName = options.tableName || 'correctionTable';
    const tableFilePath = path.join(app.getDataDirPath(), tableName + '.json');
    table = loadTable(options, tableFilePath);
    minSpeed = (table.step && Number.isFinite(table.step[0])) ? table.step[0] : (table.row?.step ?? 0.5144);

    //#region Handler and Polar Initialization
    const { SmootherClass, smootherOptions } = resolveSmootherConfig();

    // heading
    smoothedHeading = new SmoothedAngle(app, plugin.id, 'heading', 'navigation.headingTrue', {
      angleRange: '0to2pi',
      meta: { displayName: 'Heading', plane: 'Ground' },
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'heading.angle',
        () => smoothedHeading?.handler?.path || 'navigation.headingTrue',
        () => { smoothedHeading?.unsubscribe(); smoothedHeading?.subscribe(false, true); }
      )
    });
    rawHeading = smoothedHeading.handler;

    // attitude (heel)
    smoothedAttitude = createSmoothedHandler({
      app, pluginId: plugin.id,
      id: 'attitude',
      path: 'navigation.attitude',
      subscribe: true,
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'attitude.smoothed',
        () => smoothedAttitude?.handler?.path || 'navigation.attitude',
        () => { smoothedAttitude?.unsubscribe(); smoothedAttitude?.subscribe(); }
      )
    });
    rawAttitude = smoothedAttitude.handler;

    // True wind angle (for catamarans)
    smoothedTwa = new SmoothedAngle(app, plugin.id, 'twa', 'environment.wind.angleTrueWater', {
      angleRange: '-piToPi',
      meta: { displayName: 'True Wind Angle', plane: 'Boat' },
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'twa.angle',
        () => smoothedTwa?.handler?.path || 'environment.wind.angleTrueWater',
        () => { smoothedTwa?.unsubscribe(); smoothedTwa?.subscribe(false, true); }
      )
    });
    rawTwa = smoothedTwa.handler;

    navigationStateHandler = new MessageHandler(app, plugin.id, 'navigationState');
    navigationStateHandler.configure('navigation.state');
    navigationStateHandler.onDelta = () => {
      handleNavigationStateDelta();
    };
    navigationStateHandler.subscribe();

    // current
    MessageHandler.setMeta(app, plugin.id, "environment.current.drift", { units: "m/s", type: "number", description: "Speed of the current" });
    MessageHandler.setMeta(app, plugin.id, "environment.current.setTrue", { units: "rad", type: "number", description: "Direction of the current" });
    rawCurrent = new Polar(app, plugin.id, "current");
    rawCurrent.configureMagnitude("environment.current.drift");
    rawCurrent.configureAngle("environment.current.setTrue");
    rawCurrent.setMeta({ displayName: "Current", plane: "Ground" });
    rawCurrent.setAngleRange('0to2pi');
    smoothedCurrent = new PolarSmoother(rawCurrent, KalmanSmoother, { processVariance: 0.000001, measurementVariance: 0.01 });
    smoothedCurrent.setAngleRange('0to2pi');
    rawCurrent.setVectorValue({ x: 0, y: 0 });
    smoothedCurrent.xSmoother.reset(0, 0.00000001);
    smoothedCurrent.ySmoother.reset(0, 0.00000001);

    noCurrent = createSmoothedPolar({
      id: "noCurrent",
      pathMagnitude: "environment.current.drift",
      pathAngle: "environment.current.setTrue",
      subscribe: false,
      app,
      pluginId: plugin.id,
      SmootherClass: BaseSmoother,
      smootherOptions: smootherOptions,
      meta: { displayName: "NoCurrent", plane: "Ground" },
    });
    noCurrent.xSmoother.reset(0, 0);
    noCurrent.ySmoother.reset(0, 0);
    PolarSmoother.send(app, plugin.id, [noCurrent]);

    MessageHandler.setMeta(app, plugin.id, 'navigation.leewayAngle', {
      units: 'rad',
      description: 'Leeway Angle',
      displayUnits: {
        category: 'angle'
      }
    });

    // boatspeed
    smoothedBoatSpeed = createSmoothedHandler({
      app, pluginId: plugin.id,
      id: 'boatSpeed',
      path: 'navigation.speedThroughWater',
      subscribe: false,
      SmootherClass,
      smootherOptions,
      onDelta: () => {
        clearLifecycleWarning('boatSpeed.smoothed');
        if (Object.keys(changedOptions).length) applyOptionChanges();

        const learningMode = evaluateLearningMode({
          options,
          navigationState: buildNavigationStateStatus(navigationStateHandler, options.suspendLearningOnNavigationState),
          stabilizingUntil: learningStabilizingUntil,
          stabilizingReason: learningStabilizingReason,
          now: Date.now()
        });

        const wellUnderway = Date.now() >= learningStabilizingUntil;
        setStatus(learningMode.state === 'stabilizing' ? 'Stabilizing' : 'Running');
        if (options.estimateBoatSpeed) correct(wellUnderway);
        updateTable();
        if (lastObservationState === 'accepted' && options.updateCorrectionTable) {
          const now = Date.now();
          if (now - lastSave > 60_000) {
            if (!isTableEmpty(table)) {
              saveTable(table, path.join(app.getDataDirPath(), table.id + '.json'));
            }
            lastSave = now;
          }
        }
      },
      onIdle: () => {
        if (!isRunning) return;
        const path = smoothedBoatSpeed?.handler?.path || 'navigation.speedThroughWater';
        app.debug(`[${plugin.id}] idle input boatSpeed.smoothed on ${path}; resubscribing`);
        setLifecycleWarning('boatSpeed.smoothed', 'idle', path);
        smoothedBoatSpeed?.unsubscribe();
        smoothedBoatSpeed?.subscribe();
      },
      onStale: () => {
        if (!isRunning) return;
        const path = smoothedBoatSpeed?.handler?.path || 'navigation.speedThroughWater';
        app.debug(`[${plugin.id}] stale input boatSpeed.smoothed on ${path}`);
        setLifecycleWarning('boatSpeed.smoothed', 'stale', path);
      }
    });
    rawBoatSpeed = smoothedBoatSpeed.handler;

    // Learning polar
    lrnBoatSpeed = new Polar(app, plugin.id, "lrnBoatSpeed");
    lrnBoatSpeed.configureMagnitude("navigation.speedThroughWater");
    lrnBoatSpeed.configureAngle("navigation.leewayAngle");
    lrnBoatSpeed.setMeta({ displayName: "Learning boat speed", plane: "Boat" });
    lrnBoatSpeed.setAngleRange('-piToPi');

    correctedBoatSpeed = new Polar(app, plugin.id, "correctedBoatSpeed");
    correctedBoatSpeed.configureMagnitude("navigation.speedThroughWater");
    correctedBoatSpeed.configureAngle("navigation.leewayAngle");
    correctedBoatSpeed.setMeta({ displayName: "Corrected boatspeed / Leeway", plane: "Boat" });

    boatSpeedRefGround = new Polar(app, plugin.id, "boatSpeedRefGround");
    boatSpeedRefGround.setMeta({ displayName: "Boat speed over ground", plane: "Ground" });

    // ground speed
    smoothedGroundSpeed = createSmoothedPolar({
      app, pluginId: plugin.id,
      id: 'groundSpeed',
      pathMagnitude: 'navigation.speedOverGround',
      pathAngle: 'navigation.courseOverGroundTrue',
      angleRange: '0to2pi',
      meta: { displayName: 'Groundspeed', plane: 'Ground' },
      SmootherClass,
      smootherOptions,
      ...buildLifecycleCallbacks(
        'groundSpeed.smoothed',
        () => `${smoothedGroundSpeed?.polar?.pathMagnitude || 'navigation.speedOverGround'}, ${smoothedGroundSpeed?.polar?.pathAngle || 'navigation.courseOverGroundTrue'}`,
        () => { smoothedGroundSpeed?.unsubscribe(); smoothedGroundSpeed?.subscribe(true, true); }
      )
    });
    rawGroundSpeed = smoothedGroundSpeed.polar;

    speedCorrection = new Polar(app, plugin.id, "speedCorrection");
    speedCorrection.setMeta({ displayName: "Speed correction", plane: "Boat" });

    residual = new Polar(app, plugin.id, "residual");
    residual.setMeta({ displayName: "Residual", plane: "Ground" });
    smoothedResidual = new PolarSmoother(residual, ExponentialSmoother, { tau: 30, timeSpan: 30 });
    smoothedResidual.setAngleRange('0to2pi');
    //#endregion

    //#region Reporting
    reportFull = new Reporter();

    if (options.estimateBoatSpeed) {
      reportFull.addDelta(rawHeading);
      reportFull.addAttitude(rawAttitude);
      if (rawTwa) reportFull.addDelta(rawTwa);
      reportFull.addDelta(rawBoatSpeed);
      reportFull.addPolar(speedCorrection);
      reportFull.addPolar(boatSpeedRefGround);
      reportFull.addPolar(correctedBoatSpeed);
      reportFull.addPolar(rawGroundSpeed);
      reportFull.addPolar(smoothedCurrent);
      reportFull.addPolar(residual);
      reportFull.addPolar(smoothedResidual);
    }
    reportFull.addDelta(smoothedHeading);
    reportFull.addAttitude(smoothedAttitude);
    if (smoothedTwa) reportFull.addDelta(smoothedTwa);
    reportFull.addDelta(smoothedBoatSpeed);
    reportFull.addPolar(smoothedGroundSpeed);
    if (options.assumeCurrent && !options.estimateBoatSpeed) {
      reportFull.addPolar(smoothedCurrent);
    }
    reportFull.addTable(table);
    //#endregion

    isRunning = true;
    lastSave = 0;
    lastObservationState = null;
    lastObservationReason = null;
    lastNavigationStateValue = normalizeNavigationState(navigationStateHandler?.value);
    resetLearningStabilization('startup', LONG_STABILIZING_MS);
    setStatus('Running');
    smoothedBoatSpeed.subscribe();
    app.debug("Running");
  };

  plugin.stop = () => {
    return new Promise((resolve, reject) => {
      try {
        if (table && !isTableEmpty(table)) {
          saveTableSync(table, path.join(app.getDataDirPath(), table.id + '.json'));
        }
        if (smoothedCurrent) PolarSmoother.clear(app, plugin.id, [smoothedCurrent]);
        if (options.estimateBoatSpeed && correctedBoatSpeed) Polar.clear(app, plugin.id, [correctedBoatSpeed]);
        smoothedHeading = smoothedHeading?.terminate();
        smoothedAttitude = smoothedAttitude?.terminate();
        smoothedTwa = smoothedTwa?.terminate();
        rawCurrent = rawCurrent?.terminate();
        smoothedCurrent = smoothedCurrent?.terminate?.();
        navigationStateHandler = navigationStateHandler?.terminate();
        smoothedBoatSpeed = smoothedBoatSpeed?.terminate();
        correctedBoatSpeed = correctedBoatSpeed?.terminate();
        lrnBoatSpeed = lrnBoatSpeed?.terminate();
        boatSpeedRefGround = boatSpeedRefGround?.terminate();
        smoothedGroundSpeed = smoothedGroundSpeed?.terminate();
        speedCorrection = speedCorrection?.terminate();
        residual = residual?.terminate();
        smoothedResidual = smoothedResidual?.terminate?.();
        reportFull = null;
        table = null;
        rawHeading = null;
        rawAttitude = null;
        rawTwa = null;
        noCurrent = null;
        rawBoatSpeed = null;
        rawGroundSpeed = null;
        lastNavigationStateValue = null;
        learningStabilizingUntil = 0;
        learningStabilizingReason = 'startup';
        lastObservationState = null;
        lastObservationReason = null;
        app.setPluginStatus("Stopped");
        app.debug("Stopped");

        pluginStatus = 'Stopped';
        isRunning = false;
        lifecycleWarningMap = new Map();
        lifecycleWarnings = [];
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  };

  /**
   * Corrects and publishes boat speed.
   */
  function correct(wellUnderway) {
    correctedBoatSpeed.setVectorValue({ x: rawBoatSpeed.value, y: 0 });
    speedCorrection.setVectorValue({ x: 0, y: 0 });

    const isTwa = table?.dimensionTwoMode === 'twa';
    const dim2Ready = isTwa
      ? Boolean(smoothedTwa && (smoothedTwa.ready || smoothedTwa.handler?.ready))
      : Boolean(rawAttitude && rawAttitude.ready && Number.isFinite(rawAttitude.value?.roll));

    if (options.sogFallback && rawGroundSpeed.ready && rawBoatSpeed.ready && rawBoatSpeed.value === 0 && rawGroundSpeed.magnitude >= minSpeed) {
      correctedBoatSpeed.setVectorValue({ x: rawGroundSpeed.magnitude, y: 0 });
    }
    else if (dim2Ready) {
      if (!isTwa) clearLifecycleWarning('attitude.roll');
      if (correctedBoatSpeed.magnitude > 0) {
        const dim2Val = isTwa
          ? (smoothedTwa?.handler?.value ?? smoothedTwa?.value ?? 0)
          : rawAttitude.value.roll;
        const { correction, variance } = table.getCorrection(correctedBoatSpeed.magnitude, dim2Val)
          || { correction: { x: 0, y: 0 }, variance: { x: 0, y: 0 } };
        const leewayValid = isLeewayValid(correctedBoatSpeed.magnitude, minSpeed, navigationStateHandler);
        speedCorrection.setVectorValue(
          { x: correction.x || 0, y: leewayValid ? (correction.y || 0) : 0 },
          { x: variance.x || 0, y: leewayValid ? (variance.y || 0) : 0 }
        );
        correctedBoatSpeed.add(speedCorrection);
      }
      const nearZeroGroundSpeed = isCogOverrideActive(rawGroundSpeed, minSpeed);
      if (rawHeading.ready && (rawGroundSpeed.ready || nearZeroGroundSpeed)) {
        boatSpeedRefGround.copyFrom(correctedBoatSpeed);
        boatSpeedRefGround.rotate(rawHeading.value);
        if (wellUnderway) {
          if (rawGroundSpeed.ready) {
            rawCurrent.copyFrom(rawGroundSpeed);
          } else {
            rawCurrent.setVectorValue({ x: 0, y: 0 });
          }
          rawCurrent.substract(boatSpeedRefGround);
          smoothedCurrent.sample();
        }
        if (rawGroundSpeed.ready) {
          residual.copyFrom(rawGroundSpeed);
          residual.substract(boatSpeedRefGround);
          residual.substract(smoothedCurrent);
          smoothedResidual.sample();
        }
      }
    }
    else if (!isTwa && rawAttitude?.ready) {
      setLifecycleWarning('attitude.roll', 'incomplete', 'navigation.attitude.roll');
    }

    PolarSmoother.send(app, plugin.id, [smoothedCurrent, smoothedResidual]);
    Polar.send(app, plugin.id, [correctedBoatSpeed]);
  }

  /**
   * Updates the correction table from current smoothed inputs.
   */
  function updateTable() {
    lrnBoatSpeed.setVectorValue({ x: smoothedBoatSpeed.value, y: 0 }, { x: smoothedBoatSpeed.variance ?? 0, y: 0 });
    const learningMode = evaluateLearningMode({
      options,
      navigationState: buildNavigationStateStatus(navigationStateHandler, options.suspendLearningOnNavigationState),
      stabilizingUntil: learningStabilizingUntil,
      stabilizingReason: learningStabilizingReason,
      now: Date.now()
    });
    if (learningMode.state === 'active' && isCogOverrideActive(rawGroundSpeed, minSpeed)) {
      learningMode.state = 'suspended';
      learningMode.reason = 'cog_override';
    }

    const isTwa = table?.dimensionTwoMode === 'twa';
    const dim2Ready = isTwa
      ? Boolean(smoothedTwa && (smoothedTwa.ready || smoothedTwa.handler?.ready))
      : Boolean(smoothedAttitude && smoothedAttitude.ready && Number.isFinite(smoothedAttitude.value?.roll));

    const inputsReady = dim2Ready && smoothedBoatSpeed.ready && smoothedHeading.ready && smoothedGroundSpeed.ready;
    const currentReady = !options.assumeCurrent || smoothedCurrent.ready;
    const observationGate = evaluateObservationGate({
      learningMode,
      inputsReady,
      assumeCurrent: options.assumeCurrent,
      currentReady,
      stw: smoothedBoatSpeed.value,
      sog: smoothedGroundSpeed.magnitude,
      speedThreshold: minSpeed
    });

    if (observationGate.state !== 'pending') {
      if (observationGate.state === 'invalid') {
        setObservationStatus('rejected', observationGate.reason);
        resetLearningStabilization('observation_reset', getShortStabilizingMs(options));
      }
      return;
    }

    const dim2Val = isTwa
      ? (smoothedTwa?.handler?.value ?? smoothedTwa?.value ?? 0)
      : smoothedAttitude.value.roll;

    table.update(smoothedBoatSpeed.value, dim2Val, smoothedGroundSpeed, options.assumeCurrent ? smoothedCurrent : noCurrent, lrnBoatSpeed, smoothedHeading.value);
    if (table.lastUpdateResult === 'accepted') {
      setObservationStatus('accepted', 'accepted');
    } else if (table.lastUpdateResult === 'rejected') {
      setObservationStatus('rejected', 'estimator_outlier');
      resetLearningStabilization('observation_reset', getShortStabilizingMs(options));
    }
  }

  function loadTable(options, filePath) {
    const stability = (options.stability !== undefined) ? options.stability : 6;
    let fileData = Table2D.readFromFile(filePath);
    let table;
    if (fileData) {
      table = CorrectionTable.fromJSON(fileData, stability);
      app.debug("Correction table loaded: " + (fileData.id || filePath));
    } else if (fs.existsSync(filePath)) {
      app.error(`Correction table file exists but could not be read, retrying: ${filePath}`);
      fileData = Table2D.readFromFile(filePath);
      if (fileData) {
        table = CorrectionTable.fromJSON(fileData, stability);
        app.debug("Correction table loaded on retry: " + (fileData.id || filePath));
      } else {
        app.error(`Correction table retry failed — starting with empty table. Disk file preserved: ${filePath}`);
        const name = options.tableName || 'correctionTable';
        table = CorrectionTable.createDefault(name, 'heel', stability);
      }
    } else {
      const name = options.tableName || 'correctionTable';
      table = CorrectionTable.createDefault(name, 'heel', stability);
      app.debug("Correction table created: " + name);
    }
    table.setDisplayAttributes({ label: table.id });
    return table;
  }

  function saveTable(correctionTable, filePath) {
    correctionTable.saveToFile(filePath);
  }

  function saveTableSync(correctionTable, filePath) {
    try {
      const data = JSON.stringify(correctionTable.toJSON(), null, 2);
      fs.writeFileSync(filePath, data);
    } catch (err) {
      app.error(`Error saving correction table: ${err.message}`);
    }
  }

  function isTableEmpty(correctionTable) {
    return correctionTable.table.every(row => row.every(cell => cell.N === 0));
  }

  function applyOptionChanges() {
    const changedKeys = Object.keys(changedOptions);
    for (const key of changedKeys) {
      const value = changedOptions[key];
      options[key] = value;

      if (key === 'updateCorrectionTable') {
        if (!value && table && !isTableEmpty(table)) {
          saveTableSync(table, path.join(app.getDataDirPath(), table.id + '.json'));
          app.debug('Correction table saved: learning switched off');
        } else if (value && table && isTableEmpty(table)) {
          const filePath = path.join(app.getDataDirPath(), table.id + '.json');
          const fileData = Table2D.readFromFile(filePath);
          if (fileData) {
            const reloaded = CorrectionTable.fromJSON(fileData, options.stability || 7);
            reloaded.setDisplayAttributes({ label: reloaded.id });
            if (!isTableEmpty(reloaded)) {
              swapTable(reloaded);
              app.debug('Correction table reloaded from disk: learning switched on');
            }
          }
        }
      }
      if (key === 'estimateBoatSpeed' && !value && correctedBoatSpeed) {
        Polar.clear(app, plugin.id, [correctedBoatSpeed]);
        PolarSmoother.clear(app, plugin.id, [smoothedCurrent]);
      }

      delete changedOptions[key];
    }

    const SMOOTHER_KEYS = ['smootherClass', 'smootherTau', 'smootherTimeSpan', 'smootherSteadyState'];
    if (changedKeys.some(k => SMOOTHER_KEYS.includes(k))) {
      const { SmootherClass: SC, smootherOptions: so } = resolveSmootherConfig();
      for (const s of [smoothedHeading, smoothedBoatSpeed, smoothedGroundSpeed, smoothedTwa]) {
        if (s) { s.setSmootherClass(SC); s.setSmootherOptions(so); }
      }
      if (smoothedAttitude) { smoothedAttitude.setSmootherClass(SC); smoothedAttitude.setSmootherOptions(so); }
    }
    saveOptions();
  }

  return plugin;
};

module.exports._test = {
  normalizeNavigationState,
  getShortStabilizingMs,
  evaluateLearningMode,
  isCogOverrideActive,
  isLeewayValid,
  evaluateObservationGate,
  getDerivedObservationStatus,
  buildNavigationStateStatus,
  ALWAYS_BLOCKING_NAVIGATION_STATES,
  OPTIONAL_BLOCKING_NAVIGATION_STATES,
  LONG_STABILIZING_MS,
};

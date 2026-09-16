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

  const DEFAULT_DIMS = {
    maxSpeed: 9, speedStep: 1,
    maxHeel: 32, heelStep: 8,
    maxAngle: 180, angleStep: 15
  };

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
    dimensionTwoMode: 'heel', // 'heel', 'awa', or 'twa'
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

  function migrateConfig() {
    const obsoleteKeys = ['headingSource', 'boatSpeedSource', 'SOGSource', 'attitudeSource', 'preventDuplication', 'minSogForLearning'];
    const hadObsolete = obsoleteKeys.some(k => k in options);
    for (const k of obsoleteKeys) delete options[k];
    if (hadObsolete || (options.configVersion || 0) < 2) {
      options.configVersion = 2;
      saveOptions();
      app.debug('Config migrated to v2');
    }
  }

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
    minSpeed = table.step[0];
    if (reportFull) reportFull.setTables([table]);
    lastSave = Date.now();
  }

  let isRunning = false;
  let pluginStatus = 'Stopped';
  let smoothedHeading = null;
  let smoothedDimensionTwo = null;
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
  let rawDimensionTwo = null;
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

  function getDimensionTwoValue() {
    if (!rawDimensionTwo || !rawDimensionTwo.ready) return null;
    const mode = options.dimensionTwoMode || 'heel';
    if (mode === 'heel') {
      return rawDimensionTwo.value?.roll ?? null;
    }
    return typeof rawDimensionTwo.value === 'number' ? rawDimensionTwo.value : null;
  }

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
    description: "Speed and Current is configured through its own webapp.",
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

    router.get('/api/settings', (req, res) => {
      res.json({ ...options, ...changedOptions });
    });

    router.put('/api/settings', (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'JSON body required' });
      }
      const blocked = ['correctionTable', 'tableName'];
      for (const k of blocked) {
        if (k in body) {
          return res.status(400).json({ error: `Key '${k}' is managed via the table manager` });
        }
      }
      changedOptions = { ...changedOptions, ...body };
      res.json({ ...options, ...changedOptions });
    });

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
          if (data && data.row && data.col && Array.isArray(data.table)) {
            const name = file.replace(/\.json$/, '');
            tables.push({ name, active: name === activeName });
          }
        } catch (e) { }
      }
      res.json(tables);
    });

    router.post('/api/tables/create', (req, res) => {
      const body = req.body || {};
      const name = (body.name || '').trim();
      if (!name || !/^[\w-]+$/.test(name))
        return res.status(400).json({ error: 'Name must be alphanumeric' });

      const mode = options.dimensionTwoMode || 'heel';
      const maxDim2 = Number.isFinite(body.maxDim2) ? body.maxDim2 : (mode === 'heel' ? SI.fromDegrees(DEFAULT_DIMS.maxHeel) : Math.PI);
      const dim2Step = Number.isFinite(body.dim2Step) ? body.dim2Step : SI.fromDegrees(mode === 'heel' ? DEFAULT_DIMS.heelStep : DEFAULT_DIMS.angleStep);

      const row = { min: 0, max: body.maxSpeed || DEFAULT_DIMS.maxSpeed, step: body.speedStep || DEFAULT_DIMS.speedStep };
      const col = {
        min: mode === 'heel' ? -maxDim2 : -Math.PI,
        max: mode === 'heel' ? maxDim2 : Math.PI,
        step: dim2Step
      };

      const newTable = new CorrectionTable(name, row, col, options.stability || 7);
      newTable.setDisplayAttributes({ label: name });
      saveTable(newTable, path.join(app.getDataDirPath(), name + '.json'));
      if (isRunning) swapTable(newTable);
      saveTableName(name);
      res.json({ name });
    });

    router.post('/api/tables/load', (req, res) => {
      const body = req.body || {};
      const name = (body.name || '').trim();
      if (!name || !/^[\w-]+$/.test(name))
        return res.status(400).json({ error: 'Invalid table name' });
      const filePath = path.join(app.getDataDirPath(), name + '.json');
      const fileData = Table2D.readFromFile(filePath);
      if (!fileData) return res.status(404).json({ error: `Table '${name}' not found` });
      const loadedTable = CorrectionTable.fromJSON(fileData, options.stability || 7);
      loadedTable.setDisplayAttributes({ label: name });
      if (isRunning) swapTable(loadedTable);
      saveTableName(name);
      res.json({ name });
    });

    router.post('/api/tables/copy', (req, res) => {
      if (!isRunning || !table) return res.status(503).json({ error: 'Plugin is not running' });
      const body = req.body || {};
      const newName = (body.newName || '').trim();
      if (!newName || !/^[\w-]+$/.test(newName))
        return res.status(400).json({ error: 'Invalid name' });
      const data = table.toJSON();
      data.id = newName;
      const copiedTable = CorrectionTable.fromJSON(data, options.stability || 7);
      copiedTable.setDisplayAttributes({ label: newName });
      saveTable(copiedTable, path.join(app.getDataDirPath(), newName + '.json'));
      swapTable(copiedTable);
      saveTableName(newName);
      res.json({ name: newName });
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
    minSpeed = table.step[0];

    const { SmootherClass, smootherOptions } = resolveSmootherConfig();

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

    const dim2Mode = options.dimensionTwoMode || 'heel';
    let dim2Path = 'navigation.attitude';
    if (dim2Mode === 'awa') dim2Path = 'environment.wind.angleApparent';
    if (dim2Mode === 'twa') dim2Path = 'environment.wind.angleTrueWater';

    if (dim2Mode === 'heel') {
      smoothedDimensionTwo = createSmoothedHandler({
        app, pluginId: plugin.id,
        id: 'attitude',
        path: dim2Path,
        subscribe: true,
        SmootherClass,
        smootherOptions,
        ...buildLifecycleCallbacks(
          'attitude.smoothed',
          () => smoothedDimensionTwo?.handler?.path || dim2Path,
          () => { smoothedDimensionTwo?.unsubscribe(); smoothedDimensionTwo?.subscribe(); }
        )
      });
    } else {
      smoothedDimensionTwo = new SmoothedAngle(app, plugin.id, 'windAngle', dim2Path, {
        angleRange: '-piToPi',
        meta: { displayName: dim2Mode.toUpperCase(), plane: 'Boat' },
        SmootherClass,
        smootherOptions,
        ...buildLifecycleCallbacks(
          'windAngle.angle',
          () => smoothedDimensionTwo?.handler?.path || dim2Path,
          () => { smoothedDimensionTwo?.unsubscribe(); smoothedDimensionTwo?.subscribe(false, true); }
        )
      });
    }
    rawDimensionTwo = dim2Mode === 'heel' ? smoothedDimensionTwo.handler : smoothedDimensionTwo;

    navigationStateHandler = new MessageHandler(app, plugin.id, 'navigationState');
    navigationStateHandler.configure('navigation.state');
    navigationStateHandler.onDelta = () => { handleNavigationStateDelta(); };
    navigationStateHandler.subscribe();

    MessageHandler.setMeta(app, plugin.id, "environment.current.drift", { units: "m/s", type: "number", description: "Speed of current" });
    MessageHandler.setMeta(app, plugin.id, "environment.current.setTrue", { units: "rad", type: "number", description: "Direction of current" });
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
      displayUnits: { category: 'angle' }
    });

    smoothedBoatSpeed = createSmoothedHandler({
      app, pluginId: plugin.id,
      id: 'boatSpeed',
      path: 'navigation.speedThroughWater',
      subscribe: true,
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

        const wellUnderway = learningMode.state !== 'stabilizing';
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

    reportFull = new Reporter();

    if (options.estimateBoatSpeed) {
      reportFull.addDelta(rawHeading);
      reportFull.addAttitude(rawDimensionTwo);
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
    reportFull.addAttitude(rawDimensionTwo);
    reportFull.addDelta(smoothedBoatSpeed);
    reportFull.addPolar(smoothedGroundSpeed);
    if (options.assumeCurrent && !options.estimateBoatSpeed) {
      reportFull.addPolar(smoothedCurrent);
    }
    reportFull.addTable(table);

    isRunning = true;
    lastSave = 0;
    lastObservationState = null;
    lastObservationReason = null;
    lastNavigationStateValue = normalizeNavigationState(navigationStateHandler?.value);
    resetLearningStabilization('startup', LONG_STABILIZING_MS);
    setStatus('Running');
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
        smoothedDimensionTwo = smoothedDimensionTwo?.terminate();
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
        rawDimensionTwo = null;
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

  function correct(wellUnderway) {
    if (correctedBoatSpeed && typeof correctedBoatSpeed.setVectorValue === 'function') {
      correctedBoatSpeed.setVectorValue({ x: rawBoatSpeed.value || 0, y: 0 });
    }
    if (speedCorrection && typeof speedCorrection.setVectorValue === 'function') {
      speedCorrection.setVectorValue({ x: 0, y: 0 });
    }

    if (options.sogFallback && rawGroundSpeed.ready && rawBoatSpeed.ready && rawBoatSpeed.value === 0 && rawGroundSpeed.magnitude >= minSpeed) {
      correctedBoatSpeed.setVectorValue({ x: rawGroundSpeed.magnitude, y: 0 });
    }
    else if (rawDimensionTwo.ready) {
      const dim2Val = getDimensionTwoValue();
      if (correctedBoatSpeed.magnitude > 0 && dim2Val !== null) {
        const { correction, variance } = table.getCorrection(correctedBoatSpeed.magnitude, dim2Val);
        const leewayValid = isLeewayValid(correctedBoatSpeed.magnitude, minSpeed, navigationStateHandler);
        speedCorrection.setVectorValue(
          { x: correction.x, y: leewayValid ? correction.y : 0 },
          { x: variance?.x || 0, y: leewayValid ? (variance?.y || 0) : 0 }
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

    PolarSmoother.send(app, plugin.id, [smoothedCurrent, smoothedResidual]);
    Polar.send(app, plugin.id, [correctedBoatSpeed]);
  }

  function updateTable() {
    if (lrnBoatSpeed && typeof lrnBoatSpeed.setVectorValue === 'function') {
      lrnBoatSpeed.setVectorValue({ x: smoothedBoatSpeed.value || 0, y: 0 }, { x: smoothedBoatSpeed.variance ?? 0, y: 0 });
    }
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
    const inputsReady = smoothedDimensionTwo.ready && smoothedBoatSpeed.ready && smoothedHeading.ready && smoothedGroundSpeed.ready;
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
        resetLearningStabilization('observation_reset', getShortStabilizingMs(options));
      }
      return;
    }

    const dim2Val = getDimensionTwoValue();
    if (dim2Val !== null) {
      table.update(smoothedBoatSpeed.value, dim2Val, smoothedGroundSpeed, options.assumeCurrent ? smoothedCurrent : noCurrent, lrnBoatSpeed, smoothedHeading.value);
      if (table.lastUpdateResult === 'accepted') {
        setObservationStatus('accepted', 'accepted');
      } else if (table.lastUpdateResult === 'rejected') {
        setObservationStatus('rejected', 'estimator_outlier');
        resetLearningStabilization('observation_reset', getShortStabilizingMs(options));
      }
    }
  }

  function loadTable(options, filePath) {
    const stability = (options.stability !== undefined) ? options.stability : 6;
    let fileData = Table2D.readFromFile(filePath);
    let table;
    const mode = options.dimensionTwoMode || 'heel';

    if (fileData) {
      table = CorrectionTable.fromJSON(fileData, stability);
      app.debug("Correction table loaded: " + (fileData.id || filePath));
    } else {
      const name = options.tableName || 'correctionTable';
      const row = { min: 0, max: SI.fromKnots(DEFAULT_DIMS.maxSpeed), step: SI.fromKnots(DEFAULT_DIMS.speedStep) };
      const col = {
        min: mode === 'heel' ? -SI.fromDegrees(DEFAULT_DIMS.maxHeel) : -Math.PI,
        max: mode === 'heel' ? SI.fromDegrees(DEFAULT_DIMS.maxHeel) : Math.PI,
        step: mode === 'heel' ? SI.fromDegrees(DEFAULT_DIMS.heelStep) : SI.fromDegrees(DEFAULT_DIMS.angleStep)
      };
      table = new CorrectionTable(name, row, col, stability);
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
              app.debug('Correction table reloaded from disk');
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
      for (const s of [smoothedHeading, smoothedBoatSpeed, smoothedGroundSpeed]) {
        if (s) { s.setSmootherClass(SC); s.setSmootherOptions(so); }
      }
      if (smoothedDimensionTwo) { smoothedDimensionTwo.setSmootherClass(SC); smoothedDimensionTwo.setSmootherOptions(so); }
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

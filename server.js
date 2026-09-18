const express = require('express');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const PORT = 3000;
const HOST = '0.0.0.0';

// Ensure local data directory exists for table persistence and plugin options
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}
const configFile = path.join(dataDir, 'SpeedAndCurrent.json');

// --- Signal K Application Mock Shim ---
function createMockBus() {
  const bus = {};
  const chainMethods = [
    'onError', 'onEnd', 'skipDuplicates', 'map', 'filter', 'take', 'first',
    'toPromise', 'flatMap', 'flatMapLatest', 'merge', 'debounce',
    'debounceImmediate', 'throttle', 'delay', 'bufferWithTime', 'bufferWithCount',
    'combine', 'sampledBy', 'scan', 'fold', 'zip', 'awaiting', 'not', 'log',
    'doAction', 'doLog', 'doError', 'doEnd', 'withHandler', 'name',
    'withDescription', 'skip', 'slidingWindow', 'startWith', 'mapEnd',
    'skipWhile', 'takeWhile', 'takeUntil', 'errors', 'mapError', 'subscribe',
  ];
  for (const m of chainMethods) bus[m] = () => bus;
  bus.onValue = () => () => {};
  bus.push = () => {};
  bus.plug = () => () => {};
  bus.end = () => {};
  return bus;
}

const emitter = new EventEmitter();
const selfData = new Map();
const subscribers = new Set();
let pluginStatusString = 'Starting';

const signalKApp = {
  debug: (...args) => {
    if (process.env.DEBUG) console.log('[SignalK:debug]', ...args);
  },
  error: (...args) => {
    console.error('[SignalK:error]', ...args);
  },
  setPluginStatus: (msg) => {
    pluginStatusString = msg;
  },
  setPluginError: (msg) => {
    pluginStatusString = `Error: ${msg}`;
  },
  readPluginOptions: () => {
    try {
      if (fs.existsSync(configFile)) {
        return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      }
    } catch (e) {
      console.warn('Could not read config file, using defaults');
    }
    return {
      configuration: {
        sogFallback: true,
        estimateBoatSpeed: true,
        updateCorrectionTable: true,
        stability: 7,
        assumeCurrent: true,
        suspendLearningOnNavigationState: false,
        tableName: 'correctionTable',
        smootherClass: 'MovingAverageSmoother',
        smootherTau: 3,
        smootherTimeSpan: 5,
        smootherSteadyState: 0.2
      }
    };
  },
  savePluginOptions: (config, cb) => {
    try {
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      if (cb) cb();
    } catch (err) {
      if (cb) cb(err);
    }
  },
  getPluginOptions: () => ({}),
  getDataDirPath: () => dataDir,

  getSelfPath: (pathKey) => {
    if (selfData.has(pathKey)) {
      return { value: selfData.get(pathKey), timestamp: new Date().toISOString() };
    }
    return undefined;
  },
  getPath: (pathKey) => {
    if (selfData.has(pathKey)) {
      return { value: selfData.get(pathKey), timestamp: new Date().toISOString() };
    }
    return undefined;
  },
  getMetadata: (pathKey) => {
    const metaMap = {
      'vessels.self.navigation.headingTrue': { units: 'rad', displayName: 'Heading' },
      'vessels.self.navigation.speedThroughWater': { units: 'm/s', displayName: 'Speed through water' },
      'vessels.self.navigation.speedOverGround': { units: 'm/s', displayName: 'Speed over ground' },
      'vessels.self.navigation.courseOverGroundTrue': { units: 'rad', displayName: 'Course over ground' },
      'vessels.self.navigation.attitude': { units: 'rad', displayName: 'Attitude' },
      'vessels.self.environment.wind.angleTrueWater': { units: 'rad', displayName: 'True wind angle' },
      'vessels.self.environment.current.drift': { units: 'm/s', displayName: 'Current drift' },
      'vessels.self.environment.current.setTrue': { units: 'rad', displayName: 'Current set' },
    };
    return metaMap[pathKey] || undefined;
  },

  handleMessage: (pluginId, message) => {
    if (message && Array.isArray(message.updates)) {
      for (const update of message.updates) {
        if (Array.isArray(update.values)) {
          for (const entry of update.values) {
            selfData.set(entry.path, entry.value);
          }
        }
      }
    }
  },

  streambundle: {
    getSelfBus: () => createMockBus(),
    getBus: () => createMockBus(),
    getSelfStream: () => createMockBus(),
    getAvailablePaths: () => Array.from(selfData.keys()),
  },

  subscriptionmanager: {
    subscribe: (query, unsubscribes, errorCb, deltaCb) => {
      const sub = { query, deltaCb };
      subscribers.add(sub);
      const unsub = () => subscribers.delete(sub);
      if (Array.isArray(unsubscribes)) {
        unsubscribes.push(unsub);
      }
    }
  },

  on: emitter.on.bind(emitter),
  once: emitter.once.bind(emitter),
  emit: emitter.emit.bind(emitter),
  removeListener: emitter.removeListener.bind(emitter),
  removeAllListeners: emitter.removeAllListeners.bind(emitter),
};

// --- Live Marine Sensor Simulator ---
function dispatchDelta(values) {
  for (const item of values) {
    selfData.set(item.path, item.value);
  }
  const delta = {
    context: 'vessels.self',
    updates: [
      {
        $source: 'sensors.simulator',
        timestamp: new Date().toISOString(),
        values
      }
    ]
  };
  for (const sub of subscribers) {
    try {
      if (typeof sub.deltaCb === 'function') {
        sub.deltaCb(delta);
      }
    } catch (e) {
      // Ignore callback errors during simulation
    }
  }
  emitter.emit('delta', delta);
}

// Initial sensor values (sailing at ~6.2 knots on a port/starboard tack with ~1.1 kn current)
let simStep = 0;
function simulateSensorTick() {
  simStep++;
  const t = simStep * 0.1;
  // Natural wave oscillation
  const waveHeading = 0.85 + Math.sin(t * 0.7) * 0.04;
  const waveRoll = 0.18 + Math.sin(t * 0.9) * 0.03; // ~10.3 deg heel
  const wavePitch = 0.02 + Math.cos(t * 1.1) * 0.01;
  const stw = 3.25 + Math.sin(t * 0.5) * 0.12; // ~6.3 knots
  const sog = 3.65 + Math.sin(t * 0.5 + 0.3) * 0.14; // ~7.1 knots
  const cog = 0.91 + Math.sin(t * 0.6) * 0.03;
  const twa = 0.78 + Math.sin(t * 0.4) * 0.03; // ~45 deg close hauled

  dispatchDelta([
    { path: 'navigation.state', value: 'sailing' },
    { path: 'navigation.headingTrue', value: waveHeading },
    { path: 'navigation.attitude', value: { roll: waveRoll, pitch: wavePitch, yaw: waveHeading } },
    { path: 'environment.wind.angleTrueWater', value: twa },
    { path: 'navigation.speedThroughWater', value: stw },
    { path: 'navigation.speedOverGround', value: sog },
    { path: 'navigation.courseOverGroundTrue', value: cog },
  ]);
}

// Initialize Plugin
const pluginFactory = require('./index.js');
const plugin = pluginFactory(signalKApp);
const pluginRouter = express.Router();
plugin.registerWithRouter(pluginRouter);
try {
  plugin.start();
  console.log('Speed and Current plugin started successfully');
} catch (err) {
  console.error('Failed to start plugin:', err);
}

// Seed initial values and start interval
simulateSensorTick();
setInterval(simulateSensorTick, 1000);

// --- Express App Setup ---
const app = express();
app.use(express.json());

// Support Signal K plugin endpoints
app.use('/plugins/speedandcurrent', pluginRouter);
app.use('/plugins/SpeedAndCurrent', pluginRouter);
app.use('/api', pluginRouter);

// Serve admin manifest & stylesheet for the webapp
app.get('/admin/.vite/manifest.json', (req, res) => {
  res.json({
    'index.html': {
      file: 'admin.css',
      isEntry: true,
      css: ['admin.css']
    }
  });
});

app.get('/admin/admin.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.css'));
});

// Serve public static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/plugins/speedandcurrent', express.static(path.join(__dirname, 'public')));
app.use('/plugins/SpeedAndCurrent', express.static(path.join(__dirname, 'public')));

// Fallback to index.html (Express v5 compatible)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Speed and Current app running at http://${HOST}:${PORT}`);
});

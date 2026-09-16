router.post('/api/tables/create', (req, res) => {
  const body = req.body || {};
  const name = (body.name || '').trim();
  const mode = body.dimensionTwoMode || 'twa';

  if (!name || !/^[\w-]+$/.test(name)) {
    return res.status(400).json({ error: 'Name must be alphanumeric' });
  }

  const row = {
    min: 0,
    max: body.maxSpeed || DEFAULT_DIMS.maxSpeed,
    step: body.speedStep || DEFAULT_DIMS.speedStep
  };

  let col;
  if (mode === 'twa') {
    // 6 Signed TWA Centers: [-145°, -90°, -40°, +40°, +90°, +145°]
    const degBins = [-145, -90, -40, 40, 90, 145];
    col = {
      min: SI.fromDegrees(-180),
      max: SI.fromDegrees(180),
      step: SI.fromDegrees(15),
      bins: degBins.map(d => SI.fromDegrees(d))
    };
  } else {
    const maxHeel = body.maxDim2 || SI.fromDegrees(DEFAULT_DIMS.maxHeel);
    const heelStep = body.dim2Step || SI.fromDegrees(DEFAULT_DIMS.heelStep);
    col = { min: -maxHeel, max: maxHeel, step: heelStep };
  }

  const newTable = new CorrectionTable(name, row, col, options.stability || 7, mode);
  newTable.setDisplayAttributes({ label: name });
  saveTable(newTable, path.join(app.getDataDirPath(), name + '.json'));
  if (isRunning) swapTable(newTable);
  saveTableName(name);
  res.json({ name, dimensionTwoMode: mode });
});

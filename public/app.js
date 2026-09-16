document.getElementById('create-mode')?.addEventListener('change', (e) => {
  const isHeel = e.target.value === 'heel';
  document.getElementById('row-create-maxDim2').style.display = isHeel ? '' : 'none';
  document.getElementById('row-create-dim2Step').style.display = isHeel ? '' : 'none';
  document.getElementById('create-regime-note').style.display = isHeel ? 'none' : '';
});

document.getElementById('btn-create-confirm')?.addEventListener('click', async () => {
  modalStatus('create', '');
  const speedC = unitConverters.speed || DEFAULTS.speed;
  const angleC = unitConverters.angle || DEFAULTS.angle;
  const mode = document.getElementById('create-mode')?.value || 'twa';

  const body = {
    name: (document.getElementById('create-name')?.value || '').trim(),
    dimensionTwoMode: mode,
    maxSpeed: (speedC.invert || DEFAULTS.speed.invert)(Number(document.getElementById('create-maxSpeed')?.value)),
    speedStep: (speedC.invert || DEFAULTS.speed.invert)(Number(document.getElementById('create-speedStep')?.value)),
  };

  if (mode === 'heel') {
    body.maxDim2 = (angleC.invert || DEFAULTS.angle.invert)(Number(document.getElementById('create-maxDim2')?.value));
    body.dim2Step = (angleC.invert || DEFAULTS.angle.invert)(Number(document.getElementById('create-dim2Step')?.value));
  }

  if (!body.name) { modalStatus('create', 'Name is required.'); return; }
  try {
    const r = await apiPost('/api/tables/create', body);
    setTableName(r.name);
    closeModal('modal-create');
    await tick();
  } catch (e) { modalStatus('create', e.message); }
});

// TableRenderer — purpose-built renderer for the correction table.
// Rows = speed bins (knots), columns = heel bins (degrees) or TWA sectors (catamarans).
// Each learned cell shows factor deviation (±%) and leeway (°).
// Background encodes factor: green = paddlewheel reads slow, orange = reads fast.
// Active cell (last updated) gets a bold border; interpolation neighbours get a faint tint.

const RAD_TO_DEG = 180 / Math.PI;
const MPS_TO_KNOTS = 1.943844;

const DEFAULT_SPEED_SYMBOL = 'kn';
const DEFAULT_HEEL_SYMBOL  = '°';

const TWA_SECTORS = [
  'Port Downwind',
  'Port Reaching',
  'Port Upwind',
  'Stbd Upwind',
  'Stbd Reaching',
  'Stbd Downwind'
];

const TWA_ANGLES = [
  '>120°',
  '60°–120°',
  '<60°',
  '<60°',
  '60°–120°',
  '>120°'
];

const TWA_LABELS = [
  'Port Downwind (>120°)',
  'Port Reaching (60°–120°)',
  'Port Upwind (<60°)',
  'Stbd Upwind (<60°)',
  'Stbd Reaching (60°–120°)',
  'Stbd Downwind (>120°)'
];

function fmtSpeed(mps)  { return (mps * MPS_TO_KNOTS).toFixed(1); }
function fmtHeel(rad)   { const d = Math.round(rad * RAD_TO_DEG); return (d === 0 ? '0' : d.toString()); }
function fmtFactor(f)   { const p = (f - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }
function fmtLeeway(rad) { const d = Math.round(rad * RAD_TO_DEG); if (d === 0) return '0°'; return (d > 0 ? '+' : '') + d + '°'; }

/**
 * Classifies a heel angle into its sailing point (Upwind, Reaching, Downwind).
 * In monohulls:
 * - High heel angles occur when beating close-hauled (Upwind).
 * - Moderate heel angles occur on a beam/broad reach (Reaching).
 * - Near-zero heel occurs when sailing flat before the wind (Downwind).
 */
function getHeelSector(rad, minRad, maxRad) {
  const deg = rad * RAD_TO_DEG;
  const absDeg = Math.abs(deg);
  const minBound = Number.isFinite(minRad) ? minRad : -0.5585;
  const maxBound = Number.isFinite(maxRad) ? maxRad : 0.5585;
  const maxAbsDeg = Math.max(Math.abs(minBound * RAD_TO_DEG), Math.abs(maxBound * RAD_TO_DEG)) || 32;

  // Center / flat bin (near zero heel) is Downwind
  if (absDeg < Math.max(3, maxAbsDeg * 0.18)) {
    return 'Downwind';
  }

  const prefix = deg < 0 ? 'Port ' : 'Stbd ';
  // High heel is Upwind
  if (absDeg >= maxAbsDeg * 0.52) {
    return prefix + 'Upwind';
  }
  // Intermediate heel is Reaching
  return prefix + 'Reaching';
}

/**
 * Classifies a True Wind Angle (TWA) bin into its sailing point.
 */
function getTwaSector(rad) {
  const deg = rad * RAD_TO_DEG;
  const absDeg = Math.abs(deg);
  const prefix = deg < 0 ? 'Port ' : 'Stbd ';

  if (absDeg >= 120) return prefix + 'Downwind';
  if (absDeg <= 60)  return prefix + 'Upwind';
  return prefix + 'Reaching';
}

function getTwaAngleLabel(rad) {
  const deg = rad * RAD_TO_DEG;
  const absDeg = Math.abs(deg);
  if (absDeg >= 120) return '>120°';
  if (absDeg <= 60)  return '<60°';
  return '60°–120°';
}

class TableRenderer {

  // opts.fmtSpeed / opts.fmtHeel: optional unit-aware formatter functions.
  // Fall back to the module-level fmtSpeed / fmtHeel when not provided.
  render(data, opts = {}) {
    const { id, row, col, table } = data;
    if (!table || !Array.isArray(table) || table.length === 0) return document.createElement('div');

    const isTwa = data.dimensionTwoMode === 'twa'
      || (Array.isArray(col?.bins) && col.bins.length > 0)
      || (table[0] && table[0].length === 6 && !col?.step);

    const maxDev = this._computeMaxDev(table);
    const fmtSpeedFn  = opts.fmtSpeed    || fmtSpeed;
    const fmtHeelFn   = opts.fmtHeel     || fmtHeel;
    const speedSymbol = opts.speedSymbol || DEFAULT_SPEED_SYMBOL;
    const heelSymbol  = opts.heelSymbol  || DEFAULT_HEEL_SYMBOL;
    const cornerText  = isTwa ? `${speedSymbol} / TWA` : `${speedSymbol} / ${heelSymbol}`;

    const el = document.createElement('table');
    el.id = id;
    el.classList.add('Table2D');
    el.appendChild(this._headerRow(col, cornerText, fmtHeelFn, isTwa, table[0]?.length || 6));

    const tbody = document.createElement('tbody');
    const minR = Number.isFinite(row?.min) ? row.min : 0;
    const stepR = Number.isFinite(row?.step) ? row.step : 0.5144;
    for (let rIndex = 0; rIndex < table.length; rIndex++) {
      const r = minR + rIndex * stepR;
      tbody.appendChild(this._dataRow(r, rIndex, table, maxDev, fmtSpeedFn));
    }
    el.appendChild(tbody);
    return el;
  }

  _headerRow(col, cornerText, fmtHeelFn, isTwa, numCols) {
    const thead = document.createElement('thead');
    const rowSectors = document.createElement('tr');
    const rowAngles  = document.createElement('tr');

    const th0 = document.createElement('th');
    th0.textContent = cornerText;
    th0.rowSpan = 2;
    th0.classList.add('TableRowHeader', 'TableCorner');
    rowSectors.appendChild(th0);

    if (isTwa) {
      const hasBins = Array.isArray(col?.bins) && col.bins.length === numCols;
      for (let c = 0; c < numCols; c++) {
        const sector = hasBins ? getTwaSector(col.bins[c]) : (TWA_SECTORS[c] || `Bin ${c + 1}`);
        const angle  = hasBins ? getTwaAngleLabel(col.bins[c]) : (TWA_ANGLES[c] || `Sector ${c + 1}`);

        const thSec = document.createElement('th');
        thSec.textContent = sector;
        thSec.classList.add('TablecolumnHeader', 'TableSectorHeader');
        rowSectors.appendChild(thSec);

        const thAng = document.createElement('th');
        thAng.textContent = angle;
        thAng.classList.add('TablecolumnHeader');
        thAng.title = `${sector} (${angle})`;
        rowAngles.appendChild(thAng);
      }
    } else {
      const minC  = Number.isFinite(col?.min)  ? col.min  : -0.5585;
      const maxC  = Number.isFinite(col?.max)  ? col.max  : 0.5585;
      const stepC = Number.isFinite(col?.step) ? col.step : 0.1396;

      const heelValues = [];
      for (let c = minC; c <= maxC + 0.001; c += stepC) {
        heelValues.push(c);
      }

      // Group consecutive columns by sailing sector (Upwind, Reaching, Downwind)
      const colSectors = heelValues.map(v => getHeelSector(v, minC, maxC));
      const sectorGroups = [];
      for (let i = 0; i < colSectors.length; i++) {
        const sec = colSectors[i];
        if (sectorGroups.length > 0 && sectorGroups[sectorGroups.length - 1].sector === sec) {
          sectorGroups[sectorGroups.length - 1].colspan++;
        } else {
          sectorGroups.push({ sector: sec, colspan: 1 });
        }
      }

      for (const grp of sectorGroups) {
        const thSec = document.createElement('th');
        thSec.textContent = grp.sector;
        thSec.colSpan = grp.colspan;
        thSec.classList.add('TablecolumnHeader', 'TableSectorHeader');
        rowSectors.appendChild(thSec);
      }

      for (let i = 0; i < heelValues.length; i++) {
        const val = heelValues[i];
        const thAng = document.createElement('th');
        thAng.textContent = fmtHeelFn(val);
        thAng.classList.add('TablecolumnHeader');
        thAng.title = `${colSectors[i]} (${fmtHeelFn(val)})`;
        rowAngles.appendChild(thAng);
      }
    }

    thead.appendChild(rowSectors);
    thead.appendChild(rowAngles);
    return thead;
  }

  _dataRow(r, rIndex, table, maxDev, fmtSpeedFn) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = fmtSpeedFn(r);
    th.classList.add('TableRowHeader');
    tr.appendChild(th);

    const rowCells = table[rIndex] || [];
    for (let cIndex = 0; cIndex < rowCells.length; cIndex++) {
      tr.appendChild(this._cellElement(rowCells[cIndex], maxDev));
    }
    return tr;
  }

  _cellElement(cell, maxDev) {
    const td = document.createElement('td');
    td.classList.add('TableCell');

    if (!cell || cell.N === 0) {
      td.classList.add('cell--empty');
      return td;
    }

    const factor = Number.isFinite(cell.factor) ? cell.factor : null;
    const leeway = Number.isFinite(cell.leeway) ? cell.leeway : null;

    if (factor !== null) {
      const d = document.createElement('div');
      d.className = 'cell-factor';
      d.textContent = fmtFactor(factor);
      td.appendChild(d);
      const color = this._factorColor(factor, maxDev);
      if (leeway !== null) {
        const angleDeg = 90 + leeway * RAD_TO_DEG * 1;
        td.style.background = `repeating-linear-gradient(
          ${angleDeg}deg,
          ${color} 0px, ${color} 9px,
          #f0f0f0 9px, #f0f0f0 10px
        )`;
      } else {
        td.style.backgroundColor = color;
      }
    }
    if (leeway !== null) {
      const d = document.createElement('div');
      d.className = 'cell-leeway';
      d.textContent = fmtLeeway(leeway);
      td.appendChild(d);
    }

    const attrs = cell.displayAttributes;
    if (attrs?.selected)            td.classList.add('cell--active');
    else if (attrs?.normWeight > 0) td.classList.add('cell--neighbour');

    return td;
  }

  // Find the largest absolute factor deviation from 1 to normalise the color scale.
  _computeMaxDev(table) {
    let maxDev = 0;
    for (const row of table) {
      for (const cell of row) {
        if (!cell || cell.N === 0 || !Number.isFinite(cell.factor)) continue;
        const dev = Math.abs(cell.factor - 1);
        if (dev > maxDev) maxDev = dev;
      }
    }
    return maxDev || 0.05; // avoid a fully white table when all factors are near 1
  }

  // factor < 1: paddlewheel reads fast → white→orange
  // factor > 1: paddlewheel reads slow → white→green
  _factorColor(factor, maxDev) {
    if (!Number.isFinite(factor)) return '';
    const dev = factor - 1;
    if (Math.abs(dev) < 1e-6) return '';
    const a = Math.min(1, Math.abs(dev) / maxDev);
    if (dev < 0) {
      return `rgb(255,${Math.round(255 - 90 * a)},${Math.round(255 * (1 - a))})`; // white→orange
    } else {
      return `rgb(${Math.round(255 * (1 - a))},${Math.round(255 - 95 * a)},${Math.round(255 - 175 * a)})`; // white→green
    }
  }
}

export default TableRenderer;

// TableRenderer — purpose-built renderer for the correction table.
// Rows = speed bins (knots), columns = heel bins (degrees) or TWA sectors (catamarans).
// Each learned cell shows factor deviation (±%) and leeway (°).
// Background encodes factor: green = paddlewheel reads slow, orange = reads fast.
// Active cell (last updated) gets a bold border; interpolation neighbours get a faint tint.

const RAD_TO_DEG = 180 / Math.PI;
const MPS_TO_KNOTS = 1.943844;

const DEFAULT_SPEED_SYMBOL = 'kn';
const DEFAULT_HEEL_SYMBOL  = '°';

const TWA_LABELS = [
  'Port Downwind (>120°)',
  'Port Reach (60°–120°)',
  'Port Upwind (<60°)',
  'Stbd Upwind (<60°)',
  'Stbd Reach (60°–120°)',
  'Stbd Downwind (>120°)'
];

function fmtSpeed(mps)  { return (mps * MPS_TO_KNOTS).toFixed(1); }
function fmtHeel(rad)   { return (rad * RAD_TO_DEG).toFixed(0); }
function fmtFactor(f)   { const p = (f - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }
function fmtLeeway(rad) { const d = rad * RAD_TO_DEG; return (d >= 0 ? '+' : '') + d.toFixed(0) + '°'; }

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

    const minR = Number.isFinite(row?.min) ? row.min : 0;
    const stepR = Number.isFinite(row?.step) ? row.step : 0.5144;
    for (let rIndex = 0; rIndex < table.length; rIndex++) {
      const r = minR + rIndex * stepR;
      el.appendChild(this._dataRow(r, rIndex, table, maxDev, fmtSpeedFn));
    }
    return el;
  }

  _headerRow(col, cornerText, fmtHeelFn, isTwa, numCols) {
    const tr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.textContent = cornerText;
    th0.classList.add('TableRowHeader', 'TableCorner');
    tr.appendChild(th0);

    if (isTwa) {
      for (let c = 0; c < numCols; c++) {
        const th = document.createElement('th');
        th.textContent = TWA_LABELS[c] || `Bin ${c + 1}`;
        th.classList.add('TablecolumnHeader');
        tr.appendChild(th);
      }
    } else {
      const minC = Number.isFinite(col?.min) ? col.min : -0.5585;
      const maxC = Number.isFinite(col?.max) ? col.max : 0.5585;
      const stepC = Number.isFinite(col?.step) ? col.step : 0.1396;
      for (let c = minC; c <= maxC + 0.01; c += stepC) {
        const th = document.createElement('th');
        th.textContent = fmtHeelFn(c);
        th.classList.add('TablecolumnHeader');
        tr.appendChild(th);
      }
    }
    return tr;
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

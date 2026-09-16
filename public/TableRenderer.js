const RAD_TO_DEG = 180 / Math.PI;
const MPS_TO_KNOTS = 1.943844;

const DEFAULT_SPEED_SYMBOL = 'kn';
const DEFAULT_HEEL_SYMBOL  = '°';
function fmtSpeed(mps)  { return (mps * MPS_TO_KNOTS).toFixed(1); }
function fmtHeel(rad)   { return (rad * RAD_TO_DEG).toFixed(0); }
function fmtFactor(f)   { const p = (f - 1) * 100; return (p >= 0 ? '+' : '') + p.toFixed(1) + '%'; }
function fmtLeeway(rad) { const d = rad * RAD_TO_DEG; return (d >= 0 ? '+' : '') + d.toFixed(0) + '°'; }

class TableRenderer {
  render(data, opts = {}) {
    const { id, row, col, table } = data;
    const maxDev = this._computeMaxDev(table);
    const fmtSpeedFn  = opts.fmtSpeed    || fmtSpeed;
    const fmtHeelFn   = opts.fmtHeel     || fmtHeel;
    const speedSymbol = opts.speedSymbol || DEFAULT_SPEED_SYMBOL;
    const heelSymbol  = opts.heelSymbol  || DEFAULT_HEEL_SYMBOL;
    const dim2Mode    = opts.dim2Mode    || 'heel';

    let dim2Title = 'Heel';
    if (dim2Mode === 'awa') dim2Title = 'AWA';
    if (dim2Mode === 'twa') dim2Title = 'TWA';

    const cornerText = `${speedSymbol} / ${dim2Title} (${heelSymbol})`;

    const el = document.createElement('table');
    el.id = id;
    el.classList.add('Table2D');
    el.appendChild(this._headerRow(col, cornerText, fmtHeelFn, table));

    for (let rIndex = 0; rIndex < table.length; rIndex++) {
      const rVal = row.min + rIndex * row.step;
      el.appendChild(this._dataRow(rVal, rIndex, col, table, maxDev, fmtSpeedFn));
    }
    return el;
  }

  _headerRow(col, cornerText, fmtHeelFn, table) {
    const tr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.textContent = cornerText;
    th0.classList.add('TableRowHeader', 'TableCorner');
    tr.appendChild(th0);

    const numCols = table[0] ? table[0].length : 0;
    for (let cIndex = 0; cIndex < numCols; cIndex++) {
      const cVal = col.min + cIndex * col.step;
      const th = document.createElement('th');
      th.textContent = fmtHeelFn(cVal);
      th.classList.add('TablecolumnHeader');
      tr.appendChild(th);
    }
    return tr;
  }

  _dataRow(rVal, rIndex, col, table, maxDev, fmtSpeedFn) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = fmtSpeedFn(rVal);
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
    if (attrs?.selected)          td.classList.add('cell--active');
    else if (attrs?.normWeight > 0) td.classList.add('cell--neighbour');

    return td;
  }

  _computeMaxDev(table) {
    let maxDev = 0;
    for (const row of table) {
      for (const cell of row) {
        if (!cell || cell.N === 0 || !Number.isFinite(cell.factor)) continue;
        const dev = Math.abs(cell.factor - 1);
        if (dev > maxDev) maxDev = dev;
      }
    }
    return maxDev || 0.05;
  }

  _factorColor(factor, maxDev) {
    if (!Number.isFinite(factor)) return '';
    const dev = factor - 1;
    if (Math.abs(dev) < 1e-6) return '';
    const a = Math.min(1, Math.abs(dev) / maxDev);
    if (dev < 0) {
      return `rgb(255,${Math.round(255 - 90 * a)},${Math.round(255 * (1 - a))})`;
    } else {
      return `rgb(${Math.round(255 * (1 - a))},${Math.round(255 - 95 * a)},${Math.round(255 - 175 * a)})`;
    }
  }
}

export default TableRenderer;

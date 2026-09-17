// TableRenderer — purpose-built renderer for the correction table.

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
    if (!data || !data.table) return document.createElement('div');

    const { id, row, col, table } = data;
    const maxDev = this._computeMaxDev(table);
    const fmtSpeedFn  = opts.fmtSpeed    || fmtSpeed;
    const fmtHeelFn   = opts.fmtHeel     || fmtHeel;
    const speedSymbol = opts.speedSymbol || DEFAULT_SPEED_SYMBOL;
    const heelSymbol  = opts.heelSymbol  || DEFAULT_HEEL_SYMBOL;
    const cornerText  = `${speedSymbol} / ${heelSymbol}`;

    const el = document.createElement('table');
    if (id) el.id = id;
    el.classList.add('Table2D');
    el.appendChild(this._headerRow(col, cornerText, fmtHeelFn, table));

    const numCols = table[0] ? table[0].length : 0;
    const hasBins = Array.isArray(col?.bins) && col.bins.length === numCols;

    let rIndex = 0;
    for (let r = row.min; r <= row.max + 0.01; r += row.step) {
      if (!table[rIndex]) break;
      el.appendChild(this._dataRow(r, rIndex, col, table, maxDev, fmtSpeedFn, hasBins));
      rIndex++;
    }

    const container = document.getElementById('table-container');
    if (container) {
      container.innerHTML = '';
      container.appendChild(el);
    }

    return el;
  }

  _headerRow(col, cornerText, fmtHeelFn, table) {
    const tr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.textContent = cornerText;
    th0.classList.add('TableRowHeader', 'TableCorner');
    tr.appendChild(th0);

    const numCols = table && table[0] ? table[0].length : 0;
    const isTwa6Bin = numCols === 6 || (Array.isArray(col?.bins) && col.bins.length === 6);

    if (isTwa6Bin) {
      const twaLabels = [
        'Port Downwind (>120°)',
        'Port Reach (60°–120°)',
        'Port Upwind (<60°)',
        'Stbd Upwind (<60°)',
        'Stbd Reach (60°–120°)',
        'Stbd Downwind (>120°)'
      ];

      for (let cIndex = 0; cIndex < numCols; cIndex++) {
        const th = document.createElement('th');
        th.textContent = twaLabels[cIndex] || `Bin ${cIndex + 1}`;
        th.classList.add('TablecolumnHeader');
        tr.appendChild(th);
      }
    } else {
      for (let c = col.min; c <= col.max + 0.01; c += col.step) {
        const th = document.createElement('th');
        th.textContent = fmtHeelFn(c);
        th.classList.add('TablecolumnHeader');
        tr.appendChild(th);
      }
    }
    return tr;
  }

  _dataRow(r, rIndex, col, table, maxDev, fmtSpeedFn, hasBins) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.textContent = fmtSpeedFn(r);
    th.classList.add('TableRowHeader');
    tr.appendChild(th);

    const rowCells = table[rIndex] || [];
    if (hasBins || rowCells.length === 6) {
      for (let cIndex = 0; cIndex < rowCells.length; cIndex++) {
        tr.appendChild(this._cellElement(rowCells[cIndex], maxDev));
      }
    } else {
      let cIndex = 0;
      for (let c = col.min; c <= col.max + 0.01; c += col.step) {
        if (cIndex >= rowCells.length) break;
        tr.appendChild(this._cellElement(rowCells[cIndex], maxDev));
        cIndex++;
      }
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
    if (!Array.isArray(table)) return 0.05;
    for (const row of table) {
      if (!Array.isArray(row)) continue;
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

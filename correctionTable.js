const { Table2D } = require('signalkutilities');
const { KalmanFilter, State } = require('kalman-filter');

class CorrectionTable extends Table2D {
  static fromJSON(data, stability) {
    const table = new CorrectionTable(data.id, data.row, data.col, stability, data.dimensionTwoMode || 'twa');
    table.table = data.table.map(row => row.map(cellData => CorrectionEstimator.fromJSON(cellData, stability)));
    return table;
  }

  constructor(id, row, col, stability = 5, dimensionTwoMode = 'twa') {
    super(id, row, col, CorrectionEstimator, CorrectionEstimator.getFilterModel(stability));
    this.dimensionTwoMode = dimensionTwoMode;
    this.lastUpdatedCell = null;
    this.lastUpdateResult = null;
    this.neighbours = [];
  }

  getCell(rowVal, colVal) {
    if (!this.table || this.table.length === 0) return null;
    let rIdx = Math.floor((rowVal - this.min[0]) / this.step[0]);
    rIdx = Math.max(0, Math.min(rIdx, this.table.length - 1));
    const targetRow = this.table[rIdx] || [];

    let cIdx = 0;
    if (this.dimensionTwoMode === 'twa' && Array.isArray(this.col.bins)) {
      const deg = colVal * (180 / Math.PI);
      const isStarboard = deg >= 0;
      const absDeg = Math.abs(deg);

      if (absDeg < 60) {
        cIdx = isStarboard ? 3 : 2; // Upwind (+40° / -40°)
      } else if (absDeg <= 120) {
        cIdx = isStarboard ? 4 : 1; // Reaching (+90° / -90°)
      } else {
        cIdx = isStarboard ? 5 : 0; // Downwind (+145° / -145°)
      }
    } else {
      cIdx = Math.floor((colVal - this.min[1]) / this.step[1]);
      cIdx = Math.max(0, Math.min(cIdx, targetRow.length - 1));
    }

    return targetRow[cIdx] || null;
  }

  report() {
    const baseReport = super.report ? super.report() : {};
    return {
      ...baseReport,
      id: this.id,
      dimensionTwoMode: this.dimensionTwoMode,
      row: { min: this.min[0], max: this.max[0], step: this.step[0] },
      col: {
        min: this.min[1],
        max: this.max[1],
        step: this.step[1],
        bins: this.col.bins || null
      },
      table: (this.table || []).map((row, rowIndex) =>
        (row || []).map((correction, colIndex) => {
          const cellReport = correction.report();
          const speedBin = this.min[0] + this.step[0] * rowIndex;
          const dim2Bin = (Array.isArray(this.col.bins) && this.col.bins[colIndex] !== undefined)
            ? this.col.bins[colIndex]
            : (this.min[1] + this.step[1] * colIndex);

          const forward = speedBin + cellReport.x;
          const factor = speedBin > 0 ? forward / speedBin : null;
          const leeway = (forward > 0 && cellReport.N > 0) ? Math.atan2(cellReport.y, forward) : null;

          cellReport.forward = forward;
          cellReport.factor = factor;
          cellReport.leeway = leeway;
          cellReport.speedBin = speedBin;
          cellReport.heelBin = dim2Bin;
          cellReport.displayAttributes = {
            selected: correction === this.lastUpdatedCell
          };
          return cellReport;
        })
      )
    };
  }

  toJSON() {
    const json = super.toJSON ? super.toJSON() : {};
    return {
      ...json,
      id: this.id,
      dimensionTwoMode: this.dimensionTwoMode,
      row: this.row,
      col: this.col,
      table: this.table
    };
  }
}

module.exports = { CorrectionTable };

const { Table2D } = require('signalkutilities');
const { KalmanFilter, State } = require('kalman-filter');

const DEG_TO_RAD = Math.PI / 180;
const DEFAULT_TWA_BINS_DEG = [-145, -90, -40, 40, 90, 145];
const DEFAULT_TWA_BINS = DEFAULT_TWA_BINS_DEG.map(d => d * DEG_TO_RAD);

function normalizeAngleDiff(angle1, angle2) {
  let diff = angle1 - angle2;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return Math.abs(diff);
}

// Module-level helpers — avoids creating new Function objects on every Kalman update call
function _rotateValue(cos, sin, vector) {
  return [
     cos * vector[0] + sin * vector[1],
    -sin * vector[0] + cos * vector[1]
  ];
}

function _rotateVariance(cos, sin, vector) {
  return [
    [vector[0] * cos ** 2 + vector[1] * sin ** 2, (vector[0] - vector[1]) * cos * sin],
    [(vector[0] - vector[1]) * cos * sin,          vector[0] * sin ** 2 + vector[1] * cos ** 2]
  ];
}

class CorrectionTable extends Table2D {
  /**
   * Represents a 2D correction table for boat speed and heel (monohulls) or true wind angle (catamarans).
   */

  static fromJSON(data, stability = 5) {
    if (!data || !Array.isArray(data.table) || data.table.length === 0) return null;

    const numCols = data.table[0]?.length || 0;
    const isTwa = data.dimensionTwoMode === 'twa'
      || (Array.isArray(data.col?.bins) && data.col.bins.length > 0)
      || (numCols === 6 && !data.col?.step);

    const mode = isTwa ? 'twa' : 'heel';
    const row = (data.row && Number.isFinite(data.row.min) && Number.isFinite(data.row.step))
      ? data.row
      : { min: 0, max: (data.table.length - 1) * 0.5144, step: 0.5144 };

    let col = data.col;
    if (isTwa) {
      const bins = Array.isArray(col?.bins) && col.bins.length > 0 ? col.bins : DEFAULT_TWA_BINS;
      col = {
        min: col?.min ?? bins[0],
        max: col?.max ?? bins[bins.length - 1],
        step: col?.step ?? ((bins[bins.length - 1] - bins[0]) / (bins.length - 1)),
        bins
      };
    } else if (!col || !Number.isFinite(col.min) || !Number.isFinite(col.step)) {
      col = { min: -0.5585, max: 0.5585, step: 0.1396 };
    }

    const table = new CorrectionTable(data.id || 'correctionTable', row, col, stability, mode);
    table.table = data.table.map(r => r.map(cellData => CorrectionEstimator.fromJSON(cellData, stability)));
    return table;
  }

  static createDefault(name = 'correctionTable', mode = 'heel', stability = 6) {
    const row = { min: 0, max: 9 * 0.514444, step: 1 * 0.514444 };
    if (mode === 'twa') {
      const col = {
        min: DEFAULT_TWA_BINS[0],
        max: DEFAULT_TWA_BINS[5],
        step: (DEFAULT_TWA_BINS[5] - DEFAULT_TWA_BINS[0]) / 5,
        bins: DEFAULT_TWA_BINS
      };
      return new CorrectionTable(name, row, col, stability, 'twa');
    }
    const col = { min: -32 * DEG_TO_RAD, max: 32 * DEG_TO_RAD, step: 8 * DEG_TO_RAD };
    return new CorrectionTable(name, row, col, stability, 'heel');
  }

  /**
   * Resample an existing table onto a new grid conservatively.
   */
  static resample(oldTable, newRow, newCol, stability = 5, varianceFloor = 1e-4) {
    const isTwa = oldTable.dimensionTwoMode === 'twa';
    const newTable = new CorrectionTable(oldTable.id, newRow, newCol, stability, oldTable.dimensionTwoMode);

    const nRows = Math.round((newRow.max - newRow.min) / newRow.step) + 1;
    const nCols = isTwa
      ? (newTable.col.bins?.length || 6)
      : Math.round((newCol.max - newCol.min) / newCol.step) + 1;

    for (let i = 0; i < nRows; i++) {
      const speed = newRow.min + i * newRow.step;
      for (let j = 0; j < nCols; j++) {
        const dim2Val = isTwa
          ? newTable.col.bins[j]
          : (newCol.min + j * newCol.step);

        const { correction, variance } = oldTable.getCorrection(speed, dim2Val);

        const mean = [[(correction?.x ?? 0)], [(correction?.y ?? 0)]];
        const covXX = Math.max(Number.isFinite(variance?.x) ? variance.x : 0, varianceFloor);
        const covYY = Math.max(Number.isFinite(variance?.y) ? variance.y : 0, varianceFloor);
        const covariance = [[covXX, 0], [0, covYY]];

        const inBounds = isTwa
          ? (speed >= (oldTable.row?.min ?? 0) && speed <= (oldTable.row?.max ?? Infinity))
          : (
            Array.isArray(oldTable.min) && Array.isArray(oldTable.max) &&
            speed >= oldTable.min[0] && speed <= oldTable.max[0] &&
            dim2Val >= oldTable.min[1] && dim2Val <= oldTable.max[1]
          );

        let supportCount = 0;
        let effectiveN = 0;
        if (Array.isArray(oldTable.neighbours)) {
          for (const n of oldTable.neighbours) {
            const N = n?.cell?.N || 0;
            if (N > 0) supportCount++;
            const w = Number.isFinite(n?.normWeight) ? n.normWeight : 0;
            effectiveN += w * N;
          }
        }
        const index = (inBounds && supportCount >= 2 && effectiveN >= 1) ? 1 : 0;
        newTable.table[i][j].filterState = new State({ mean, covariance, index });
      }
    }
    newTable.setDisplayAttributes({ label: "correction table" });
    return newTable;
  }

  /**
   * Convenience to resample from serialized JSON table data
   */
  static resampleFromJSON(data, newRow, newCol, stability = 5, varianceFloor = 1e-4) {
    const oldTable = CorrectionTable.fromJSON(data, stability);
    return CorrectionTable.resample(oldTable, newRow, newCol, stability, varianceFloor);
  }

  constructor(id, row, col, stability = 5, dimensionTwoMode = 'heel') {
    const isTwa = dimensionTwoMode === 'twa';
    const safeRow = (row && Number.isFinite(row.min) && Number.isFinite(row.max) && Number.isFinite(row.step))
      ? row
      : { min: 0, max: 9, step: 1 };

    let safeCol;
    if (isTwa) {
      const bins = Array.isArray(col?.bins) && col.bins.length > 0 ? col.bins : DEFAULT_TWA_BINS;
      safeCol = {
        min: col?.min ?? bins[0],
        max: col?.max ?? bins[bins.length - 1],
        step: col?.step ?? ((bins[bins.length - 1] - bins[0]) / (bins.length - 1)),
        bins
      };
    } else {
      safeCol = (col && Number.isFinite(col.min) && Number.isFinite(col.max) && Number.isFinite(col.step))
        ? col
        : { min: -0.5585, max: 0.5585, step: 0.1396 };
    }

    super(id, safeRow, safeCol, CorrectionEstimator, CorrectionEstimator.getFilterModel(stability));
    this.dimensionTwoMode = isTwa ? 'twa' : 'heel';
    this.row = safeRow;
    this.col = safeCol;
    this.lastUpdatedCell = null;
    this.lastUpdateResult = null;
    this.neighbours = [];
  }

  getCellIndex(speed, heelOrTwa) {
    if (!this.table || this.table.length === 0) return { r: 0, c: 0 };
    const minR = (this.row && Number.isFinite(this.row.min)) ? this.row.min : 0;
    const stepR = (this.row && Number.isFinite(this.row.step)) ? this.row.step : 0.5144;
    let rIdx = Math.floor((speed - minR) / stepR);
    rIdx = Math.max(0, Math.min(rIdx, this.table.length - 1));

    let cIdx = 0;
    if (this.dimensionTwoMode === 'twa') {
      const bins = Array.isArray(this.col?.bins) ? this.col.bins : DEFAULT_TWA_BINS;
      let minDiff = Infinity;
      bins.forEach((binRad, idx) => {
        const diff = normalizeAngleDiff(heelOrTwa, binRad);
        if (diff < minDiff) {
          minDiff = diff;
          cIdx = idx;
        }
      });
    } else {
      const minC = (this.col && Number.isFinite(this.col.min)) ? this.col.min : 0;
      const stepC = (this.col && Number.isFinite(this.col.step)) ? this.col.step : 0.1396;
      cIdx = Math.floor((heelOrTwa - minC) / stepC);
      cIdx = Math.max(0, Math.min(cIdx, (this.table[rIdx]?.length || 1) - 1));
    }

    return { r: rIdx, c: cIdx };
  }

  getCell(speed, heelOrTwa) {
    const { r, c } = this.getCellIndex(speed, heelOrTwa);
    const cell = this.table[r]?.[c] || null;
    if (cell) {
      cell.r = r;
      cell.c = c;
    }
    return cell;
  }
  
  update(speed, heelOrTwa, groundSpeed, current, boatSpeed, heading) {
    const cell = this.getCell(speed, heelOrTwa);
    const accepted = cell?.update(groundSpeed, current, boatSpeed, heading);
    this.lastUpdatedCell = cell;
    this.lastUpdateResult = accepted === true ? 'accepted' : 'rejected';
  }

  getCorrection(speed, heelOrTwa) {
    if (this.dimensionTwoMode === 'twa') {
      const bins = Array.isArray(this.col?.bins) ? this.col.bins : DEFAULT_TWA_BINS;
      const candidates = [];
      const stepR = (this.row && Number.isFinite(this.row.step)) ? this.row.step : 0.5144;
      const minR = (this.row && Number.isFinite(this.row.min)) ? this.row.min : 0;
      const avgBinStepRad = (bins[bins.length - 1] - bins[0]) / (bins.length - 1);

      this.table.forEach((rowCells, rIdx) => {
        const rSpeed = minR + rIdx * stepR;
        const normDistR = (speed - rSpeed) / stepR;

        rowCells.forEach((cell, cIdx) => {
          const binRad = bins[cIdx] ?? 0;
          const normDistC = normalizeAngleDiff(heelOrTwa, binRad) / avgBinStepRad;
          const dist = Math.sqrt(normDistR ** 2 + normDistC ** 2);
          candidates.push({ cell, dist });
        });
      });

      candidates.sort((a, b) => a.dist - b.dist);
      this.neighbours = candidates.slice(0, 5);
    } else {
      this.neighbours = this.findClosest(speed, heelOrTwa, 5);
    }

    if (this.neighbours.length === 0) return { correction: { x: 0, y: 0 }, variance: null };

    let x = 0;
    let y = 0;
    let varX = 0;
    let varY = 0;
    let totalWeight = 0;
    for (const neighbour of this.neighbours) {
      const { cell: correction, dist } = neighbour;
      if (correction.N > 0) {
        const weight = 1 / (dist + 1e-6); 
        neighbour.normWeight = weight;
        x += correction.x * weight;
        y += correction.y * weight;
        varX += correction.covariance[0][0] * weight ** 2;
        varY += correction.covariance[1][1] * weight ** 2;
        totalWeight += weight;
      }
    }
    if (totalWeight > 0) {
      for (const neighbour of this.neighbours) {
        neighbour.normWeight /= totalWeight;
      }
    }

    if (totalWeight === 0) return { correction: { x: 0, y: 0 }, variance: { x: 0, y: 0 } };

    const tw2 = totalWeight * totalWeight;
    x /= totalWeight;
    y /= totalWeight;
    varX /= tw2;
    varY /= tw2;
    this.totalWeight = totalWeight;

    return { correction: { x, y }, variance: { x: varX, y: varY } };
  }
  
  report() {
    const isTwa = this.dimensionTwoMode === 'twa';
    const bins = isTwa && Array.isArray(this.col?.bins) ? this.col.bins : null;
    return {
      id: this.id,
      dimensionTwoMode: this.dimensionTwoMode,
      row: this.row || { min: this.min[0], max: this.max[0], step: this.step[0] },
      col: this.col || { min: this.min[1], max: this.max[1], step: this.step[1] },
      table: this.table.map((row, rowIndex) =>
        row.map((correction, colIndex) => {
          const cellReport = correction.report();
          const speedBin = (this.row?.min ?? this.min[0]) + (this.row?.step ?? this.step[0]) * rowIndex;
          const colBin = (isTwa && bins)
            ? bins[colIndex]
            : ((this.col?.min ?? this.min[1]) + (this.col?.step ?? this.step[1]) * colIndex);

          const forward = speedBin + cellReport.x;
          const factor = speedBin > 0 ? forward / speedBin : null;
          const leeway = (forward > 0 && cellReport.N > 0) ? Math.atan2(cellReport.y, forward) : null;
          let trace = null;
          if (cellReport.N > 0) {
            const cov = correction.covariance;
            if (cov && Array.isArray(cov) && cov[0] && cov[1] && Number.isFinite(cov[0][0]) && Number.isFinite(cov[1][1])) {
              trace = cov[0][0] + cov[1][1];
            }
          }
          cellReport.forward = forward;
          cellReport.factor = factor;
          cellReport.leeway = leeway;
          cellReport.trace = trace;
          cellReport.speedBin = speedBin;
          if (isTwa) {
            cellReport.twaBin = colBin;
            cellReport.heelBin = 0;
          } else {
            cellReport.heelBin = colBin;
          }
          cellReport.displayAttributes = {
            selected: correction === this.lastUpdatedCell
          };
          const found = this.neighbours.find(n => n.cell === correction);
          cellReport.displayAttributes.normWeight = found ? found.normWeight : 0;
          return cellReport;
        })
      ),
      displayAttributes: this.displayAttributes,
      lastUpdateResult: this.lastUpdateResult ?? null
    };
  }

  toJSON() {
    return {
      id: this.id,
      dimensionTwoMode: this.dimensionTwoMode,
      row: this.row,
      col: this.col,
      table: this.table
    };
  }
}

class CorrectionEstimator {
  /**
   * Represents a Kalman correction at a cell in a correction table
   */

  static fromJSON(data, stability = 5) {
    const filterModel = CorrectionEstimator.getFilterModel(stability);
    return new CorrectionEstimator(filterModel, data ? data.state : null);
  }

  static getFilterModel(stability = 5) {
    return {
      observation: {
        stateProjection: [[1, 0], [0, 1]], // observation matrix H
        covariance: [[1, 0], [0, 1]], // measurement noise R
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]], // state transition matrix F
        covariance: [1 / (10 ** stability), 1 / (10 ** stability)], // process noise covariance matrix Q
      }
    };
  }

  constructor(filterModel, initialState) {
    this.filter = new KalmanFilter(filterModel);
    this.filterState = null;
    if (initialState != null) {
      this.filterState = new State(initialState);
    }
  }
  
  update(groundSpeed, current, boatSpeed, heading) {
    if (groundSpeed.xVariance == null || groundSpeed.yVariance == null ||
        current.xVariance == null || current.yVariance == null ||
        boatSpeed.xVariance == null || boatSpeed.yVariance == null) {
       return false;
    }
    // Rotation matrix for -theta
    const cosTheta = Math.cos(heading);
    const sinTheta = Math.sin(heading);

    const groundVector = _rotateValue(cosTheta, sinTheta, groundSpeed.vector);
    const currentVector = _rotateValue(cosTheta, sinTheta, current.vector);
    const boatVector = boatSpeed.vector;

    const observation = [
      -boatVector[0] + groundVector[0] - currentVector[0],
      -boatVector[1] + groundVector[1] - currentVector[1]
    ];

    const groundCov = _rotateVariance(cosTheta, sinTheta, groundSpeed.variance);
    const currentCov = _rotateVariance(cosTheta, sinTheta, current.variance);
    const boatCov = [[boatSpeed.xVariance, 0], [0, boatSpeed.yVariance]];

    const observationCovariance = [
      [groundCov[0][0] + currentCov[0][0] + boatCov[0][0], groundCov[0][1] + currentCov[0][1] + boatCov[0][1]],
      [groundCov[1][0] + currentCov[1][0] + boatCov[1][0], groundCov[1][1] + currentCov[1][1] + boatCov[1][1]]
    ];

    // Mahalanobis distance check against prior
    const DIFFUSE_PRIOR_VAR = 1.0; // (m/s)²
    const priorMean = this.filterState !== null
      ? [this.filterState.mean[0][0], this.filterState.mean[1][0]]
      : [0, 0];
    const priorCov = this.filterState !== null
      ? this.filterState.covariance
      : [[DIFFUSE_PRIOR_VAR, 0], [0, DIFFUSE_PRIOR_VAR]];
    const inno = [observation[0] - priorMean[0], observation[1] - priorMean[1]];
    const S = [
      [priorCov[0][0] + observationCovariance[0][0], priorCov[0][1] + observationCovariance[0][1]],
      [priorCov[1][0] + observationCovariance[1][0], priorCov[1][1] + observationCovariance[1][1]]
    ];
    const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    if (Number.isFinite(det) && det > 1e-12) {
      const Sinv = [
        [ S[1][1] / det, -S[0][1] / det],
        [-S[1][0] / det,  S[0][0] / det]
      ];
      const d2 = inno[0] * (Sinv[0][0] * inno[0] + Sinv[0][1] * inno[1])
               + inno[1] * (Sinv[1][0] * inno[0] + Sinv[1][1] * inno[1]);
      if (d2 > 9.21) return false;
    }
    this.filterState = this.filter.filter({ previousCorrected: this.filterState, observation, observationCovariance });
    return true;
  }

  report() {
    return { x: this.x, y: this.y, N: this.N };
  }

  get N() {
    return this.filterState != null ? this.filterState.index : 0;
  }

  get x() {
    return this.filterState != null ? this.filterState.mean[0][0] : 0;
  }

  get y() {
    return this.filterState != null ? this.filterState.mean[1][0] : 0;
  }

  get covariance() {
    return this.filterState != null ? this.filterState.covariance : null;
  }

  toJSON() {
    return this.N !== 0 ? { state: this.filterState } : { state: null };
  }
}

module.exports = { CorrectionTable, CorrectionEstimator };

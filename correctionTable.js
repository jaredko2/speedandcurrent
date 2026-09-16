const { Table2D } = require('signalkutilities');
const { KalmanFilter, State } = require('kalman-filter');

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
  static fromJSON(data, stability) {
    const table = new CorrectionTable(data.id, data.row, data.col, stability);
    table.table = data.table.map(row => row.map(cellData => CorrectionEstimator.fromJSON(cellData, stability)));
    return table;
  }

  static resample(oldTable, newRow, newCol, stability = 5, varianceFloor = 1e-4) {
    const newTable = new CorrectionTable(oldTable.id, newRow, newCol, stability);

    const nRows = Math.round((newRow.max - newRow.min) / newRow.step) + 1;
    const nCols = Math.round((newCol.max - newCol.min) / newCol.step) + 1;

    for (let i = 0; i < nRows; i++) {
      const speed = newRow.min + i * newRow.step;
      for (let j = 0; j < nCols; j++) {
        const dim2 = newCol.min + j * newCol.step;

        const { correction, variance } = oldTable.getCorrection(speed, dim2);

        const mean = [[(correction?.x ?? 0)], [(correction?.y ?? 0)]];
        const covXX = Math.max(Number.isFinite(variance?.x) ? variance.x : 0, varianceFloor);
        const covYY = Math.max(Number.isFinite(variance?.y) ? variance.y : 0, varianceFloor);
        const covariance = [[covXX, 0], [0, covYY]];

        const inBounds = (
          speed >= oldTable.min[0] && speed <= oldTable.max[0] &&
          dim2  >= oldTable.min[1] && dim2  <= oldTable.max[1]
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
        if (newTable.table[i] && newTable.table[i][j]) {
          newTable.table[i][j].filterState = new State({ mean, covariance, index });
        }
      }
    }
    newTable.setDisplayAttributes({ label: "correction table" });
    return newTable;
  }

  static resampleFromJSON(data, newRow, newCol, stability = 5, varianceFloor = 1e-4) {
    const oldTable = CorrectionTable.fromJSON(data, stability);
    return CorrectionTable.resample(oldTable, newRow, newCol, stability, varianceFloor);
  }

  constructor(id, row, col, stability=5) {
    super(id, row, col, CorrectionEstimator, CorrectionEstimator.getFilterModel(stability));
    this.lastUpdatedCell = null;
    this.lastUpdateResult = null;
    this.neighbours = [];
  }
  
  getCell(rowVal, colVal) {
    if (!this.table || this.table.length === 0) return null;
    let rIdx = Math.floor((rowVal - this.min[0]) / this.step[0]);
    let cIdx = Math.floor((colVal - this.min[1]) / this.step[1]);

    // Array Index Clamping
    rIdx = Math.max(0, Math.min(rIdx, this.table.length - 1));
    const targetRow = this.table[rIdx] || [];
    cIdx = Math.max(0, Math.min(cIdx, targetRow.length - 1));

    return targetRow[cIdx] || null;
  }

  update(speed, dim2Val, groundSpeed, current, boatSpeed, heading) {
    const cell = this.getCell(speed, dim2Val);
    if (!cell) {
      this.lastUpdateResult = 'rejected';
      return;
    }
    const accepted = cell.update(groundSpeed, current, boatSpeed, heading);
    this.lastUpdatedCell = cell;
    this.lastUpdateResult = accepted === true ? 'accepted' : 'rejected';
  }

  getCorrection(speed, dim2Val) {
    this.neighbours = this.findClosest(speed, dim2Val, 5);
    if (this.neighbours.length === 0) return { correction: {x: 0, y: 0}, variance: null };

    let x = 0;
    let y = 0;
    let varX = 0;
    let varY = 0;
    let totalWeight = 0;
    for (const neighbour of this.neighbours) {
      const { cell:correction, dist } = neighbour;
      if (correction && correction.N > 0) {
        const weight = 1 / (dist + 1e-6); 
        neighbour.normWeight = weight;
        x += correction.x * weight;
        y += correction.y * weight;
        if (correction.covariance) {
          varX += correction.covariance[0][0] * weight ** 2;
          varY += correction.covariance[1][1] * weight ** 2;
        }
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
    return {
      id: this.id,
      row: { min: this.min[0], max: this.max[0], step: this.step[0] },
      col: { min: this.min[1], max: this.max[1], step: this.step[1] },
      table: (this.table || []).map((row, rowIndex) =>
        (row || []).map((correction, colIndex) => {
          const cellReport = correction.report();
          const speedBin = this.min[0] + this.step[0] * rowIndex;
          const dim2Bin = this.min[1] + this.step[1] * colIndex;
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
          cellReport.heelBin = dim2Bin;
          cellReport.displayAttributes = {
            selected: correction === this.lastUpdatedCell
          };
          const found = this.neighbours.find(n => n.cell === correction);
          if (found) {
            cellReport.displayAttributes.normWeight = found.normWeight;
          } else {
            cellReport.displayAttributes.normWeight = 0;
          }
          return cellReport;
        })
      ),
      displayAttributes: this.displayAttributes,
      lastUpdateResult: this.lastUpdateResult ?? null
    };
  }
}

class CorrectionEstimator {
  static fromJSON(data, stability) {
    const filterModel = CorrectionEstimator.getFilterModel(stability);
    const estimator = new CorrectionEstimator(filterModel, data.state);
    return estimator;
  }

  static getFilterModel(stability = 5) {
    return {
      observation: {
        stateProjection: [[1, 0], [0, 1]],
        covariance: [[1, 0], [0, 1]],
        dimension: 2
      },
      dynamic: {
        transition: [[1, 0], [0, 1]],
        covariance: [1/10**stability, 1/10**stability],
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
    if (!groundSpeed || !current || !boatSpeed ||
        groundSpeed.xVariance == null || groundSpeed.yVariance == null ||
        current.xVariance == null || current.yVariance == null ||
        boatSpeed.xVariance == null || boatSpeed.yVariance == null) {
       return false;
    }
    const cosTheta = Math.cos(heading);
    const sinTheta = Math.sin(heading);

    var groundVector = _rotateValue(cosTheta, sinTheta, groundSpeed.vector);
    var currentVector = _rotateValue(cosTheta, sinTheta, current.vector);
    var boatVector = boatSpeed.vector;

    const observation = [
      -boatVector[0] + groundVector[0] - currentVector[0],
      -boatVector[1] + groundVector[1] - currentVector[1]
    ];

    var groundCov = _rotateVariance(cosTheta, sinTheta, groundSpeed.variance);
    var currentCov = _rotateVariance(cosTheta, sinTheta, current.variance);
    var boatCov = [[boatSpeed.xVariance, 0], [0, boatSpeed.yVariance]];

    const observationCovariance = [[
      groundCov[0][0] + currentCov[0][0] + boatCov[0][0],
      groundCov[0][1] + currentCov[0][1] + boatCov[0][1]],
    [
      groundCov[1][0] + currentCov[1][0] + boatCov[1][0],
      groundCov[1][1] + currentCov[1][1] + boatCov[1][1]],
    ];

    const DIFFUSE_PRIOR_VAR = 1.0;
    const priorMean = this.filterState !== null
      ? [this.filterState.mean[0][0], this.filterState.mean[1][0]]
      : [0, 0];
    const priorCov = this.filterState !== null
      ? this.filterState.covariance
      : [[DIFFUSE_PRIOR_VAR, 0], [0, DIFFUSE_PRIOR_VAR]];
    const inno = [observation[0] - priorMean[0], observation[1] - priorMean[1]];
    const S = [
      [priorCov[0][0] + observationCovariance[0][0],
       priorCov[0][1] + observationCovariance[0][1]],
      [priorCov[1][0] + observationCovariance[1][0],
       priorCov[1][1] + observationCovariance[1][1]]
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
    if (this.filterState == null) return 0;
    return this.filterState.index;
  }

  get x() {
    if (this.filterState == null) return 0;
    return this.filterState.mean[0][0];
  }

  get y() {
    if (this.filterState == null) return 0;
    return this.filterState.mean[1][0];
  }

  get covariance() {
    return this.filterState ? this.filterState.covariance : null;
  }

  toJSON() {
    return this.N !== 0 ? { state: this.filterState } : { state: null };
  }
}

module.exports = { CorrectionTable };

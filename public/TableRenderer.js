_headerRow(col, cornerText, fmtHeelFn, table) {
    const tr = document.createElement('tr');
    const th0 = document.createElement('th');
    th0.textContent = cornerText;
    th0.classList.add('TableRowHeader', 'TableCorner');
    tr.appendChild(th0);

    const numCols = table[0] ? table[0].length : 0;
    const hasExplicitBins = Array.isArray(col.bins) && col.bins.length === numCols;

    for (let cIndex = 0; cIndex < numCols; cIndex++) {
      const cVal = hasExplicitBins ? col.bins[cIndex] : (col.min + cIndex * col.step);
      const th = document.createElement('th');
      
      if (hasExplicitBins) {
        const deg = Math.round(cVal * (180 / Math.PI));
        const absDeg = Math.abs(deg);
        let label = `${deg}°`;
        if (absDeg === 40)  label = `${deg}° (Upwind)`;
        if (absDeg === 90)  label = `${deg}° (Reach)`;
        if (absDeg === 145) label = `${deg}° (Downwind)`;
        th.textContent = label;
      } else {
        th.textContent = fmtHeelFn(cVal);
      }
      
      th.classList.add('TablecolumnHeader');
      tr.appendChild(th);
    }
    return tr;
  }

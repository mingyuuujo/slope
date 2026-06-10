/**
 * DXF→GSZ 지오메트리 보정 — slope_gui.py 이식
 */

export function snapCoordGridXY(x, y, grid) {
  if (grid == null || grid <= 0) return [x, y];
  const g = grid;
  return [Math.round(x / g) * g, Math.round(y / g) * g];
}

export function dedupeConsecutivePolyXY(poly) {
  const out = [];
  for (const [x, y] of poly) {
    const fx = Number(x),
      fy = Number(y);
    if (
      !out.length ||
      Math.abs(out[out.length - 1][0] - fx) > 1e-12 ||
      Math.abs(out[out.length - 1][1] - fy) > 1e-12
    ) {
      out.push([fx, fy]);
    }
  }
  if (
    out.length >= 2 &&
    Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-12 &&
    Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-12
  ) {
    out.pop();
  }
  return out;
}

export function mergeCoincidentVertices(coords, eps) {
  if (!coords.length) return [];
  const n = coords.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = Array(n).fill(0);

  function find(a) {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }
  function union(a, b) {
    let ra = find(a),
      rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra] += 1;
    }
  }

  const grid = new Map();
  const eps2 = eps * eps;
  for (let i = 0; i < n; i++) {
    const x = coords[i][0],
      y = coords[i][1];
    const cx = Math.floor(x / eps);
    const cy = Math.floor(y / eps);
    for (const gx of [cx - 1, cx, cx + 1]) {
      for (const gy of [cy - 1, cy, cy + 1]) {
        const key = `${gx},${gy}`;
        const bucket = grid.get(key);
        if (!bucket) continue;
        for (const j of bucket) {
          const dx = x - coords[j][0];
          const dy = y - coords[j][1];
          if (dx * dx + dy * dy <= eps2) union(i, j);
        }
      }
    }
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }

  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(i);
  }
  const out = new Array(n);
  for (const idxs of clusters.values()) {
    const sx = idxs.reduce((s, k) => s + coords[k][0], 0) / idxs.length;
    const sy = idxs.reduce((s, k) => s + coords[k][1], 0) / idxs.length;
    for (const k of idxs) out[k] = [sx, sy];
  }
  return out;
}

export function collapseRingPointIds(pids) {
  if (!pids.length) return [];
  const out = [];
  for (const p of pids) {
    if (!out.length || out[out.length - 1] !== p) out.push(p);
  }
  while (out.length >= 2 && out[0] === out[out.length - 1]) out.pop();
  return out;
}

export function pointSegmentDistanceSqClamped(px, py, ax, ay, bx, by) {
  const abx = bx - ax,
    aby = by - ay;
  const lab2 = abx * abx + aby * aby;
  if (lab2 < 1e-24) return [(px - ax) ** 2 + (py - ay) ** 2, 0];
  let te = ((px - ax) * abx + (py - ay) * aby) / lab2;
  let cx, cy;
  if (te <= 0) {
    cx = ax;
    cy = ay;
    te = 0;
  } else if (te >= 1) {
    cx = bx;
    cy = by;
    te = 1;
  } else {
    cx = ax + te * abx;
    cy = ay + te * aby;
  }
  const dsq = (px - cx) ** 2 + (py - cy) ** 2;
  return [dsq, te];
}

export function collectRingVerticesUnique(rings) {
  const out = [];
  const seen = new Set();
  for (const ring of rings) {
    for (const [x, y] of ring) {
      const k = `${Math.round(x * 1e9) / 1e9},${Math.round(y * 1e9) / 1e9}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push([Number(x), Number(y)]);
      }
    }
  }
  return out;
}

export function enumerateRingSegments(rings) {
  const segs = [];
  for (const ring of rings) {
    const n = ring.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) segs.push([ring[i], ring[(i + 1) % n]]);
  }
  return segs;
}

export function segSegInteriorIntersection(a, b, c, d, eps = 1e-10) {
  const [ax, ay] = a,
    [bx, by] = b,
    [cx, cy] = c,
    [dx, dy] = d;
  const rx = bx - ax,
    ry = by - ay;
  const sx = dx - cx,
    sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-14) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (eps < t && t < 1 - eps && eps < u && u < 1 - eps) {
    return [ax + t * rx, ay + t * ry];
  }
  return null;
}

export function pairwiseInteriorIntersections(rings) {
  const segs = enumerateRingSegments(rings);
  const pts = [];
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const [c, d] = segs[j];
      const p = segSegInteriorIntersection(a, b, c, d);
      if (p) pts.push(p);
    }
  }
  return pts;
}

export function mergeCandidatePoints(vertexPts, crossPts) {
  const out = [];
  const seen = new Set();
  for (const [px, py] of [...vertexPts, ...crossPts]) {
    const k = `${Math.round(px * 1e8) / 1e8},${Math.round(py * 1e8) / 1e8}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push([Number(px), Number(py)]);
    }
  }
  return out;
}

export function topologyRefineRings(rings, tol, maxIter) {
  if (!rings.length) return [rings, 0];
  const tol2 = tol * tol;
  const epsT = 1e-7;
  const epEnd2 = 1e-16;

  let cur = rings.map((r) => r.map((p) => [p[0], p[1]]));
  let usedIter = 0;

  for (let iteration = 0; iteration < maxIter; iteration++) {
    usedIter = iteration + 1;
    const candidates = mergeCandidatePoints(
      collectRingVerticesUnique(cur),
      pairwiseInteriorIntersections(cur),
    );
    let changed = false;
    const nxt = [];
    for (const ring of cur) {
      if (ring.length < 3) {
        nxt.push(ring);
        continue;
      }
      const nn = ring.length;
      const out = [];
      for (let ii = 0; ii < nn; ii++) {
        const ax = ring[ii][0],
          ay = ring[ii][1];
        const bx = ring[(ii + 1) % nn][0],
          by = ring[(ii + 1) % nn][1];
        out.push([ax, ay]);
        const inserts = [];
        for (const [px, py] of candidates) {
          const va = (px - ax) ** 2 + (py - ay) ** 2;
          const vb = (px - bx) ** 2 + (py - by) ** 2;
          if (va <= epEnd2 || vb <= epEnd2) continue;
          const [dsq, te] = pointSegmentDistanceSqClamped(px, py, ax, ay, bx, by);
          if (dsq <= tol2 && epsT < te && te < 1 - epsT) inserts.push([te, px, py]);
        }
        inserts.sort((a, b) => a[0] - b[0]);
        let prevTe = 0;
        for (const [te, px, py] of inserts) {
          if (te > prevTe + 1e-7) {
            out.push([px, py]);
            prevTe = te;
            changed = true;
          }
        }
      }
      let refined = dedupeConsecutivePolyXY(out);
      if (refined.length < 3) refined = [...ring];
      nxt.push(refined);
    }
    cur = nxt;
    if (!changed) break;
  }
  return [cur, usedIter];
}

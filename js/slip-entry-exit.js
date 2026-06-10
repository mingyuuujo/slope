/**
 * SlipEntryExit (좌·우 미끄럼 진입 **구간**) — NO.17 과 같이 `<LeftOption>` 없이
 * LeftSideLeftPt / LeftSideRightPt / LeftInc + 오른쪽 2점 + RightInc 패턴.
 */
import {
  findSlopeItemsRoot,
  allChildEl,
  firstChildEl,
  removeAllChildren,
  createEl,
} from "./xml-utils.js";
import { dedupeConsecutivePolyXY, snapCoordGridXY } from "./geometry.js";
import { COORD_GRID_SNAP, VERTEX_MERGE_EPS } from "./constants.js";

function fmtAttr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  let s = n.toFixed(8).replace(/\.?0+$/, "").replace(/\.$/, "");
  if (s === "" || s === "-") s = "0";
  return s === "-0" ? "0" : s;
}

function insertAfter(parent, refChild, newChild) {
  if (!refChild) {
    parent.insertBefore(newChild, parent.firstChild);
    return;
  }
  if (refChild.nextSibling) parent.insertBefore(newChild, refChild.nextSibling);
  else parent.appendChild(newChild);
}

/** Region 매핑에 쓰이는 레이어만, 각 폴리곤 스냅·중복점 제거 (mapping.js 과 동일 1차 처리). */
function collectProcessedRings(dxfLayers, geometryLayers) {
  const rings = [];
  for (const [layer, polys] of Object.entries(dxfLayers)) {
    if (!geometryLayers.has(layer)) continue;
    for (const poly of polys || []) {
      let ring = dedupeConsecutivePolyXY(poly);
      if (COORD_GRID_SNAP && COORD_GRID_SNAP > 0) {
        ring = ring.map(([x, y]) => snapCoordGridXY(x, y, COORD_GRID_SNAP));
        ring = dedupeConsecutivePolyXY(ring);
      }
      if (ring.length >= 3) rings.push(ring);
    }
  }
  return rings;
}

function crossingYInteriorSegment(ax, ay, bx, by) {
  const dx = bx - ax;
  if (Math.abs(dx) < 1e-18) return null;
  if (!((ax < 0 && bx > 0) || (ax > 0 && bx < 0))) return null;
  const t = (0 - ax) / dx;
  const tol = 1e-14;
  if (t <= tol || t >= 1 - tol) return null;
  return ay + t * (by - ay);
}

/** 링 각 변·꼭짓점(x≈0)에서 x=0 근처 높이 수집 */
function ysAtVerticalAxisFromRing(ring) {
  const eps = VERTEX_MERGE_EPS;
  const ys = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [xa, ya] = ring[i];
    if (Math.abs(xa) < eps) ys.push(ya);
    const [xb, yb] = ring[(i + 1) % n];
    const cy = crossingYInteriorSegment(xa, ya, xb, yb);
    if (cy != null && Number.isFinite(cy)) ys.push(cy);
  }
  return ys;
}

/**
 * DXF → SlipEntryExit **범위** 모델:
 * - 왼쪽 사용자 정의 점① (0, x=0에서 최대 Y) · 점② (xmin열에서 최대 Y)
 * - 오른쪽 점① (0, 동일) · 점② (xmax열에서 최대 Y)
 *
 * 태그는 X 오름차순으로 두 점 배치(NO.17: 왼쪽은 작은 X가 LeftSideLeftPt).
 */
export function computeSlipEntryExitFromDxf(dxfLayers, geometryLayersSet) {
  const rings = collectProcessedRings(dxfLayers, geometryLayersSet);
  if (!rings.length) return null;
  /** @type {{x:number,y:number}[]} */
  const verts = [];
  for (const ring of rings) {
    for (const [x, y] of ring) verts.push({ x: Number(x), y: Number(y) });
  }
  if (!verts.length) return null;

  let xmin = Infinity;
  let xmax = -Infinity;
  for (const v of verts) {
    xmin = Math.min(xmin, v.x);
    xmax = Math.max(xmax, v.x);
  }
  const xBand = VERTEX_MERGE_EPS;
  const ymaxAtColumnMin = verts.filter((v) => Math.abs(v.x - xmin) < xBand);
  const ymaxAtColumnMax = verts.filter((v) => Math.abs(v.x - xmax) < xBand);
  const yAtMinXColumn = ymaxAtColumnMin.length
    ? Math.max(...ymaxAtColumnMin.map((v) => v.y))
    : verts[0].y;
  const yAtMaxXColumn = ymaxAtColumnMax.length
    ? Math.max(...ymaxAtColumnMax.map((v) => v.y))
    : verts[0].y;

  const ysAxis = [];
  for (const ring of rings) ysAxis.push(...ysAtVerticalAxisFromRing(ring));
  let yOnAxisMax = ysAxis.length > 0 ? Math.max(...ysAxis) : null;
  if (yOnAxisMax == null) {
    let bestAbs = Infinity;
    let bestY = verts[0].y;
    for (const v of verts) {
      const ax = Math.abs(v.x);
      if (ax < bestAbs) {
        bestAbs = ax;
        bestY = v.y;
      }
    }
    yOnAxisMax = bestY;
  }

  const ptAtAxis = { x: 0, y: yOnAxisMax };
  const ptAtXminCol = { x: xmin, y: yAtMinXColumn };
  const ptAtXmaxCol = { x: xmax, y: yAtMaxXColumn };

  /** 좌·우 구간 끝점은 X 좌표 오름차순 (NO.17 패턴과 동일) */
  const leftSideLeftPt = ptAtXminCol.x <= ptAtAxis.x ? ptAtXminCol : ptAtAxis;
  const leftSideRightPt = ptAtXminCol.x <= ptAtAxis.x ? ptAtAxis : ptAtXminCol;
  const rightSideLeftPt = ptAtAxis.x <= ptAtXmaxCol.x ? ptAtAxis : ptAtXmaxCol;
  const rightSideRightPt = ptAtAxis.x <= ptAtXmaxCol.x ? ptAtXmaxCol : ptAtAxis;

  return {
    leftSideLeftPt,
    leftSideRightPt,
    rightSideLeftPt,
    rightSideRightPt,
    leftInc: 20,
    rightInc: 20,
    radiusInc: 20,
  };
}

function setPtAttrs(el, xy) {
  el.setAttribute("X", fmtAttr(xy.x));
  el.setAttribute("Y", fmtAttr(xy.y));
}

/** 모든 SlopeItem/Entry 에 SlipEntryExit 동기화 (범위 모드, LeftOption 미사용). */
export function applySlipEntryExitToAllSlopeItems(
  doc,
  computed,
  log = () => {},
) {
  if (!computed) {
    log("  경고: SlipEntryExit — DXF 에서 진입점 산출 실패, 생략");
    return;
  }
  const root = findSlopeItemsRoot(doc);
  if (!root) {
    log("  경고: SlopeItems 없음 — SlipEntryExit 생략");
    return;
  }
  const items = allChildEl(root, "SlopeItem");
  if (!items.length) {
    log("  경고: SlopeItem 없음 — SlipEntryExit 생략");
    return;
  }

  let n = 0;
  for (const si of items) {
    let entry = firstChildEl(si, "Entry");
    if (!entry) {
      entry = doc.createElement("Entry");
      si.appendChild(entry);
    }
    let see = firstChildEl(entry, "SlipEntryExit");
    if (!see) {
      see = doc.createElement("SlipEntryExit");
      const grid = firstChildEl(entry, "SlipSurfaceGrid");
      if (grid) insertAfter(entry, grid, see);
      else {
        const dp = firstChildEl(entry, "DataPoints");
        if (dp) insertAfter(entry, dp, see);
        else entry.insertBefore(see, entry.firstChild);
      }
    }
    removeAllChildren(see);

    let p = doc.createElement("LeftSideLeftPt");
    setPtAttrs(p, computed.leftSideLeftPt);
    see.appendChild(p);

    p = doc.createElement("LeftSideRightPt");
    setPtAttrs(p, computed.leftSideRightPt);
    see.appendChild(p);

    see.appendChild(createEl(doc, "LeftInc", String(computed.leftInc)));

    p = doc.createElement("RightSideLeftPt");
    setPtAttrs(p, computed.rightSideLeftPt);
    see.appendChild(p);

    p = doc.createElement("RightSideRightPt");
    setPtAttrs(p, computed.rightSideRightPt);
    see.appendChild(p);

    see.appendChild(createEl(doc, "RightInc", String(computed.rightInc)));
    see.appendChild(createEl(doc, "RadiusInc", String(computed.radiusInc)));
    n++;
  }

  root.setAttribute("Len", String(items.length));
  log(
    `  SlipEntryExit(범위) → ${n}개 해석 · Left [${fmtAttr(computed.leftSideLeftPt.x)},${fmtAttr(computed.leftSideLeftPt.y)}]–[` +
      `${fmtAttr(computed.leftSideRightPt.x)},${fmtAttr(computed.leftSideRightPt.y)}] · Right [` +
      `${fmtAttr(computed.rightSideLeftPt.x)},${fmtAttr(computed.rightSideLeftPt.y)}]–[` +
      `${fmtAttr(computed.rightSideRightPt.x)},${fmtAttr(computed.rightSideRightPt.y)}]` +
      ` LeftInc=${computed.leftInc} RightInc=${computed.rightInc}`,
  );
}

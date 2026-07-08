/**
 * DXF 닫힌 폴리선 → GeoStudio Slope/W Points/Regions 변환 (JS 이식)
 * dxf_to_geostudio.py 의 핵심 로직을 브라우저에서 실행 가능하도록 포팅.
 *
 * 외부 의존:
 *   - convertDxfParsed() : dxf-parser 파싱 결과 객체를 받음
 *   - exportGeoStudioExcel() : 전역 ExcelJS (vendor/exceljs.min.js) 사용
 */

export const DEFAULT_CONFIG = {
  coordinateTolerance: 1e-5,
  coordinateDecimals: 5,
  pointIdStart: 1,
  skipClosingDuplicate: true,
  removeConsecutiveDuplicates: true,
  layerFilter: null,          // null = 모든 레이어
  requireClosed: true,
  pointLabel: "Point+Number",
  pointPinned: "No",
  regionType: "Domain Polygon",
  pointsSheetName: "Points",
  regionsSheetName: "Regions",
};

// ---------------------------------------------------------------------------
// 좌표 유틸
// ---------------------------------------------------------------------------
function roundCoord(v, dec) {
  const f = 10 ** dec;
  return Math.round(v * f) / f;
}

function findPointIndex(x, y, coords, tol) {
  for (let i = 0; i < coords.length; i++) {
    const [cx, cy] = coords[i];
    if (Math.hypot(x - cx, y - cy) <= tol) return i;
  }
  return null;
}

function dedupeConsecutiveVertices(verts, tol) {
  if (!verts.length) return { verts: [], removed: 0 };
  const result = [verts[0]];
  let removed = 0;
  for (let i = 1; i < verts.length; i++) {
    const [px, py] = result[result.length - 1];
    const [x, y] = verts[i];
    if (Math.hypot(x - px, y - py) <= tol) {
      removed++;
    } else {
      result.push(verts[i]);
    }
  }
  return { verts: result, removed };
}

function normalizeVertices(verts, tol, skipClosing, removeConsecutive) {
  if (verts.length < 3) return { verts: [...verts], removed: 0 };

  let result = [...verts];
  let removed = 0;

  if (removeConsecutive) {
    const r = dedupeConsecutiveVertices(result, tol);
    result = r.verts;
    removed += r.removed;
  }

  if (skipClosing && result.length >= 2) {
    const [x0, y0] = result[0];
    const [xl, yl] = result[result.length - 1];
    if (Math.hypot(x0 - xl, y0 - yl) <= tol) {
      result.pop();
      removed++;
    }
  }

  return { verts: result, removed };
}

function dedupeConsecutiveIds(ids) {
  if (!ids.length) return { ids: [], removed: 0 };
  const result = [ids[0]];
  let removed = 0;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] === result[result.length - 1]) {
      removed++;
    } else {
      result.push(ids[i]);
    }
  }
  return { ids: result, removed };
}

function finalizeRegionPointIds(ids, cfg) {
  if (!cfg.removeConsecutiveDuplicates) return { ids, removed: 0 };
  const r = dedupeConsecutiveIds(ids);
  let result = r.ids;
  let removed = r.removed;
  if (result.length >= 2 && result[0] === result[result.length - 1]) {
    result.pop();
    removed++;
  }
  return { ids: result, removed };
}

// ---------------------------------------------------------------------------
// PointRegistry
// ---------------------------------------------------------------------------
class PointRegistry {
  constructor(cfg) {
    this._cfg = cfg;
    this._coords = [];
    this._ids = [];
    this._nextId = cfg.pointIdStart;
  }

  register(x, y) {
    const tol = this._cfg.coordinateTolerance;
    const dec = this._cfg.coordinateDecimals;
    const xr = roundCoord(x, dec);
    const yr = roundCoord(y, dec);
    const idx = findPointIndex(xr, yr, this._coords, tol);
    if (idx !== null) return this._ids[idx];
    const id = this._nextId++;
    this._coords.push([xr, yr]);
    this._ids.push(id);
    return id;
  }

  allPoints() {
    return this._coords
      .map(([x, y], i) => ({ id: this._ids[i], x, y }))
      .sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------------------
// DXF 파싱 결과에서 폴리선 추출
// ---------------------------------------------------------------------------
function extractPolylines(dxf, cfg) {
  const ents = dxf.entities || [];
  const result = [];

  for (const ent of ents) {
    if (ent.type !== "LWPOLYLINE" && ent.type !== "POLYLINE") continue;

    if (cfg.layerFilter != null) {
      const layer = String(ent.layer ?? "0").trim();
      if (layer !== cfg.layerFilter) continue;
    }

    let pts = [];
    if (ent.type === "LWPOLYLINE") {
      pts = (ent.vertices || []).map((v) => [Number(v.x), Number(v.y)]);
    } else if (Array.isArray(ent.vertices)) {
      pts = ent.vertices.map((v) => [Number(v.x), Number(v.y)]);
    }

    if (pts.length < 2) continue;

    const flag = ent.flag ?? ent.flags ?? 0;
    let closed = !!(ent.shape || flag & 1);

    // 첫점=끝점 패턴으로 닫힘을 표현하는 경우 대응
    if (pts.length >= 2) {
      const [ax, ay] = pts[0];
      const [bx, by] = pts[pts.length - 1];
      if (Math.hypot(ax - bx, ay - by) < 1e-6) {
        pts = pts.slice(0, -1);
        closed = true;
      }
    }

    if (cfg.requireClosed && !closed) continue;
    if (pts.length < 3) continue;

    result.push(pts);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 메인 변환 함수
// ---------------------------------------------------------------------------
/**
 * dxf-parser로 파싱한 DXF 객체를 GeoStudio Points/Regions로 변환.
 *
 * @param {object} dxf   - DxfParser.parseSync() 반환값
 * @param {object} opts  - DEFAULT_CONFIG 필드 오버라이드
 * @returns {{ points: Array, regions: Array, warnings: string[], config: object }}
 */
export function convertDxfParsed(dxf, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...opts };
  const warnings = [];

  const polylines = extractPolylines(dxf, cfg);
  if (!polylines.length) {
    throw new Error(
      "처리할 닫힌 LWPOLYLINE/POLYLINE이 없습니다. " +
      `레이어: ${cfg.layerFilter ?? "(전체)"}, 닫힘 필수: ${cfg.requireClosed}`
    );
  }

  const registry = new PointRegistry(cfg);
  const regionPointIds = [];

  for (let i = 0; i < polylines.length; i++) {
    const { verts, removed } = normalizeVertices(
      polylines[i],
      cfg.coordinateTolerance,
      cfg.skipClosingDuplicate,
      cfg.removeConsecutiveDuplicates
    );

    if (removed > 0) {
      warnings.push(`Region ${i + 1}: 연속 중복 꼭짓점 ${removed}개 제거`);
    }
    if (verts.length < 3) {
      warnings.push(`폴리선 ${i + 1}: 꼭짓점 ${verts.length}개 — Region 부적합, 건너뜀`);
      continue;
    }

    const ids = verts.map(([x, y]) => registry.register(x, y));
    const { ids: finalIds, removed: idRemoved } = finalizeRegionPointIds(ids, cfg);
    if (idRemoved > 0) {
      warnings.push(`Region ${regionPointIds.length + 1}: 연속 중복 Point ID ${idRemoved}개 제거`);
    }
    regionPointIds.push(finalIds);
  }

  const points = registry.allPoints();
  const regions = regionPointIds.map((pids, i) => ({ id: i + 1, pointIds: pids }));

  return { points, regions, warnings, config: cfg };
}

// ---------------------------------------------------------------------------
// ExcelJS 출력
// ---------------------------------------------------------------------------
/**
 * 변환 결과를 GeoStudio import용 .xlsx Blob으로 반환.
 * 전역 ExcelJS (vendor/exceljs.min.js) 가 로드되어 있어야 합니다.
 *
 * @param {{ points, regions, config }} result - convertDxfParsed() 반환값
 * @returns {Promise<Blob>}
 */
export async function exportGeoStudioExcel(result) {
  const ExcelJS = globalThis.ExcelJS;
  if (!ExcelJS) throw new Error("ExcelJS가 로드되지 않았습니다.");

  const { points, regions, config: cfg } = result;
  const dec = cfg.coordinateDecimals;
  const wb = new ExcelJS.Workbook();

  // ── Points 시트 ──────────────────────────────────────────────
  const pws = wb.addWorksheet(cfg.pointsSheetName);
  pws.columns = [
    { header: "ID",     key: "id",     width: 8  },
    { header: "X (m)", key: "x",     width: 16 },
    { header: "Y (m)", key: "y",     width: 16 },
    { header: "Label",  key: "label",  width: 16 },
    { header: "Pinned", key: "pinned", width: 10 },
  ];
  // 헤더 행 스타일
  pws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
  });
  for (const p of points) {
    pws.addRow({
      id:     p.id,
      x:      roundCoord(p.x, dec),
      y:      roundCoord(p.y, dec),
      label:  cfg.pointLabel,
      pinned: cfg.pointPinned,
    });
  }

  // ── Regions 시트 ─────────────────────────────────────────────
  const rws = wb.addWorksheet(cfg.regionsSheetName);
  rws.columns = [
    { header: "Region", key: "region", width: 10 },
    { header: "Points", key: "points", width: 60 },
    { header: "Type",   key: "type",   width: 20 },
  ];
  rws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
  });
  for (const r of regions) {
    rws.addRow({
      region: r.id,
      points: r.pointIds.join(","),
      type:   cfg.regionType,
    });
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

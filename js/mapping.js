import {
  firstChildEl,
  removeAllChildren,
  createEl,
  findFirstTag,
} from "./xml-utils.js";
import {
  snapCoordGridXY,
  dedupeConsecutivePolyXY,
  mergeCoincidentVertices,
  collapseRingPointIds,
  topologyRefineRings,
} from "./geometry.js";
import {
  VERTEX_MERGE_EPS,
  STEINER_EDGE_TOL,
  TOPOLOGY_REFINE_MAX_ITER,
  COORD_GRID_SNAP,
} from "./constants.js";
import { syncRegionUsesMaterials } from "./region-materials.js";

function findGeometryItems(doc) {
  return findFirstTag(doc, "GeometryItems");
}

/**
 * DXF → 병합·토폴로지 보정 후 merged_final + spanLayers (GeoStudio Region 1개 루프와 동일 순서)
 */
export function buildRegionSpanData(dxfLayers, geometryLayers, log = () => {}) {
  const workEntries = [];
  for (const [layer, polys] of Object.entries(dxfLayers)) {
    if (!geometryLayers.has(layer)) {
      log(`  [건너뜀] ${layer}`);
      continue;
    }
    for (const poly of polys) {
      let ring = dedupeConsecutivePolyXY(poly);
      if (COORD_GRID_SNAP && COORD_GRID_SNAP > 0) {
        ring = ring.map(([x, y]) =>
          snapCoordGridXY(x, y, COORD_GRID_SNAP),
        );
        ring = dedupeConsecutivePolyXY(ring);
      }
      if (ring.length < 3) {
        log(`  [진단-스냅드롭] ${layer}: 격자 스냅 후 꼭짓점 ${ring.length}개 (원본 ${poly.length}개)`);
        continue;
      }
      workEntries.push([layer, ring]);
    }
  }
  log(`  위상 보정 대상: ${workEntries.length}개 링`);

  if (workEntries.length && COORD_GRID_SNAP && COORD_GRID_SNAP > 0) {
    log(`  좌표 격자 스냅 간격: ${COORD_GRID_SNAP} m`);
  }

  const flatCoords = [];
  const spans = [];
  for (const [layer, ring] of workEntries) {
    const start = flatCoords.length;
    flatCoords.push(...ring);
    spans.push([layer, start, flatCoords.length]);
  }

  const merged_xy =
    flatCoords.length > 0
      ? mergeCoincidentVertices(flatCoords, VERTEX_MERGE_EPS)
      : [];
  if (flatCoords.length) {
    const uq = new Set(
      merged_xy.map(([x, y]) =>
        `${Math.round(x * 1e6) / 1e6},${Math.round(y * 1e6) / 1e6}`,
      ),
    ).size;
    log(
      `  꼭짓점 근접 병합 ε=${VERTEX_MERGE_EPS}: 원본 ${flatCoords.length}개 정점 → 고유 좌표 약 ${uq}개`,
    );
  }

  const layersOrder = workEntries.map(([layer]) => layer);
  const ringsMerged = spans.map(([_, s, e]) => merged_xy.slice(s, e));
  const [ringsTopo, topoIt] = topologyRefineRings(
    ringsMerged,
    STEINER_EDGE_TOL,
    TOPOLOGY_REFINE_MAX_ITER,
  );
  if (flatCoords.length) {
    log(
      `  경계 보정(T-교차·선분교차): tol=${STEINER_EDGE_TOL}, 반복 ${topoIt}/${TOPOLOGY_REFINE_MAX_ITER}`,
    );
  }

  const flat2 = [];
  const spanLayers = [];
  for (let i = 0; i < layersOrder.length; i++) {
    const layer = layersOrder[i];
    const ring = ringsTopo[i];
    const s = flat2.length;
    flat2.push(...ring);
    spanLayers.push([layer, s, flat2.length]);
  }

  // 위상 보정 후 재병합은 부동소수점 노이즈만 제거. VERTEX_MERGE_EPS(0.08m)로
  // 병합하면 Steiner 삽입점이 인접 꼭짓점과 합쳐져 소형 링이 퇴화할 수 있음.
  const merged_final =
    flat2.length > 0 ? mergeCoincidentVertices(flat2, 1e-6) : [];
  if (flat2.length) {
    const uq2 = new Set(
      merged_final.map(([x, y]) =>
        `${Math.round(x * 1e6) / 1e6},${Math.round(y * 1e6) / 1e6}`,
      ),
    ).size;
    log(`  보정 후 재병합: 고유 좌표 약 ${uq2}개`);
  }

  return { merged_final, spanLayers };
}

/**
 * applyRegionMappingToDocument 동일 순서의 Region(GeoStudio ID) + 닫힌 외곽선(미리보기·히트용)
 * getPt 병합 규칙을 좌표 키 풀로 모사합니다.
 */
export function computePreviewRegionsFromDxf(
  dxfLayers,
  geometryLayers,
  log = () => {},
) {
  const { merged_final, spanLayers } = buildRegionSpanData(
    dxfLayers,
    geometryLayers,
    log,
  );
  const pointPool = new Map();
  let nextPid = 1;
  function getPtId(x, y) {
    const k = `${Math.round(x * 1e6) / 1e6},${Math.round(y * 1e6) / 1e6}`;
    if (!pointPool.has(k)) {
      pointPool.set(k, nextPid);
      nextPid += 1;
    }
    return pointPool.get(k);
  }

  /** @type {{ regId: number, layer: string, poly: Array<[number, number]> }[]} */
  const regions = [];
  const layerRegionIds = {};
  let regId = 1;
  for (const [layer, s, e] of spanLayers) {
    const ring_xy = merged_final.slice(s, e);
    const raw_pids = ring_xy.map(([x, y]) => getPtId(x, y));
    const pids = collapseRingPointIds(raw_pids);
    if (pids.length < 3) {
      log(`  [건너뜀] ${layer}: 병합 후 꼭짓점 부족 (${pids.length}개)`);
      continue;
    }
    regions.push({
      regId,
      layer,
      poly: ring_xy.map(([x, y]) => [Number(x), Number(y)]),
    });
    if (!layerRegionIds[layer]) layerRegionIds[layer] = [];
    layerRegionIds[layer].push(regId);
    regId += 1;
  }
  return { regions, layerRegionIds };
}

/**
 * 해석별 Region ID → Material ID 를 RegionUsesMaterials 로 반영
 */
export function syncMaterialsForAnalysisFromRegions(
  doc,
  regionMaterials,
  analysisId,
  log = () => {},
) {
  const mappings = [];
  for (const [ridStr, mid] of Object.entries(regionMaterials || {})) {
    const rid = parseInt(ridStr, 10);
    if (!Number.isFinite(rid)) continue;
    if (mid == null || !Number.isFinite(mid) || mid === 0) continue;
    mappings.push([rid, mid]);
  }
  syncRegionUsesMaterials(doc, mappings, analysisId, log);
  return mappings.length;
}

/**
 * 이미 생성된 region ID 목록에 대해, 해석별 레이어→Material 매핑만 RegionUsesMaterials 로 반영.
 */
export function syncMaterialsForAnalysisFromGeometry(
  doc,
  layerRegionIds,
  layerMap,
  analysisId,
  log = () => {},
) {
  if (!layerRegionIds || !Object.keys(layerRegionIds).length) {
    syncRegionUsesMaterials(doc, [], analysisId, log);
    return 0;
  }
  const mappings = [];
  for (const [layer, rids] of Object.entries(layerRegionIds)) {
    if (!layerMap || !(layer in layerMap)) continue;
    const mid = layerMap[layer];
    if (mid == null || !Number.isFinite(mid) || mid === 0) continue;
    for (const rid of rids) mappings.push([rid, mid]);
  }
  syncRegionUsesMaterials(doc, mappings, analysisId, log);
  return mappings.length;
}

/**
 * slope_gui.apply_region_mapping_to_gsz 핵심 (메모리 상 Document)
 * @param {object} [options]
 * @param {Set<string>} [options.geometryLayers] 포함할 DXF 레이어. 없으면 layerMap 의 키 사용.
 * @param {boolean} [options.deferMaterialSync] true면 RegionUsesMaterials 는 건너뛰고 layerRegionIds 반환.
 */
export function applyRegionMappingToDocument(
  doc,
  dxfLayers,
  layerMap,
  analysisId,
  log = () => {},
  options = {},
) {
  const geometryLayers =
    options.geometryLayers instanceof Set
      ? options.geometryLayers
      : new Set(Object.keys(layerMap));

  log(`  DXF 레이어: ${Object.keys(dxfLayers).join(", ")}`);

  const root = doc.documentElement;
  let gi = findGeometryItems(doc);
  if (!gi) {
    gi = doc.createElement("GeometryItems");
    root.appendChild(gi);
  }

  for (const tag of ["Points", "Lines", "Regions"]) {
    let node = firstChildEl(gi, tag);
    if (!node) {
      node = doc.createElement(tag);
      gi.appendChild(node);
    } else removeAllChildren(node);
  }

  const ptsNode = firstChildEl(gi, "Points");
  const linesNode = firstChildEl(gi, "Lines");
  const regsNode = firstChildEl(gi, "Regions");

  const pointPool = new Map();
  const linePool = new Map();
  let ptId = 1,
    lnId = 1,
    regId = 1;
  const layerRegionIds = {};

  function getPt(x, y) {
    const k = `${Math.round(x * 1e6) / 1e6},${Math.round(y * 1e6) / 1e6}`;
    if (!pointPool.has(k)) {
      const pt = doc.createElement("Point");
      pt.setAttribute("ID", String(ptId));
      pt.setAttribute("X", x.toFixed(6));
      pt.setAttribute("Y", y.toFixed(6));
      ptsNode.appendChild(pt);
      pointPool.set(k, ptId);
      ptId += 1;
    }
    return pointPool.get(k);
  }

  function getLn(p1, p2) {
    const a = Math.min(p1, p2),
      b = Math.max(p1, p2);
    const k = `${a}|${b}`;
    if (!linePool.has(k)) {
      const ln = doc.createElement("Lines");
      linesNode.appendChild(ln);
      ln.appendChild(createEl(doc, "ID", String(lnId)));
      ln.appendChild(createEl(doc, "PointID1", String(p1)));
      ln.appendChild(createEl(doc, "PointID2", String(p2)));
      linePool.set(k, lnId);
      lnId += 1;
    }
    return linePool.get(k);
  }

  const { merged_final, spanLayers } = buildRegionSpanData(
    dxfLayers,
    geometryLayers,
    log,
  );

  for (const [layer, s, e] of spanLayers) {
    const ring_xy = merged_final.slice(s, e);
    const raw_pids = ring_xy.map(([x, y]) => getPt(x, y));
    const pids = collapseRingPointIds(raw_pids);
    if (pids.length < 3) {
      log(`  [건너뜀] ${layer}: 병합 후 꼭짓점 부족 (${pids.length}개)`);
      continue;
    }
    if (!layerRegionIds[layer]) layerRegionIds[layer] = [];
    for (let i = 0; i < pids.length; i++) {
      const p1 = pids[i],
        p2 = pids[(i + 1) % pids.length];
      if (p1 !== p2) getLn(p1, p2);
    }
    const reg = doc.createElement("Region");
    regsNode.appendChild(reg);
    reg.appendChild(createEl(doc, "ID", String(regId)));
    reg.appendChild(createEl(doc, "PointIDs", pids.join(",")));
    layerRegionIds[layer].push(regId);
    regId += 1;
  }

  ptsNode.setAttribute("Len", String(ptId - 1));
  linesNode.setAttribute("Len", String(lnId - 1));
  regsNode.setAttribute("Len", String(regId - 1));
  log(`  Point=${ptId - 1}, Lines=${lnId - 1}, Region=${regId - 1}`);

  const mappings = [];
  for (const [layer, rids] of Object.entries(layerRegionIds)) {
    for (const rid of rids) mappings.push([rid, layerMap[layer]]);
  }

  if (options.deferMaterialSync) {
    return { layerRegionIds, mappingCount: mappings.length };
  }

  syncRegionUsesMaterials(doc, mappings, analysisId, log);
  return mappings.length;
}

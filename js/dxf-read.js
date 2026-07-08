/**
 * dxf-parser 결과에서 폐합 LWPOLYLINE / POLYLINE만 레이어별 수집
 * slope_gui.read_layers_from_dxf 와 동등 목표
 */
export function readLayersFromDxfParsed(dxf) {
  const layers = {};
  const ents = dxf.entities || [];
  let totalPoly = 0, accepted = 0;
  for (const ent of ents) {
    const type = ent.type;
    if (type !== "LWPOLYLINE" && type !== "POLYLINE") continue;
    totalPoly++;
    const layer = String(ent.layer ?? "0").trim();

    let closed = false;
    let pts = [];

    if (type === "LWPOLYLINE") {
      const flag = ent.flag ?? ent.flags ?? 0;
      closed = !!(ent.shape || flag & 1);
      pts = (ent.vertices || []).map((v) => [Number(v.x), Number(v.y)]);
    } else {
      const flag = ent.flag ?? ent.flags ?? 0;
      closed = !!(ent.shape || flag & 1);
      if (Array.isArray(ent.vertices))
        pts = ent.vertices.map((v) => [Number(v.x), Number(v.y)]);
    }

    // 닫힘 플래그 없이 첫점=끝점으로 닫힘을 표현하는 CAD 출력 방식 대응
    if (pts.length >= 2) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) {
        pts = pts.slice(0, -1);
        closed = true;
      }
    }

    if (closed && pts.length >= 3) {
      if (!layers[layer]) layers[layer] = [];
      layers[layer].push(pts);
      accepted++;
    } else {
      const firstLast = pts.length >= 2
        ? Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]).toExponential(3)
        : "N/A";
      console.warn(`[DXF skip] type=${type} layer=${layer} closed=${closed} pts=${pts.length} firstLastDist=${firstLast}`, ent);
    }
  }
  console.log(`[DXF] total=${totalPoly} accepted=${accepted}`);
  return layers;
}

/** DXF 수위 라인용 레이어명 (열린·닫힌 폴리라인 모두 허용) */
export const WATER_TABLE_LAYER_NAME = "@수위";

function polylineChainLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    s += Math.hypot(dx, dy);
  }
  return s;
}

function extractPolylineXY(ent) {
  const type = ent.type;
  if (type !== "LWPOLYLINE" && type !== "POLYLINE") return null;
  let pts = [];
  if (type === "LWPOLYLINE") {
    pts = (ent.vertices || []).map((v) => [Number(v.x), Number(v.y)]);
  } else if (Array.isArray(ent.vertices)) {
    pts = ent.vertices.map((v) => [Number(v.x), Number(v.y)]);
  }
  if (pts.length < 2) return null;
  const flag = ent.flag ?? ent.flags ?? 0;
  const closed = !!(ent.shape || flag & 1);
  if (closed && pts.length >= 3) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (
      Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9
    ) {
      pts = pts.slice(0, -1);
    }
  }
  return pts;
}

/**
 * 지정 레이어의 폴리라인 중 가장 긴 하나를 수위 꺾은선으로 선택 (점 순서 유지).
 * @returns {Array<[number,number]> | null}
 */
export function readWaterTablePolylineFromDxf(dxf, layerName = WATER_TABLE_LAYER_NAME) {
  const target = String(layerName).trim();
  const ents = dxf.entities || [];
  let best = null;
  let bestLen = -1;
  for (const ent of ents) {
    const layer = String(ent.layer ?? "0").trim();
    if (layer !== target) continue;
    const pts = extractPolylineXY(ent);
    if (!pts || pts.length < 2) continue;
    const plen = polylineChainLength(pts);
    if (plen > bestLen) {
      bestLen = plen;
      best = pts;
    }
  }
  return best;
}

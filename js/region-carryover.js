/**
 * DXF 를 교체했을 때 이전 Region↔재료 매핑을 새 Region 에 승계한다.
 * Region ID 는 DXF 의 폴리라인 순서대로 매겨져 단면이 바뀌면 번호가 밀리므로,
 * 같은 레이어 안에서 도형의 위치(무게중심)와 크기(면적)가 가장 가까운 Region 끼리 짝짓는다.
 */

/** 이 비용(무게중심 거리 ÷ 대표 길이 + 면적비 보정) 이하만 짝으로 인정 */
export const MATCH_MAX_COST = 1.0;
/** 이 비용 이하면 확신, 초과면 사용자에게 확인을 요청 */
export const MATCH_CONFIDENT_COST = 0.25;

export function polygonStats(poly) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    const w = x0 * y1 - x1 * y0;
    a += w;
    cx += (x0 + x1) * w;
    cy += (y0 + y1) * w;
  }
  if (Math.abs(a) < 1e-12) {
    // 퇴화 도형: 꼭짓점 평균
    const mx = poly.reduce((s, p) => s + p[0], 0) / (n || 1);
    const my = poly.reduce((s, p) => s + p[1], 0) / (n || 1);
    return { area: 0, cx: mx, cy: my };
  }
  return { area: Math.abs(a) / 2, cx: cx / (3 * a), cy: cy / (3 * a) };
}

/**
 * @param {{regId:number, layer:string, poly:number[][]}[]} oldRegions
 * @param {{regId:number, layer:string, poly:number[][]}[]} newRegions
 * @returns {Map<number,{oldId:number, cost:number, confident:boolean}>} 새 regId → 승계 정보
 */
export function matchRegions(oldRegions, newRegions) {
  const olds = oldRegions.map((r) => ({ ...r, ...polygonStats(r.poly) }));
  const news = newRegions.map((r) => ({ ...r, ...polygonStats(r.poly) }));

  const pairs = [];
  for (const n of news) {
    for (const o of olds) {
      if (o.layer !== n.layer) continue;
      const scale = Math.max(Math.sqrt(o.area), Math.sqrt(n.area), 1e-6);
      const dist = Math.hypot(n.cx - o.cx, n.cy - o.cy);
      const areaPenalty =
        o.area > 0 && n.area > 0 ? Math.abs(Math.log(n.area / o.area)) * 0.25 : 0.5;
      const cost = dist / scale + areaPenalty;
      if (cost <= MATCH_MAX_COST) pairs.push({ o: o.regId, n: n.regId, cost });
    }
  }
  pairs.sort((a, b) => a.cost - b.cost);

  const usedOld = new Set();
  const out = new Map();
  for (const p of pairs) {
    if (usedOld.has(p.o) || out.has(p.n)) continue;
    usedOld.add(p.o);
    out.set(p.n, { oldId: p.o, cost: p.cost, confident: p.cost <= MATCH_CONFIDENT_COST });
  }
  return out;
}

/**
 * 해석 행마다 이전 매핑을 새 Region 번호로 옮긴다. 짝이 없는 Region 은 건드리지 않는다.
 * @param {Object<string,number|null>} oldMap  이전 { regId: materialId }
 * @param {Object<string,number|null>} newMap  새 기본 매핑 (제자리 수정)
 * @param {Map<number,{oldId:number}>} match
 * @returns {number} 승계한 Region 수
 */
export function carryOverMaterials(oldMap, newMap, match) {
  let n = 0;
  for (const [newId, info] of match) {
    const key = String(info.oldId);
    if (!(key in oldMap)) continue;
    newMap[String(newId)] = oldMap[key];
    n += 1;
  }
  return n;
}

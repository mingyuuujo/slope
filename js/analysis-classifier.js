/**
 * analysis-classifier.js
 * 해석명 키워드로 시공시/상시/지진시를 분류하고,
 * 각 케이스의 대표 결과(최소 FOS)를 선택한다.
 */

/**
 * 해석명 → 케이스 분류
 * @param {string} name
 * @returns {'construction'|'normal'|'seismic'|'other'}
 */
export function classifyAnalysis(name) {
  const n = name ?? "";
  if (/지진시/.test(n) && /편심/.test(n)) return "eccentric_seismic";
  if (/상시/.test(n)   && /편심/.test(n)) return "eccentric_normal";
  if (/지진시/.test(n)) return "seismic";
  if (/시공시/.test(n)) return "construction";
  if (/상시/.test(n))   return "normal";
  return "other";
}

/** 케이스별 한글 레이블 */
export const CASE_LABELS = {
  construction:      "시공시",
  normal:            "상시",
  seismic:           "지진시",
  eccentric_normal:  "상시(편심)",
  eccentric_seismic: "지진시(편심)",
};

/** 케이스별 기준 안전율 */
export const REQUIRED_FOS = {
  construction:      1.1,
  normal:            1.3,
  seismic:           1.1,
  eccentric_normal:  1.2,
  eccentric_seismic: 1.0,
};

/**
 * 전체 결과 배열에서 케이스별 대표(최소 FOS) 결과를 선택한다.
 *
 * @param {Array} allResults - parseAllResults() 반환값
 * @returns {{ construction: object|null, normal: object|null, seismic: object|null }}
 */
export function selectRepresentativeResults(allResults) {
  const out = { construction: null, normal: null, seismic: null };

  for (const r of allResults) {
    const key = classifyAnalysis(r.analysisName);
    if (key === "other") continue;
    if (!out[key] || r.fos < out[key].fos) {
      out[key] = r;
    }
  }

  return out;
}

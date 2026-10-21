/**
 * 케이스 템플릿: 수위·수평지진계수·상재하중 묶음을 GSZ 의 해석(Analysis) 단위로 적용한다.
 * 비워 둔 항목(null)은 해당 해석의 기존 값을 그대로 둔다.
 *
 * @typedef {{
 *   name: string,
 *   water: null | {type:"level", elevation:number, xMin?:number, xMax?:number} | {type:"points", points:{x:number,y:number}[]},
 *   seismicH: number|null,
 *   pressureLines: null | {points:{x:number,y:number}[], pressure:number}[],
 * }} CaseTemplate
 */
import { allChildEl, firstChildEl, findSlopeItemsRoot } from "./xml-utils.js";
import { applyWaterToAnalysis, findEntryForAnalysis } from "./water-datapoints.js";

const fmtC = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(8).replace(/\.?0+$/, "").replace(/\.$/, "") || "0";
};

function applyPressureLines(doc, entry, lines) {
  let dpRoot = firstChildEl(entry, "DataPoints");
  if (!dpRoot) {
    dpRoot = doc.createElement("DataPoints");
    entry.insertBefore(dpRoot, entry.firstChild);
  }
  let maxNum = 0;
  for (const dp of allChildEl(dpRoot, "DataPoint")) {
    if (!dp.hasAttribute("X")) continue;
    const n = parseInt(dp.getAttribute("Number") ?? "0", 10);
    if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
  }
  const old = firstChildEl(entry, "PressureLines");
  if (old) entry.removeChild(old);
  if (!lines.length) return;

  const pls = doc.createElement("PressureLines");
  pls.setAttribute("Len", String(lines.length));
  let offset = 0;
  lines.forEach((pl, i) => {
    const start = maxNum + 1 + offset;
    pl.points.forEach((pt, j) => {
      const dp = doc.createElement("DataPoint");
      dp.setAttribute("Number", String(start + j));
      dp.setAttribute("X", fmtC(pt.x));
      dp.setAttribute("Y", fmtC(pt.y));
      dpRoot.appendChild(dp);
    });
    offset += pl.points.length;
    dpRoot.setAttribute("Len", String(allChildEl(dpRoot, "DataPoint").length));

    const el = doc.createElement("PressureLine");
    const id = doc.createElement("ID");
    id.textContent = String(i + 1);
    const dps = doc.createElement("DataPoints");
    dps.setAttribute("Len", String(pl.points.length));
    pl.points.forEach((_, j) => {
      const ref = doc.createElement("DataPoint");
      ref.textContent = String(start + j);
      dps.appendChild(ref);
    });
    const p = doc.createElement("Pressure");
    p.textContent = String(pl.pressure);
    el.append(id, dps, p);
    pls.appendChild(el);
  });
  const ssl = firstChildEl(entry, "SlipSurfaceLimit");
  if (ssl) entry.insertBefore(pls, ssl);
  else entry.appendChild(pls);
}

/**
 * @param {Document} doc
 * @param {string|number} analysisId
 * @param {CaseTemplate} tpl
 * @returns {string[]} 적용한 내용 (비어 있으면 아무것도 바뀌지 않음)
 */
export function applyCaseToAnalysis(doc, analysisId, tpl) {
  const done = [];
  const entry = findEntryForAnalysis(doc, analysisId);
  if (!entry) return done;

  if (tpl.water) {
    const d = applyWaterToAnalysis(doc, analysisId, tpl.water);
    if (d) done.push(d);
  }
  if (Number.isFinite(tpl.seismicH)) {
    let s = firstChildEl(entry, "Seismic");
    if (!s) {
      s = doc.createElement("Seismic");
      s.setAttribute("Vertical", "");
      entry.insertBefore(s, entry.firstChild);
    }
    s.setAttribute("Horizontal", String(tpl.seismicH));
    done.push(`kh ${tpl.seismicH}`);
  }
  if (tpl.pressureLines) {
    applyPressureLines(doc, entry, tpl.pressureLines);
    done.push(tpl.pressureLines.length
      ? `상재하중 ${tpl.pressureLines.map((p) => p.pressure + "kPa").join(", ")}`
      : "상재하중 제거");
  }
  return done;
}

/** SlopeItems 가 있는 문서에서 해석 ID·이름 목록. */
export function listAnalyses(doc) {
  const out = [];
  const root = doc.getElementsByTagName("Analyses")[0];
  if (!root) return out;
  const hasEntry = new Set(
    allChildEl(findSlopeItemsRoot(doc) ?? doc.createElement("x"), "SlopeItem")
      .map((si) => firstChildEl(si, "AnalysisID")?.textContent?.trim()),
  );
  for (const a of allChildEl(root, "Analysis")) {
    const id = firstChildEl(a, "ID")?.textContent?.trim();
    if (!id || !hasEntry.has(id)) continue; // SLOPE/W 입력이 있는 해석만
    out.push({ id, name: firstChildEl(a, "Name")?.textContent?.trim() ?? "" });
  }
  return out;
}

/** 화면 입력 문자열 → 템플릿 값. 잘못된 입력은 Error. */
export function parseWaterText(text) {
  const t = text.trim();
  if (!t) return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return { type: "level", elevation: parseFloat(t) };
  const points = t.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [x, y] = l.split(/[,\s]+/).map(parseFloat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`수위 좌표를 읽을 수 없습니다: "${l}"`);
    return { x, y };
  });
  if (points.length < 2) throw new Error("수위 좌표는 2점 이상이어야 합니다.");
  return { type: "points", points };
}

export function parsePressureText(text) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  return lines.map((l) => {
    const [pts, kpa] = l.split("|");
    const pressure = parseFloat(kpa);
    const points = (pts ?? "").trim().split(/\s+/).map((p) => {
      const [x, y] = p.split(",").map(parseFloat);
      return { x, y };
    });
    if (!Number.isFinite(pressure) || points.length < 2 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      throw new Error(`상재하중 형식 오류: "${l}" (예: 0,5 10,5 | 20)`);
    }
    return { points, pressure };
  });
}

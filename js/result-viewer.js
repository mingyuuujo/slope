/**
 * result-viewer.js
 * 결과 뷰어 탭 — 캔버스에 리즌 채색 + 임계 파괴원호 오버레이
 */

import { getJSZip }        from "./deps.js";
import { parseAllResults, parseRootXml } from "./result-parser.js";
import { classifyAnalysis, REQUIRED_FOS } from "./analysis-classifier.js";
import { generateStructuralReport }    from "./excel-report.js";

// ─── 상태 ─────────────────────────────────────────────────────
let rvState = {
  zip:        null,
  doc:        null,
  materials:  [],
  regions:    [],
  allResults: [],
  selectedIdx: 0,
};

// 물성치 JSON 업로드 상태: null 이면 미업로드
let rvCustomMats = null;  // { materials: [...], categories: { [id]: "structure"|"ground"|"foundation" } }

// 케이스 수동 재정의: { [analysisName]: { key: string, customReq?: number } }
let rvCaseOverrides = {};

// View Region 토글 상태
let rvViewRegion = false;

// ─── DOM 헬퍼 ─────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);

function esc(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}

// ─── FOS 판정 ─────────────────────────────────────────────────
function fosJudge(fos, required) {
  if (!Number.isFinite(fos)) return { label: "—", cls: "" };
  if (fos >= required) return { label: "O.K", cls: "fos-ok" };
  return { label: "N.G", cls: "fos-ng" };
}

function fosColorClass(fos) {
  if (!Number.isFinite(fos)) return "";
  if (fos >= 1.5)  return "fos-safe";
  if (fos >= 1.2)  return "fos-warn";
  return "fos-danger";
}

// ─── XML → 재료/리즌 파싱 ─────────────────────────────────────
function parseRgbColor(str) {
  const m = str?.match(/RGB=\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return "#aaaaaa";
  const [, r, g, b] = m;
  return `#${(+r).toString(16).padStart(2, "0")}${(+g).toString(16).padStart(2, "0")}${(+b).toString(16).padStart(2, "0")}`;
}

function extractMaterials(doc) {
  if (!doc) return [];
  const matsEl = doc.querySelector("Materials");
  if (!matsEl) return [];
  const mats = [];
  for (const mat of matsEl.querySelectorAll("Material")) {
    const id         = mat.querySelector("ID")?.textContent.trim() ?? "";
    const name       = mat.querySelector("Name")?.textContent.trim() ?? "";
    const colorStr   = mat.querySelector("Color")?.textContent.trim() ?? "";
    const slopeModel = mat.querySelector("SlopeModel")?.textContent.trim() ?? "";
    const ss = mat.querySelector("StressStrain");
    const props = {};
    if (ss) {
      for (let c = ss.firstElementChild; c; c = c.nextElementSibling) {
        props[c.tagName] = c.textContent.trim();
      }
    }
    mats.push({ id, name, colorStr, color: parseRgbColor(colorStr), slopeModel, props });
  }
  return mats;
}

function extractRegions(doc) {
  if (!doc) return [];
  const geomEl = doc.querySelector("GeometryItems");
  if (!geomEl) return [];
  const ptsMap = new Map();
  const ptsEl = geomEl.querySelector(":scope > Points");
  if (ptsEl) {
    for (const pt of ptsEl.querySelectorAll("Point")) {
      const pid = pt.getAttribute("ID");
      ptsMap.set(pid, { x: parseFloat(pt.getAttribute("X") || 0), y: parseFloat(pt.getAttribute("Y") || 0) });
    }
  }
  const regions = [];
  const regionsEl = geomEl.querySelector(":scope > Regions");
  if (regionsEl) {
    for (const r of regionsEl.querySelectorAll("Region")) {
      const id      = r.querySelector("ID")?.textContent.trim() ?? "";
      const ptStr   = r.querySelector("PointIDs")?.textContent.trim() ?? "";
      const pointIds = ptStr.split(",").map((s) => s.trim()).filter(Boolean);
      const coords   = pointIds.map((pid) => ptsMap.get(pid) || { x: 0, y: 0 });
      if (id) regions.push({ id, pointIds, coords });
    }
  }
  return regions;
}

function extractRegionMaterials(doc, analysisName) {
  if (!doc) return new Map();
  let analysisId = null;
  for (const a of doc.querySelectorAll("Analyses > Analysis")) {
    const nameEl = a.querySelector("Name");
    if (nameEl && nameEl.textContent.trim() === analysisName) {
      analysisId = a.querySelector("ID")?.textContent.trim() ?? null;
      break;
    }
  }
  const map = new Map();
  if (!analysisId) return map;
  for (const ctx of doc.querySelectorAll("Contexts > Context")) {
    const aid = ctx.querySelector("AnalysisID")?.textContent.trim();
    if (aid !== analysisId) continue;
    for (const rum of ctx.querySelectorAll("RegionUsesMaterial")) {
      map.set(rum.getAttribute("ID") ?? "", rum.getAttribute("UsesID") ?? "");
    }
    break;
  }
  return map;
}

// ─── 상재하중 파싱 ────────────────────────────────────────────
function extractSurchargeLoads(doc, analysisName) {
  if (!doc) return null;

  let analysisId = null;
  for (const a of doc.querySelectorAll("Analyses > Analysis")) {
    const nameEl = a.querySelector("Name");
    if (nameEl && nameEl.textContent.trim() === analysisName) {
      analysisId = a.querySelector("ID")?.textContent.trim() ?? null;
      break;
    }
  }
  if (!analysisId) return null;

  let slopeEntry = null;
  for (const si of doc.querySelectorAll("SlopeItems > SlopeItem")) {
    const aid = si.querySelector("AnalysisID")?.textContent.trim();
    if (aid === analysisId) {
      slopeEntry = si.querySelector("Entry");
      break;
    }
  }
  if (!slopeEntry) return null;

  // DataPoint Number → {x, y}
  const dpMap = new Map();
  for (const dp of slopeEntry.querySelectorAll(":scope > DataPoints > DataPoint")) {
    const num = dp.getAttribute("Number");
    if (num) dpMap.set(num, { x: parseFloat(dp.getAttribute("X")), y: parseFloat(dp.getAttribute("Y")) });
  }

  const pressureLines = [];
  for (const pl of slopeEntry.querySelectorAll("PressureLines > PressureLine")) {
    const pressure = parseFloat(pl.querySelector("Pressure")?.textContent.trim() ?? "NaN");
    if (!Number.isFinite(pressure) || pressure <= 0) continue;
    const dpNums = [...pl.querySelectorAll("DataPoints > DataPoint")].map((d) => d.textContent.trim());
    if (dpNums.length < 2) continue;
    const pt1 = dpMap.get(dpNums[0]);
    const pt2 = dpMap.get(dpNums[dpNums.length - 1]);
    if (!pt1 || !pt2) continue;
    pressureLines.push({ x1: pt1.x, y1: pt1.y, x2: pt2.x, y2: pt2.y, pressure });
  }

  // SlipEntryExit: LeftOption=Point → 수평력 오른쪽(→), RightOption=Point → 왼쪽(←)
  let horzDirOverride = null;
  const see = slopeEntry.querySelector("SlipEntryExit");
  if (see) {
    const leftOpt  = see.querySelector("LeftOption")?.textContent.trim();
    const rightOpt = see.querySelector("RightOption")?.textContent.trim();
    if (leftOpt === "Point")       horzDirOverride = 0;   // 왼쪽이 점 → 오른쪽 방향 →
    else if (rightOpt === "Point") horzDirOverride = 180; // 오른쪽이 점 → 왼쪽 방향 ←
  }

  const lineLoads = [];
  for (const llp of slopeEntry.querySelectorAll("LineLoadPoints > LineLoadPoint")) {
    const ptId = llp.querySelector("ID")?.textContent.trim();
    const ll   = llp.querySelector("LineLoad");
    if (!ptId || !ll) continue;
    const value  = parseFloat(ll.getAttribute("Value") ?? "NaN");
    const rawDir = parseFloat(ll.getAttribute("Direction") ?? "270");
    if (!Number.isFinite(value) || value <= 0) continue;
    const pt = dpMap.get(ptId);
    if (!pt) continue;
    // 수평력(cos 성분이 큰 경우)에만 SlipEntryExit 방향 적용
    const isHorz = Math.abs(Math.cos(rawDir * Math.PI / 180)) > 0.7;
    const direction = (isHorz && horzDirOverride !== null) ? horzDirOverride : rawDir;
    lineLoads.push({ x: pt.x, y: pt.y, value, direction });
  }

  if (!pressureLines.length && !lineLoads.length) return null;
  return { pressureLines, lineLoads };
}

// ─── 수위선 파싱 ──────────────────────────────────────────────
function extractPiezometricLines(doc, analysisName) {
  if (!doc) return [];
  let analysisId = null;
  for (const a of doc.querySelectorAll("Analyses > Analysis")) {
    const nameEl = a.querySelector("Name");
    if (nameEl && nameEl.textContent.trim() === analysisName) {
      analysisId = a.querySelector("ID")?.textContent.trim() ?? null;
      break;
    }
  }
  if (!analysisId) return [];
  let slopeEntry = null;
  for (const si of doc.querySelectorAll("SlopeItems > SlopeItem")) {
    const aid = si.querySelector("AnalysisID")?.textContent.trim();
    if (aid === analysisId) { slopeEntry = si.querySelector("Entry"); break; }
  }
  if (!slopeEntry) return [];
  const dpMap = new Map();
  for (const dp of slopeEntry.querySelectorAll(":scope > DataPoints > DataPoint")) {
    const num = dp.getAttribute("Number");
    if (num) dpMap.set(num, { x: parseFloat(dp.getAttribute("X")), y: parseFloat(dp.getAttribute("Y")) });
  }
  const lines = [];
  for (const pl of slopeEntry.querySelectorAll("PiezometricLines > PiezometricLine")) {
    const dpNums = [...pl.querySelectorAll("DataPoints > DataPoint")].map((d) => d.textContent.trim());
    const pts = dpNums.map((n) => dpMap.get(n)).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length >= 2) lines.push(pts);
  }
  return lines;
}

function getPrimaryPiezo(piezoLines) {
  if (!piezoLines || !piezoLines.length) return null;
  if (piezoLines.length === 1) return piezoLines[0];
  let best = piezoLines[0], bestAvg = -Infinity;
  for (const line of piezoLines) {
    const avg = line.reduce((s, p) => s + p.y, 0) / line.length;
    if (avg > bestAvg) { bestAvg = avg; best = line; }
  }
  return best;
}

function getPiezoY(sortedPts, x) {
  if (!sortedPts || !sortedPts.length) return NaN;
  if (x <= sortedPts[0].x) return sortedPts[0].y;
  if (x >= sortedPts[sortedPts.length - 1].x) return sortedPts[sortedPts.length - 1].y;
  for (let i = 0; i < sortedPts.length - 1; i++) {
    if (x >= sortedPts[i].x && x <= sortedPts[i + 1].x) {
      const t = (x - sortedPts[i].x) / (sortedPts[i + 1].x - sortedPts[i].x);
      return sortedPts[i].y + t * (sortedPts[i + 1].y - sortedPts[i].y);
    }
  }
  return sortedPts[sortedPts.length - 1].y;
}

// ─── View Region 렌더 — 동일 물성 인접 리즌 경계 통합 ────────
function renderRegionsViewRegion(ctx, assignedRegions, regionMatMap, matColorMap, toC) {
  // 물성치별로 리즌 그룹화
  const matGroups = new Map();
  for (const r of assignedRegions) {
    const matId = regionMatMap.get(r.id);
    if (!matGroups.has(matId)) matGroups.set(matId, []);
    matGroups.get(matId).push(r);
  }

  for (const [matId, groupRegions] of matGroups) {
    const fillCol = matColorMap.get(matId);

    // 이 그룹 내 엣지 등장 횟수 집계 (PointID 기반, 방향 무관)
    const edgeCount = new Map();
    for (const r of groupRegions) {
      const n = r.pointIds.length;
      for (let i = 0; i < n; i++) {
        const a = r.pointIds[i];
        const b = r.pointIds[(i + 1) % n];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
      }
    }
    // 그룹 내 2개 이상 리즌이 공유하는 엣지 = 내부 경계 → 선 생략
    const interiorEdges = new Set();
    for (const [key, count] of edgeCount) {
      if (count >= 2) interiorEdges.add(key);
    }

    // 채우기: 그룹의 모든 리즌을 하나의 path로
    ctx.beginPath();
    for (const r of groupRegions) {
      if (!r.coords.length) continue;
      const [sx, sy] = toC(r.coords[0].x, r.coords[0].y);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < r.coords.length; i++) {
        const [cx2, cy2] = toC(r.coords[i].x, r.coords[i].y);
        ctx.lineTo(cx2, cy2);
      }
      ctx.closePath();
    }
    ctx.fillStyle = fillCol;
    ctx.fill("nonzero");

    // 외곽선: 내부 엣지만 제외하고 그리기
    ctx.beginPath();
    for (const r of groupRegions) {
      if (!r.coords.length) continue;
      const n = r.pointIds.length;
      for (let i = 0; i < n; i++) {
        const a = r.pointIds[i];
        const b = r.pointIds[(i + 1) % n];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!interiorEdges.has(key)) {
          const [x1, y1] = toC(r.coords[i].x, r.coords[i].y);
          const [x2, y2] = toC(r.coords[(i + 1) % n].x, r.coords[(i + 1) % n].y);
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
        }
      }
    }
    ctx.strokeStyle = "#555";
    ctx.lineWidth   = 0.7;
    ctx.setLineDash([]);
    ctx.stroke();
  }
}

// ─── 수위 채색 — 리즌 그리기 전 호출 ─────────────────────────
function drawWaterFill(ctx, piezoLines, toC, gMinX, gMaxX, gMinY, isDark) {
  const mainPiez = getPrimaryPiezo(piezoLines);
  if (!mainPiez) return;
  const sorted = [...mainPiez].sort((a, b) => a.x - b.x);
  const cPts   = sorted.map((p) => toC(p.x, p.y));

  const [leftCx]  = toC(gMinX, 0);
  const [rightCx] = toC(gMaxX, 0);
  const [, leftCy]   = toC(gMinX, getPiezoY(sorted, gMinX));
  const [, rightCy]  = toC(gMaxX, getPiezoY(sorted, gMaxX));
  const [, bottomCy] = toC(gMinX, gMinY);  // 리즌 최저 Y — 이 아래로 채우지 않음

  ctx.save();
  ctx.fillStyle = isDark ? "rgba(50,110,190,0.30)" : "rgba(100,170,230,0.35)";
  ctx.beginPath();
  ctx.moveTo(leftCx, bottomCy);
  ctx.lineTo(leftCx, leftCy);
  for (const [cx, cy] of cPts) ctx.lineTo(cx, cy);
  ctx.lineTo(rightCx, rightCy);
  ctx.lineTo(rightCx, bottomCy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── 수위선 — 리즌 그린 후 호출 (수압 화살표 없음) ──────────
function drawWaterSurface(ctx, piezoLines, toC, gMinX, gMaxX, isDark) {
  const mainPiez = getPrimaryPiezo(piezoLines);
  if (!mainPiez) return;
  const sorted = [...mainPiez].sort((a, b) => a.x - b.x);
  const cPts   = sorted.map((p) => toC(p.x, p.y));

  const [leftCx]  = toC(gMinX, 0);
  const [rightCx] = toC(gMaxX, 0);
  const [, leftCy]  = toC(gMinX, getPiezoY(sorted, gMinX));
  const [, rightCy] = toC(gMaxX, getPiezoY(sorted, gMaxX));

  ctx.save();
  ctx.strokeStyle = isDark ? "rgba(80,150,240,0.90)" : "rgba(20,90,210,0.85)";
  ctx.lineWidth   = 1.8;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(leftCx, leftCy);
  for (const [cx, cy] of cPts) ctx.lineTo(cx, cy);
  ctx.lineTo(rightCx, rightCy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// ─── 상재하중 렌더 ────────────────────────────────────────────
function drawSurchargeLoads(ctx, surchargeLoads, toC, _topPx, _H, isDark, gMinX, gMaxX) {
  if (!surchargeLoads) return;
  const { pressureLines, lineLoads } = surchargeLoads;

  const loadColor  = isDark ? "rgba(230,230,230,0.95)" : "rgba(20,20,20,0.90)";
  const ARROW_H_PX = 10;
  const HEAD_H     = 4.5;
  const HEAD_W     = 2.5;

  ctx.save();

  // ── PressureLine (분포 상재하중) ──────────────────────────
  for (const pl of pressureLines) {
    // X 범위를 리즌 bounds로 클램프, y는 선형 보간
    const xSpan = pl.x2 - pl.x1 || 1;
    const cx1m  = Math.max(gMinX, Math.min(gMaxX, pl.x1));
    const cx2m  = Math.max(gMinX, Math.min(gMaxX, pl.x2));
    const cy1m  = pl.y1 + (cx1m - pl.x1) / xSpan * (pl.y2 - pl.y1) - 1;
    const cy2m  = pl.y1 + (cx2m - pl.x1) / xSpan * (pl.y2 - pl.y1) - 1;

    const [cx1, cy1] = toC(cx1m, cy1m);
    const [cx2, cy2] = toC(cx2m, cy2m);
    const spanPx = Math.abs(cx2 - cx1);
    if (spanPx < 1) continue;

    ctx.strokeStyle = loadColor;
    ctx.fillStyle   = loadColor;
    ctx.setLineDash([]);

    // 상단 베이스선: 지형면과 평행하게 ARROW_H_PX 위에
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1 - ARROW_H_PX);
    ctx.lineTo(cx2, cy2 - ARROW_H_PX);
    ctx.stroke();

    // 화살표: 각 위치의 보간된 지형면 y에 화살촉이 정확히 닿음
    const nArrows = Math.max(2, Math.round(spanPx / 9) + 1);
    for (let i = 0; i < nArrows; i++) {
      const t     = (nArrows > 1) ? i / (nArrows - 1) : 0;
      const ax    = cx1 + t * (cx2 - cx1);
      const faceY = cy1 + t * (cy2 - cy1);

      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, faceY - ARROW_H_PX);
      ctx.lineTo(ax, faceY - HEAD_H);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(ax,          faceY);
      ctx.lineTo(ax - HEAD_W, faceY - HEAD_H);
      ctx.lineTo(ax + HEAD_W, faceY - HEAD_H);
      ctx.closePath();
      ctx.fill();
    }

  }

  // ── LineLoad (집중 선하중, direction 기반 방향) ───────────
  for (const ll of lineLoads) {
    if (ll.x < gMinX || ll.x > gMaxX) continue;
    const [cx, cy] = toC(ll.x, ll.y);

    const deg   = Number.isFinite(ll.direction) ? ll.direction : 270;
    const angle = deg * Math.PI / 180;
    const dx    = Math.cos(angle);
    const dy    = -Math.sin(angle);
    const nx    = -dy, ny = dx;

    const tailX     = cx - dx * ARROW_H_PX;
    const tailY     = cy - dy * ARROW_H_PX;
    const headBaseX = cx - dx * HEAD_H;
    const headBaseY = cy - dy * HEAD_H;

    ctx.strokeStyle = loadColor;
    ctx.fillStyle   = loadColor;

    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headBaseX, headBaseY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(headBaseX + nx * HEAD_W, headBaseY + ny * HEAD_W);
    ctx.lineTo(headBaseX - nx * HEAD_W, headBaseY - ny * HEAD_W);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

// ─── 캔버스 렌더 ─────────────────────────────────────────────
/**
 * 리즌 채색 + 파괴원호 + 상재하중을 canvas에 그린다.
 *
 * opts:
 *   forExcel  {boolean} - true면 흰 배경 + 검정 텍스트 (Excel용)
 *             false/기본: 투명 배경 + 테마 적응 텍스트 (웹 뷰용)
 *   width     {number}  - 오프스크린 캔버스 강제 너비
 *   height    {number}  - 오프스크린 캔버스 강제 높이
 */
export function renderResultCanvas(canvas, regions, materials, regionMatMap, slip, surchargeLoads, piezoLines, opts = {}) {
  const W = opts.width || canvas.offsetWidth || 700;
  const ctx = canvas.getContext("2d");

  if (!regions.length) {
    canvas.width  = W;
    canvas.height = opts.height || canvas.offsetHeight || 280;
    return null;
  }

  const matColorMap = new Map();
  materials.forEach((m) => matColorMap.set(m.id, m.color));

  // 물성치 할당된 리즌만 대상
  const assignedRegions = regions.filter((r) => {
    const matId = regionMatMap.get(r.id);
    return matId && matColorMap.has(matId);
  });

  if (!assignedRegions.length) {
    canvas.width  = W;
    canvas.height = opts.height || canvas.offsetHeight || 280;
    return null;
  }

  // 좌표 범위: 할당된 리즌만으로 산정
  let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
  for (const r of assignedRegions) {
    for (const c of r.coords) {
      if (c.x < gMinX) gMinX = c.x;
      if (c.x > gMaxX) gMaxX = c.x;
      if (c.y < gMinY) gMinY = c.y;
      if (c.y > gMaxY) gMaxY = c.y;
    }
  }
  if (gMinX === Infinity) return null;

  const gW = gMaxX - gMinX || 1;
  const gH = gMaxY - gMinY || 1;

  const topPx  = 56;
  const hPad   = opts.forExcel ? 0 : 14;   // Excel: 좌우 여백 없음
  const btmPad = opts.forExcel ? 0 : 12;   // Excel: 하부 여백 없음

  // 너비 기준으로만 스케일 산정 → 높이는 콘텐츠에 맞게 결정
  const scale  = (W - 2 * hPad) / gW;
  const drawW  = gW * scale;
  const drawH  = gH * scale;
  const H      = Math.round(topPx + drawH + btmPad);

  canvas.width  = W;
  canvas.height = H;

  // 배경: 웹은 투명, Excel은 흰색
  ctx.clearRect(0, 0, W, H);
  if (opts.forExcel) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
  }

  const offX   = hPad + (W - 2 * hPad - drawW) / 2;
  const offY   = topPx + drawH;

  const tf    = { scale, offX, offY, minX: gMinX, minY: gMinY };
  const toC   = (x, y) => [offX + (x - gMinX) * scale, offY - (y - gMinY) * scale];
  const isDark = !opts.forExcel && document.documentElement.getAttribute("data-theme") === "dark";

  // 수위 채색 (리즌 뒤에 가려지는 구조이므로 먼저 그림)
  drawWaterFill(ctx, piezoLines, toC, gMinX, gMaxX, gMinY, isDark);

  // 리즌 채색 (물성치 할당된 것만)
  if (opts.viewRegion) {
    // View Region: 동일 물성 인접 리즌 내부 경계 숨김
    renderRegionsViewRegion(ctx, assignedRegions, regionMatMap, matColorMap, toC);
  } else {
    for (const r of assignedRegions) {
      if (!r.coords.length) continue;
      const matId   = regionMatMap.get(r.id);
      const fillCol = matColorMap.get(matId);

      ctx.beginPath();
      const [sx, sy] = toC(r.coords[0].x, r.coords[0].y);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < r.coords.length; i++) {
        const [cx2, cy2] = toC(r.coords[i].x, r.coords[i].y);
        ctx.lineTo(cx2, cy2);
      }
      ctx.closePath();

      ctx.fillStyle = fillCol;
      ctx.fill();
      ctx.strokeStyle = "#555";
      ctx.lineWidth   = 0.7;
      ctx.setLineDash([]);
      ctx.stroke();
    }
  }

  // 수위선 (파선)
  drawWaterSurface(ctx, piezoLines, toC, gMinX, gMaxX, isDark);

  // 상재하중
  drawSurchargeLoads(ctx, surchargeLoads, toC, topPx, H, isDark, gMinX, gMaxX);

  // 파괴원호 + FOS 텍스트
  if (slip && Number.isFinite(slip.centerX)) {
    drawSlipCircle(ctx, slip, tf, W, H, topPx, assignedRegions, toC, isDark);
  }

  return tf;
}

/**
 * 파괴원호: 물성치 할당된 리즌만 클리핑 마스크 사용.
 * FOS 텍스트는 상단 topPx 영역.
 */
function drawSlipCircle(ctx, slip, tf, W, H, topPx, assignedRegions, toC, _isDark) {
  const { centerX: cx, centerY: cy, radius: r, fos } = slip;
  const ccx = tf.offX + (cx - tf.minX) * tf.scale;
  const ccy = tf.offY - (cy - tf.minY) * tf.scale;
  const cr  = r * tf.scale;

  // 클리핑: 물성치 할당 리즌만
  ctx.save();
  ctx.beginPath();
  for (const region of assignedRegions) {
    if (!region.coords.length) continue;
    const [sx, sy] = toC(region.coords[0].x, region.coords[0].y);
    ctx.moveTo(sx, sy);
    for (let i = 1; i < region.coords.length; i++) {
      const [px, py] = toC(region.coords[i].x, region.coords[i].y);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
  }
  ctx.clip();

  const slipColor = "#111111";
  ctx.strokeStyle = slipColor;
  ctx.lineWidth   = 2;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(ccx, ccy, cr, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();

  const centerVisible = ccx >= 0 && ccx <= W && ccy >= topPx && ccy <= H;
  const fontSize      = Math.min(28, topPx * 0.55);

  if (centerVisible) {
    // 중심 마커
    ctx.save();
    ctx.fillStyle = "#111111";
    ctx.beginPath();
    ctx.arc(ccx, ccy, 3, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();

    // FOS 텍스트: 밑줄 왼쪽 시작점이 중심점 X, 텍스트는 오른쪽으로 표시
    if (Number.isFinite(fos)) {
      const fosStr = fos.toFixed(3);

      ctx.save();
      ctx.font         = `bold ${fontSize}px 'Pretendard', 'Segoe UI', Arial, sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.textAlign    = "left";
      ctx.strokeStyle  = "#ffffff";
      ctx.lineWidth    = 3;
      ctx.strokeText(fosStr, ccx, ccy + 3);
      ctx.fillStyle    = "#111111";
      ctx.fillText(fosStr, ccx, ccy + 3);

      const tw = ctx.measureText(fosStr).width;
      ctx.strokeStyle = "#111111";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ccx,      ccy + 3);
      ctx.lineTo(ccx + tw, ccy + 3);
      ctx.stroke();
      ctx.restore();
    }
  } else {
    // 중심점이 뷰 밖: X는 중심점 추적(클램프), Y는 topPx 영역 수직 중앙
    if (Number.isFinite(fos)) {
      const fosStr = fos.toFixed(3);
      const margin = 40;
      const textX  = Math.max(margin, Math.min(W - margin, ccx));
      const textY  = (topPx + fontSize) / 2;  // textBaseline=bottom 기준 여백 수직 중앙

      ctx.save();
      ctx.font         = `bold ${fontSize}px 'Pretendard', 'Segoe UI', Arial, sans-serif`;
      ctx.fillStyle    = "#111111";
      ctx.strokeStyle  = "#ffffff";
      ctx.lineWidth    = 3;
      ctx.textAlign    = "left";
      ctx.textBaseline = "bottom";
      ctx.strokeText(fosStr, textX, textY);
      ctx.fillText(fosStr, textX, textY);

      const tw = ctx.measureText(fosStr).width;
      ctx.strokeStyle = "#111111";
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(textX,      textY);
      ctx.lineTo(textX + tw, textY);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ─── 케이스 오버라이드 헬퍼 ──────────────────────────────────
function getEffectiveReq(analysisName) {
  const ov = rvCaseOverrides[analysisName];
  if (ov) {
    if (ov.key === "custom") return Number.isFinite(ov.customReq) ? ov.customReq : 1.3;
    return REQUIRED_FOS[ov.key] ?? 1.3;
  }
  return REQUIRED_FOS[classifyAnalysis(analysisName)] ?? 1.3;
}

// ─── 결과 테이블 렌더 ─────────────────────────────────────────
const CASE_SELECT_OPTIONS = [
  { value: "normal",            label: "상시" },
  { value: "seismic",           label: "지진시" },
  { value: "eccentric_normal",  label: "상시(편심)" },
  { value: "eccentric_seismic", label: "지진시(편심)" },
  { value: "construction",      label: "시공시" },
  { value: "custom",            label: "사용자화" },
];

function setReqCell(reqCell, judgeCell, fos, req) {
  reqCell.textContent = req.toFixed(1);
  const j = fosJudge(fos, req);
  judgeCell.textContent = j.label;
  judgeCell.className   = j.cls;
  judgeCell.style.fontWeight = "600";
}

function syncInfoPanel(analysisName) {
  const cur = rvState.allResults[rvState.selectedIdx];
  if (cur?.analysisName === analysisName) updateInfoPanel(cur);
}

function renderResultTable(allResults) {
  const tbody = $("rv-result-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!allResults.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">결과 없음</td></tr>';
    return;
  }

  for (const r of allResults) {
    const initKey   = classifyAnalysis(r.analysisName);
    const initReq   = REQUIRED_FOS[initKey] ?? 1.3;
    const initJudge = fosJudge(r.fos, initReq);
    const colorCls  = fosColorClass(r.fos);

    const optHtml = CASE_SELECT_OPTIONS.map(o =>
      `<option value="${o.value}"${o.value === initKey ? " selected" : ""}>${esc(o.label)}</option>`
    ).join("");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align:left;padding-left:8px">${esc(r.analysisName)}</td>
      <td style="padding:2px 4px">
        <select style="width:100%;font-size:11px;padding:2px">${optHtml}</select>
      </td>
      <td class="${colorCls}">${Number.isFinite(r.fos) ? r.fos.toFixed(3) : "—"}</td>
      <td data-cell="req">${initReq.toFixed(1)}</td>
      <td data-cell="judge" class="${initJudge.cls}" style="font-weight:600">${initJudge.label}</td>
      <td>${r.slipId}</td>
      <td>${Number.isFinite(r.centerX) ? r.centerX.toFixed(2) : "—"}</td>
      <td>${Number.isFinite(r.radius)  ? r.radius.toFixed(2)  : "—"}</td>
    `;

    const sel       = tr.querySelector("select");
    const reqCell   = tr.querySelector("[data-cell='req']");
    const judgeCell = tr.querySelector("[data-cell='judge']");

    sel.addEventListener("change", () => {
      if (sel.value === "custom") {
        const prev = rvCaseOverrides[r.analysisName]?.customReq ?? initReq;
        rvCaseOverrides[r.analysisName] = { key: "custom", customReq: prev };
        reqCell.innerHTML = `<input type="number" step="0.1" min="0.1" max="9.9"
          style="width:52px;font-size:13px;text-align:center;background:var(--surface2);color:var(--fg);border:1px solid var(--border);border-radius:3px;padding:1px 3px"
          value="${prev.toFixed(1)}">`;
        const inp = reqCell.querySelector("input");
        inp.addEventListener("input", () => {
          const v = parseFloat(inp.value);
          const safe = Number.isFinite(v) && v > 0 ? v : prev;
          rvCaseOverrides[r.analysisName] = { key: "custom", customReq: safe };
          const j = fosJudge(r.fos, safe);
          judgeCell.textContent = j.label;
          judgeCell.className   = j.cls;
          judgeCell.style.fontWeight = "600";
          syncInfoPanel(r.analysisName);
        });
        judgeCell.textContent = fosJudge(r.fos, prev).label;
        judgeCell.className   = fosJudge(r.fos, prev).cls;
        judgeCell.style.fontWeight = "600";
      } else {
        rvCaseOverrides[r.analysisName] = { key: sel.value };
        const newReq = REQUIRED_FOS[sel.value] ?? 1.3;
        setReqCell(reqCell, judgeCell, r.fos, newReq);
      }
      syncInfoPanel(r.analysisName);
    });

    tbody.appendChild(tr);
  }
}

// ─── 케이스 선택 드롭다운 채우기 ─────────────────────────────
function populateCaseSelects(allResults) {
  const selIds = {
    construction:      "rv-case-construction",
    normal:            "rv-case-normal",
    seismic:           "rv-case-seismic",
    eccentric_normal:  "rv-case-eccentric-normal",
    eccentric_seismic: "rv-case-eccentric-seismic",
  };

  for (const [caseKey, selId] of Object.entries(selIds)) {
    const sel = $(selId);
    if (!sel) continue;
    sel.innerHTML = '<option value="">선택 안함</option>';
    allResults.forEach((r, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      const fosStr = Number.isFinite(r.fos) ? ` (FOS=${r.fos.toFixed(3)})` : "";
      opt.textContent = `${r.analysisName}${fosStr}`;
      sel.appendChild(opt);
    });
    // 키워드 기반 자동 선택 (최소 FOS)
    let bestIdx = -1, bestFos = Infinity;
    allResults.forEach((r, i) => {
      if (classifyAnalysis(r.analysisName) === caseKey && r.fos < bestFos) {
        bestFos = r.fos;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) sel.value = String(bestIdx);
  }
}

// ─── 사용자 선택 대표 결과 ────────────────────────────────────
function getUserRepresentative() {
  const keys    = ["construction", "normal", "seismic"];
  const selIds  = ["rv-case-construction", "rv-case-normal", "rv-case-seismic"];
  const rep     = { construction: null, normal: null, seismic: null };
  for (let i = 0; i < keys.length; i++) {
    const sel = $(selIds[i]);
    const val = sel ? sel.value.trim() : "";
    if (val === "") continue;
    const idx = parseInt(val, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < rvState.allResults.length) {
      rep[keys[i]] = rvState.allResults[idx];
    }
  }
  return rep;
}

// ─── 캔버스 업데이트 ──────────────────────────────────────────
async function updateCanvas(idx) {
  if (!rvState.allResults.length) return;
  const result = rvState.allResults[idx];
  if (!result) return;

  const canvas = $("rv-canvas");
  if (!canvas) return;

  await document.fonts.ready;

  const regionMatMap   = extractRegionMaterials(rvState.doc, result.analysisName);
  const surchargeLoads = extractSurchargeLoads(rvState.doc, result.analysisName);
  const piezoLines     = extractPiezometricLines(rvState.doc, result.analysisName);
  const slip = Number.isFinite(result.centerX)
    ? { centerX: result.centerX, centerY: result.centerY, radius: result.radius, fos: result.fos }
    : null;

  renderResultCanvas(canvas, rvState.regions, rvState.materials, regionMatMap, slip, surchargeLoads, piezoLines,
    { viewRegion: rvViewRegion });
  updateInfoPanel(result);
}

function updateInfoPanel(result) {
  const req      = getEffectiveReq(result.analysisName);
  const judge    = fosJudge(result.fos, req);
  const colorCls = fosColorClass(result.fos);

  const el = $("rv-info-panel");
  if (!el) return;
  el.innerHTML = `
    <div class="rv-info-row">
      <span class="rv-info-label">안전율 (FOS)</span>
      <span class="rv-fos-value ${colorCls}">${Number.isFinite(result.fos) ? result.fos.toFixed(3) : "—"}</span>
    </div>
    <div class="rv-info-row">
      <span class="rv-info-label">기준 안전율</span>
      <span>${req.toFixed(1)}</span>
    </div>
    <div class="rv-info-row">
      <span class="rv-info-label">판정</span>
      <span class="${judge.cls}" style="font-weight:700;font-size:1.1em">${judge.label}</span>
    </div>
    <hr style="border-color:var(--border);margin:8px 0">
    <div class="rv-info-row">
      <span class="rv-info-label">임계 슬립 ID</span>
      <span>${result.slipId}</span>
    </div>
    <div class="rv-info-row">
      <span class="rv-info-label">중심 X</span>
      <span>${Number.isFinite(result.centerX) ? result.centerX.toFixed(2) : "—"} m</span>
    </div>
    <div class="rv-info-row">
      <span class="rv-info-label">중심 Y</span>
      <span>${Number.isFinite(result.centerY) ? result.centerY.toFixed(2) : "—"} m</span>
    </div>
    <div class="rv-info-row">
      <span class="rv-info-label">반경</span>
      <span>${Number.isFinite(result.radius) ? result.radius.toFixed(2) : "—"} m</span>
    </div>
  `;
}

// ─── PNG 다운로드 ─────────────────────────────────────────────
function downloadCanvasImage() {
  const canvas = $("rv-canvas");
  if (!canvas) return;
  const result = rvState.allResults[rvState.selectedIdx];
  const name   = result ? result.analysisName.replace(/[/\\:*?"<>|]/g, "_") : "result";
  const a = document.createElement("a");
  a.download = `${name}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
}

// ─── 파일 로드 ────────────────────────────────────────────────
async function loadGszFile(file) {
  const JSZip = await getJSZip();
  const buf   = await file.arrayBuffer();
  const zip   = await JSZip.loadAsync(buf);

  rvState.zip = zip;
  rvCaseOverrides = {};

  const doc = await parseRootXml(zip);
  rvState.doc       = doc;
  rvState.materials = doc ? extractMaterials(doc) : [];
  rvState.regions   = doc ? extractRegions(doc)   : [];

  setStatus("해석 결과 파싱 중...");
  rvState.allResults = await parseAllResults(zip);
  rvState.selectedIdx = 0;

  // 해석 선택 드롭다운
  const sel = $("rv-analysis-select");
  if (sel) {
    sel.innerHTML = "";
    rvState.allResults.forEach((r, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      const fosStr = Number.isFinite(r.fos) ? ` (FOS=${r.fos.toFixed(3)})` : "";
      opt.textContent = `${r.analysisName}${fosStr}`;
      sel.appendChild(opt);
    });
  }

  // Excel 케이스 선택 드롭다운 채우기
  populateCaseSelects(rvState.allResults);

  renderResultTable(rvState.allResults);
  updateCanvas(0);
  setStatus(`${rvState.allResults.length}개 해석 로드 완료`);
}

function setStatus(msg) {
  const el = $("rv-status");
  if (el) el.textContent = msg;
}

// ─── 물성치 JSON 업로드 / 분류 UI ────────────────────────────
const GROUND_KW_RV = ["점토", "모래", "자갈", "풍화토", "암", "퇴적", "기반암"];
function guessCategory(name) {
  return GROUND_KW_RV.some((kw) => name.includes(kw)) ? "ground" : "structure";
}

function renderCategoryUI(materials) {
  const tbody = $("rv-mat-category-tbody");
  const wrap  = $("rv-mat-category-wrap");
  if (!tbody || !wrap) return;
  tbody.innerHTML = "";
  for (const m of materials) {
    const key  = m.id ?? m.name;
    const def  = rvCustomMats?.categories?.[key] ?? guessCategory(m.name);
    const uw   = Number.isFinite(parseFloat(m.uw))  ? m.uw  : "-";
    const dw   = Number.isFinite(parseFloat(m.dw))  ? m.dw  : "-";
    const phi  = Number.isFinite(parseFloat(m.phi)) ? m.phi : "-";
    let cDisp;
    if (m.model === "SFnDepth") {
      const cr = parseFloat(m.c_rate), ct = parseFloat(m.c_top);
      cDisp = (Number.isFinite(cr) && Number.isFinite(ct)) ? `${cr}Z+${ct}` : "-";
    } else if (m.model === "SFnDatum") {
      const cr = parseFloat(m.c_rate), cd = parseFloat(m.c_datum);
      cDisp = (Number.isFinite(cr) && Number.isFinite(cd)) ? `${cr}Z+${cd}` : "-";
    } else {
      cDisp = Number.isFinite(parseFloat(m.c)) ? m.c : "-";
    }
    const tr   = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(m.name)}</td>
      <td style="text-align:center">${esc(m.model ?? "MohrCoulomb")}</td>
      <td style="text-align:center">${esc(String(uw))}</td>
      <td style="text-align:center">${esc(String(dw))}</td>
      <td style="text-align:center">${esc(String(phi))}</td>
      <td style="text-align:center">${esc(String(cDisp))}</td>
      <td>
        <label style="margin-right:12px;white-space:nowrap">
          <input type="radio" name="mat-cat-${esc(key)}" value="structure" ${def === "structure" ? "checked" : ""}> 사용재료
        </label>
        <label style="margin-right:12px;white-space:nowrap">
          <input type="radio" name="mat-cat-${esc(key)}" value="ground" ${def === "ground" ? "checked" : ""}> 원지반
        </label>
        <label style="white-space:nowrap">
          <input type="radio" name="mat-cat-${esc(key)}" value="foundation" ${def === "foundation" ? "checked" : ""}> 기초처리
        </label>
      </td>`;
    tr.dataset.matKey = key;
    tbody.appendChild(tr);
  }
  wrap.style.display = "";
}

function collectCategories() {
  const tbody = $("rv-mat-category-tbody");
  if (!tbody) return {};
  const cats = {};
  for (const tr of tbody.querySelectorAll("tr")) {
    const key    = tr.dataset.matKey;
    const checked = tr.querySelector("input[type=radio]:checked");
    if (key && checked) cats[key] = checked.value;
  }
  return cats;
}

function handleMatJsonUpload(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      const mats = json.materials ?? json;
      if (!Array.isArray(mats) || !mats.length) throw new Error("materials 배열이 비어 있습니다.");
      const cats = {};
      for (const m of mats) cats[m.id ?? m.name] = guessCategory(m.name);
      rvCustomMats = { materials: mats, categories: cats };
      const nameEl = $("rv-mat-json-name");
      if (nameEl) nameEl.textContent = file.name;
      const clearBtn = $("rv-mat-json-clear");
      if (clearBtn) clearBtn.style.display = "";
      renderCategoryUI(mats);
    } catch (err) {
      alert(`JSON 파싱 실패: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function clearMatJson() {
  rvCustomMats = null;
  const inp = $("rv-mat-json");
  if (inp) inp.value = "";
  const nameEl = $("rv-mat-json-name");
  if (nameEl) nameEl.textContent = "";
  const clearBtn = $("rv-mat-json-clear");
  if (clearBtn) clearBtn.style.display = "none";
  const wrap = $("rv-mat-category-wrap");
  if (wrap) wrap.style.display = "none";
}

function getCustomMaterialsForExcel() {
  if (!rvCustomMats) return null;
  const cats = collectCategories();
  const structure = [], ground = [], foundation = [];
  for (const m of rvCustomMats.materials) {
    const key = m.id ?? m.name;
    const cat = cats[key] ?? guessCategory(m.name);
    const nm = {
      name:       m.name,
      model:      m.model ?? "MohrCoulomb",
      uw:         parseFloat(m.uw         ?? ""),
      dw:         parseFloat(m.dw         ?? ""),
      c:          parseFloat(m.c          ?? ""),
      phi:        parseFloat(m.phi        ?? ""),
      c_top:      parseFloat(m.c_top      ?? ""),
      c_rate:     parseFloat(m.c_rate     ?? ""),
      c_datum:    parseFloat(m.c_datum    ?? ""),
      datum_elev: parseFloat(m.datum_elev ?? ""),
    };
    if (cat === "ground") ground.push(nm);
    else if (cat === "foundation") foundation.push(nm);
    else structure.push(nm);
  }
  return { structure, ground, foundation };
}

// ─── Excel 보고서 생성 ────────────────────────────────────────
async function handleExcelDownload() {
  if (!rvState.zip || !rvState.allResults.length) {
    alert("먼저 GSZ 파일을 업로드하세요.");
    return;
  }

  const projectName   = ($("rv-excel-project")?.value  ?? "").trim() || "프로젝트명";
  const structureName = ($("rv-excel-structure")?.value ?? "").trim() || "구조물명";
  const sectionName   = ($("rv-excel-section")?.value  ?? "").trim() || "단면명";

  const rep = getUserRepresentative();
  const hasAny = Object.values(rep).some((v) => v != null);
  if (!hasAny) {
    alert("시공시/상시/지진시 중 하나 이상을 선택하세요.");
    return;
  }

  const btnEl = $("rv-excel-btn");
  if (btnEl) btnEl.disabled = true;
  setStatus("Excel 생성 중...");

  try {
    // 오프스크린 캔버스 (Excel 이미지용) — 너비 고정, 높이는 리즌 범위에 맞게 자동 산정
    const CANVAS_W = 900;
    const offCanvas = document.createElement("canvas");

    async function makePng(caseResult) {
      if (!caseResult) return null;
      const rmap           = extractRegionMaterials(rvState.doc, caseResult.analysisName);
      const surchargeLoads = extractSurchargeLoads(rvState.doc, caseResult.analysisName);
      const piezoLines     = extractPiezometricLines(rvState.doc, caseResult.analysisName);
      const slip = Number.isFinite(caseResult.centerX)
        ? { centerX: caseResult.centerX, centerY: caseResult.centerY, radius: caseResult.radius, fos: caseResult.fos }
        : null;
      renderResultCanvas(offCanvas, rvState.regions, rvState.materials, rmap, slip, surchargeLoads, piezoLines,
        { forExcel: true, width: CANVAS_W, viewRegion: rvViewRegion });
      return offCanvas.toDataURL("image/png");
    }

    const images = {
      construction: await makePng(rep.construction),
      normal:       await makePng(rep.normal),
      seismic:      await makePng(rep.seismic),
    };

    // renderResultCanvas가 콘텐츠 높이로 canvas.height를 갱신하므로 그 값을 사용
    const actualCanvasH = offCanvas.height;

    // 편심하중 데이터 수집
    let eccentricOpts = null;
    const eccEnabled = $("rv-eccentric-enable")?.checked;
    if (eccEnabled) {
      const getNum = (id) => parseFloat($(`rv-ecc-${id}`)?.value ?? "");
      const B       = getNum("B");
      const D       = getNum("D");
      const gamma   = getNum("gamma");
      const gammaW  = getNum("gammaW");
      const Vn      = getNum("Vn"),  Hn  = getNum("Hn"),  Mvn = getNum("Mvn"), Mhn = getNum("Mhn");
      const Ve      = getNum("Ve"),  He  = getNum("He"),  Mve = getNum("Mve"), Mhe = getNum("Mhe");

      const allNums = [B, D, gamma, Vn, Hn, Mvn, Mhn, Ve, He, Mve, Mhe];
      if (allNums.every(Number.isFinite)) {
        const getEccResult = (selId) => {
          const sel = $(selId);
          if (!sel || sel.value === "") return null;
          const idx = parseInt(sel.value, 10);
          return Number.isFinite(idx) ? rvState.allResults[idx] : null;
        };
        const eccNormal  = getEccResult("rv-case-eccentric-normal");
        const eccSeismic = getEccResult("rv-case-eccentric-seismic");

        const imgEccN = await makePng(eccNormal);
        const imgEccE = await makePng(eccSeismic);

        eccentricOpts = {
          structureName,
          sectionName,
          inputs: { B, D, gamma_sat: gamma, gamma_w: Number.isFinite(gammaW) ? gammaW : 10.3,
                    V_n: Vn, H_n: Hn, Mv_n: Mvn, Mh_n: Mhn, V_e: Ve, H_e: He, Mv_e: Mve, Mh_e: Mhe },
          fos:    { eccentric_normal:  eccNormal?.fos  ?? null,
                    eccentric_seismic: eccSeismic?.fos ?? null },
          images: { eccentric_normal:  imgEccN,
                    eccentric_seismic: imgEccE },
        };
      } else {
        alert("편심하중 입력값이 모두 입력되지 않았습니다. 편심 시트를 건너뜁니다.");
      }
    }

    const blob = await generateStructuralReport({
      representative: rep,
      materials:      rvState.materials,
      images,
      projectName,
      structureName,
      sectionName,
      canvasW: CANVAS_W,
      canvasH: actualCanvasH,
      customMaterials: getCustomMaterialsForExcel(),
      eccentric: eccentricOpts,
    });

    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href     = url;
    a.download = `구조계산서_${structureName}_${sectionName}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("Excel 생성 완료");
  } catch (e) {
    console.error(e);
    setStatus(`Excel 생성 실패: ${e.message}`);
    alert(`Excel 생성 실패: ${e.message}`);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

// ─── 초기화 ───────────────────────────────────────────────────
export function initResultViewer() {
  const fileInput = $("rv-file");
  const sel       = $("rv-analysis-select");
  const pngBtn    = $("rv-png-btn");
  const excelBtn  = $("rv-excel-btn");

  if (!fileInput) return;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const labelEl = $("rv-file-name");
    if (labelEl) labelEl.textContent = file.name;
    setStatus("파일 로드 중...");
    try {
      await loadGszFile(file);
    } catch (e) {
      console.error(e);
      setStatus(`오류: ${e.message}`);
    }
  });

  if (sel) {
    sel.addEventListener("change", () => {
      rvState.selectedIdx = parseInt(sel.value ?? "0", 10);
      updateCanvas(rvState.selectedIdx);
    });
  }

  if (pngBtn)   pngBtn.addEventListener("click", downloadCanvasImage);
  if (excelBtn) excelBtn.addEventListener("click", handleExcelDownload);

  const matJsonInput = $("rv-mat-json");
  const matJsonClear = $("rv-mat-json-clear");
  if (matJsonInput) {
    matJsonInput.addEventListener("change", () => {
      const file = matJsonInput.files[0];
      if (file) handleMatJsonUpload(file);
    });
  }
  if (matJsonClear) matJsonClear.addEventListener("click", clearMatJson);

  // 편심하중 체크박스 toggle
  const eccChk = $("rv-eccentric-enable");
  const eccInputs = $("rv-eccentric-inputs");
  if (eccChk && eccInputs) {
    eccChk.addEventListener("change", () => {
      eccInputs.style.display = eccChk.checked ? "" : "none";
    });
  }

  // 기초조건 JSON 가져오기
  const importBtn  = $("rv-ecc-import-json");
  const importFile = $("rv-ecc-json-file");
  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const d = JSON.parse(e.target.result);
          const set = (id, val) => { const el = $(id); if (el && val !== undefined && val !== null) el.value = val; };
          set("rv-ecc-B",      d.B);
          set("rv-ecc-D",      d.D);
          set("rv-ecc-gamma",  d.gamma_sat);
          set("rv-ecc-gammaW", d.gamma_w);
          set("rv-ecc-Vn",     d.V_n);
          set("rv-ecc-Hn",     d.H_n);
          set("rv-ecc-Mvn",    d.Mv_n);
          set("rv-ecc-Mhn",    d.Mh_n);
          set("rv-ecc-Ve",     d.V_e);
          set("rv-ecc-He",     d.H_e);
          set("rv-ecc-Mve",    d.Mv_e);
          set("rv-ecc-Mhe",    d.Mh_e);
        } catch {
          alert("JSON 파일을 읽는데 실패했습니다.");
        }
        ev.target.value = "";
      };
      reader.readAsText(file);
    });
  }

  const viewRegionChk = $("rv-view-region");
  if (viewRegionChk) {
    viewRegionChk.addEventListener("change", () => {
      rvViewRegion = viewRegionChk.checked;
      if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
    });
  }

  document.querySelectorAll('.tab-btn[data-tab="result"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      requestAnimationFrame(() => {
        if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
      });
    });
  });

  window.addEventListener("resize", () => {
    if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
  });
}

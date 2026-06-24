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

// 이미지 높이/너비 고정 옵션 (null = 자동)
let rvFixedHeight = null;
let rvFixedWidth  = null;   // 오른쪽 경계 (full canvas 기준 px), null = 자동
let rvCropLeft    = 0;      // 왼쪽 크롭 px (0 = 자르지 않음)

// 파괴원호 스타일
let rvSlipStyle = {
  lineWidth:       2,       // 선 두께 (px)
  outline:         false,   // 외곽선 halo + 점선 모드
  fosScale:        1.0,     // FOS 글자 크기 배율
  fosAlign:        "auto",  // FOS 레이블 위치: "auto" | "left" | "right"
  slipColor:       "#111111",             // 포락선 색
  slipHaloColor:   "#ffffff",             // 포락선 외곽선(halo) 색
  slipHaloWidth:   5,       // 포락선 halo 추가 두께 (px, arc lineWidth 위에 더해짐)
  fosColor:          "#111111",           // FOS 문자 색
  fosUnderlineColor: "#111111",           // FOS 밑줄 색
  fosOutlineColor:   "#ffffff",           // FOS 문자 외곽선 색
  fosOutlineWidth:   3,     // FOS 문자 외곽선 두께 (px)
  fosTextOutline:    false, // FOS 문자 외곽선 표시 여부
};

// 파괴원호 스타일 애니메이션 — 현재 렌더링 중인 보간값
let rvSlipStyleAnim = {
  lineWidth: 2, fosScale: 1.0, outlineT: 0.0,
  fosAlign: "auto",
  slipColor: "#111111", slipHaloColor: "#ffffff", slipHaloWidth: 5,
  fosColor: "#111111", fosUnderlineColor: "#111111",
  fosOutlineColor: "#ffffff", fosOutlineWidth: 3,
  fosTextOutline: false,
};
let _slipAnimId     = null;
let rvRenderCache   = null;  // { regionMatMap, surchargeLoads, piezoLines, slip }

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

// ─── SlipEntryExit 파싱 ───────────────────────────────────────
// 각 해석의 탐색 범위(진입·탈출 x 경계, LeftOption=Point 좌표)를 추출
function extractSlipEntryExit(doc, analysisName) {
  if (!doc) return null;
  let analysisId = null;
  for (const a of doc.querySelectorAll("Analyses > Analysis")) {
    if (a.querySelector("Name")?.textContent.trim() === analysisName) {
      analysisId = a.querySelector("ID")?.textContent.trim() ?? null;
      break;
    }
  }
  if (!analysisId) return null;
  let slopeEntry = null;
  for (const si of doc.querySelectorAll("SlopeItems > SlopeItem")) {
    if (si.querySelector("AnalysisID")?.textContent.trim() === analysisId) {
      slopeEntry = si.querySelector("Entry");
      break;
    }
  }
  if (!slopeEntry) return null;
  const see = slopeEntry.querySelector("SlipEntryExit");
  if (!see) return null;

  const ga = (el, attr) => parseFloat(el?.getAttribute(attr) ?? "NaN");
  const leftLL  = see.querySelector("LeftSideLeftPt");
  const leftRL  = see.querySelector("LeftSideRightPt");
  const rightLL = see.querySelector("RightSideLeftPt");
  const rightRL = see.querySelector("RightSideRightPt");

  const llX = ga(leftLL,  "X"), llY = ga(leftLL,  "Y");
  const lrX = ga(leftRL,  "X"), lrY = ga(leftRL,  "Y");
  const rlX = ga(rightLL, "X"), rlY = ga(rightLL, "Y");
  const rrX = ga(rightRL, "X"), rrY = ga(rightRL, "Y");
  if (!Number.isFinite(llX) || !Number.isFinite(rrX)) return null;

  return {
    leftOption:  see.querySelector("LeftOption")?.textContent.trim()  ?? null,
    rightOption: see.querySelector("RightOption")?.textContent.trim() ?? null,
    leftX:   Math.min(llX, lrX),
    rightX:  Math.max(rlX, rrX),
    leftPtX: (llX + lrX) / 2,
    leftPtY: (llY + lrY) / 2,
    rightPtX: (rlX + rrX) / 2,
    rightPtY: (rlY + rrY) / 2,
  };
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
    ctx.lineWidth = 1.5;
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
  const autoH  = Math.round(topPx + drawH + btmPad);
  // fixedHeight가 지정된 경우 해당 값으로 캔버스 높이 고정
  const H      = (opts.fixedHeight && opts.fixedHeight > 0) ? opts.fixedHeight : autoH;

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
  if (slip && (slip.profile?.length >= 2 || Number.isFinite(slip.centerX))) {
    if (slip.profile?.length >= 2) {
      drawSlipProfile(ctx, slip, tf, W, H, topPx, slip.profile, toC, isDark,
        { ...(opts.slipStyle ?? {}), forExcel: !!opts.forExcel });
    } else {
      drawSlipCircle(ctx, slip, tf, W, H, topPx, regions, toC, isDark,
        { ...(opts.slipStyle ?? {}), forExcel: !!opts.forExcel },
        opts.slipEntryExit ?? null);
    }
  }

  return tf;
}

/** parseAllResults 항목 → 캔버스 slip 객체 */
function buildSlipPayload(result) {
  const hasProfile = Array.isArray(result.profile) && result.profile.length >= 2;
  const hasCenter  = Number.isFinite(result.centerX);
  if (!hasProfile && !hasCenter) return null;
  return {
    centerX: result.centerX,
    centerY: result.centerY,
    radius:  result.radius,
    fos:     result.fos,
    profile: hasProfile ? result.profile : null,
  };
}

/**
 * FOS 텍스트 + 슬립 중심 마커 (drawSlipCircle / drawSlipProfile 공통).
 */
function drawSlipFosAndCenter(ctx, { ccx, ccy, fos, W, H, topPx, isRTL, slipStyle }) {
  const centerVisible = ccx >= 0 && ccx <= W && ccy >= topPx && ccy <= H;
  const fontSize      = Math.min(28, topPx * 0.55) * (slipStyle.fosScale ?? 1.0);

  if (centerVisible) {
    ctx.save();
    ctx.fillStyle = "#111111";
    ctx.beginPath();
    ctx.arc(ccx, ccy, 3, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();

    if (Number.isFinite(fos)) {
      const fosStr         = fos.toFixed(3);
      const fosFill        = slipStyle.fosColor          ?? "#111111";
      const fosUnderline   = slipStyle.fosUnderlineColor ?? fosFill;
      const fosStroke      = slipStyle.fosOutlineColor   ?? "#ffffff";
      const showFosOutline = slipStyle.fosTextOutline    ?? false;

      ctx.save();
      ctx.font         = `bold ${fontSize}px 'HakgyoansimBareondotumB', '학교안심 바름돋움B', 'Pretendard', 'Segoe UI', Arial, sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.textAlign    = isRTL ? "right" : "left";
      if (showFosOutline) {
        ctx.strokeStyle = fosStroke;
        ctx.lineWidth   = slipStyle.fosOutlineWidth ?? 3;
        ctx.strokeText(fosStr, ccx, ccy + 3);
      }
      ctx.fillStyle = fosFill;
      ctx.fillText(fosStr, ccx, ccy + 3);

      const tw = ctx.measureText(fosStr).width;
      ctx.strokeStyle = fosUnderline;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      if (isRTL) {
        ctx.moveTo(ccx - tw, ccy + 3);
        ctx.lineTo(ccx,      ccy + 3);
      } else {
        ctx.moveTo(ccx,      ccy + 3);
        ctx.lineTo(ccx + tw, ccy + 3);
      }
      ctx.stroke();
      ctx.restore();
    }
    return;
  }

  if (Number.isFinite(fos)) {
    const fosStr         = fos.toFixed(3);
    const margin         = 40;
    const textY          = (topPx + fontSize) / 2;
    const fosFill        = slipStyle.fosColor          ?? "#111111";
    const fosUnderline   = slipStyle.fosUnderlineColor ?? fosFill;
    const fosStroke      = slipStyle.fosOutlineColor   ?? "#ffffff";
    const showFosOutline = slipStyle.fosTextOutline    ?? false;

    ctx.save();
    ctx.font         = `bold ${fontSize}px 'HakgyoansimBareondotumB', '학교안심 바름돋움B', 'Pretendard', 'Segoe UI', Arial, sans-serif`;
    ctx.fillStyle    = fosFill;
    ctx.strokeStyle  = fosStroke;
    ctx.lineWidth    = slipStyle.fosOutlineWidth ?? 3;
    ctx.textBaseline = "bottom";

    const tw = ctx.measureText(fosStr).width;
    let textX;
    if (isRTL) {
      textX = Math.max(margin + tw, Math.min(W - margin, ccx));
      ctx.textAlign = "right";
    } else {
      textX = Math.max(margin, Math.min(W - margin - tw, ccx));
      ctx.textAlign = "left";
    }
    if (showFosOutline) ctx.strokeText(fosStr, textX, textY);
    ctx.fillText(fosStr, textX, textY);

    ctx.strokeStyle = fosUnderline;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    if (isRTL) {
      ctx.moveTo(textX - tw, textY);
      ctx.lineTo(textX,      textY);
    } else {
      ctx.moveTo(textX,      textY);
      ctx.lineTo(textX + tw, textY);
    }
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * GeoStudio slice_{slipId}.csv 프로파일로 파괴포락선을 그린다.
 * GSZ 해석결과와 동일한 좌표열을 사용한다.
 */
function drawSlipProfile(ctx, slip, tf, W, H, topPx, profile, toC, _isDark, slipStyle = {}) {
  const canvasPts = profile.map((p) => toC(p.x, p.y));
  if (canvasPts.length < 2) return;

  const { centerX: cx, centerY: cy, fos } = slip;
  const hasCenter = Number.isFinite(cx) && Number.isFinite(cy);
  const midIdx    = Math.floor(canvasPts.length / 2);
  const ccx = hasCenter
    ? tf.offX + (cx - tf.minX) * tf.scale
    : canvasPts[midIdx][0];
  const ccy = hasCenter
    ? tf.offY - (cy - tf.minY) * tf.scale
    : canvasPts[midIdx][1];

  const fosAlign = slipStyle.fosAlign ?? "auto";
  const profileMidX = canvasPts[midIdx][0];
  const isRTL = fosAlign !== "auto"
    ? fosAlign === "left"
    : ccx > profileMidX;

  const lw       = slipStyle.lineWidth ?? 2;
  const outlineT = slipStyle.outlineT != null ? slipStyle.outlineT
                 : (slipStyle.outline ? 1.0 : 0.0);
  const arcColor  = slipStyle.slipColor     ?? "#111111";
  const haloColor = slipStyle.slipHaloColor ?? "#ffffff";

  const strokePath = () => {
    ctx.beginPath();
    ctx.moveTo(canvasPts[0][0], canvasPts[0][1]);
    for (let i = 1; i < canvasPts.length; i++) {
      ctx.lineTo(canvasPts[i][0], canvasPts[i][1]);
    }
    ctx.stroke();
  };

  if (outlineT < 0.99) {
    ctx.save();
    ctx.globalAlpha = 1 - outlineT;
    ctx.setLineDash([]);
    ctx.strokeStyle = arcColor;
    ctx.lineWidth   = lw;
    strokePath();
    ctx.restore();
  }

  if (outlineT > 0.01) {
    ctx.save();
    ctx.globalAlpha = outlineT * 0.92;
    ctx.setLineDash([]);
    ctx.strokeStyle = haloColor;
    ctx.lineWidth   = lw + (slipStyle.slipHaloWidth ?? 5);
    strokePath();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = outlineT;
    ctx.setLineDash([10, 6]);
    ctx.strokeStyle = arcColor;
    ctx.lineWidth   = lw;
    strokePath();
    ctx.restore();
  }

  drawSlipFosAndCenter(ctx, { ccx, ccy, fos, W, H, topPx, isRTL, slipStyle });
}

/**
 * 파괴원호: 전체 리즌(미할당 포함) 기준 지형 클리핑.
 * FOS 텍스트는 상단 topPx 영역.
 */
function drawSlipCircle(ctx, slip, tf, W, H, topPx, allRegions, toC, _isDark, slipStyle = {}, entryExit = null) {
  const { centerX: cx, centerY: cy, radius: r, fos } = slip;
  const ccx = tf.offX + (cx - tf.minX) * tf.scale;
  const ccy = tf.offY - (cy - tf.minY) * tf.scale;
  const cr  = r * tf.scale;

  // 모델 수평 범위: 전체 리즌 기준 (미할당 리즌도 모델 도메인의 일부)
  let mLeft = Infinity, mRight = -Infinity;
  for (const region of allRegions) {
    for (const pt of region.coords) {
      const [px] = toC(pt.x, pt.y);
      if (px < mLeft)  mLeft  = px;
      if (px > mRight) mRight = px;
    }
  }
  if (!Number.isFinite(mLeft)) { mLeft = 0; mRight = W - 1; }
  mLeft  = Math.max(0, Math.floor(mLeft));
  mRight = Math.min(W - 1, Math.ceil(mRight));

  // 지표면 프로파일: 전체 리즌 기준 — 미할당 리즌 사이 공백에서 잘림 방지
  // groundYReal: 실제 리즌 엣지가 있는 열인지 추적 (false 교점 필터링에 사용)
  const groundY     = new Float32Array(W).fill(H);
  const groundYReal = new Uint8Array(W);         // 1 = 실제 리즌 엣지에서 채워진 열
  for (const region of allRegions) {
    const n = region.coords.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = toC(region.coords[i].x, region.coords[i].y);
      const [x2, y2] = toC(region.coords[(i + 1) % n].x, region.coords[(i + 1) % n].y);
      const xMin = Math.max(0, Math.floor(Math.min(x1, x2)));
      const xMax = Math.min(W - 1, Math.ceil(Math.max(x1, x2)));
      const dx   = x2 - x1;
      for (let x = xMin; x <= xMax; x++) {
        const y = Math.abs(dx) < 0.001 ? Math.min(y1, y2) : y1 + (x - x1) / dx * (y2 - y1);
        if (y < groundY[x]) { groundY[x] = y; groundYReal[x] = 1; }
      }
    }
  }
  // 모델 범위 내 미채움 열만 topPx로 처리, 범위 외부는 H 유지(= 클립 불가 → 미렌더)
  for (let x = 0; x < W; x++) {
    if (groundY[x] >= H) {
      groundY[x] = (x >= mLeft && x <= mRight) ? topPx : H;
    }
  }

  // SlipEntryExit 기반 탐색 범위 제한 — 해석 경계 밖의 false 교점 방지
  let searchLeft  = mLeft;
  let searchRight = mRight;
  let leftAngleOverride = null;   // LeftOption=Point: 진입점 좌표로 직접 계산

  if (entryExit) {
    const [cxL] = toC(entryExit.leftX,  0);
    const [cxR] = toC(entryExit.rightX, 0);
    searchLeft  = Math.max(mLeft,  Math.floor(cxL) - 1);
    searchRight = Math.min(mRight, Math.ceil(cxR)  + 1);
    if (entryExit.leftOption === "Point") {
      const [epx, epy] = toC(entryExit.leftPtX, entryExit.leftPtY);
      leftAngleOverride = Math.atan2(epy - ccy, epx - ccx);
    }
  }

  // 원과 지표면 교점 탐색 — searchLeft~searchRight 내 실제 리즌 엣지에서만
  const intersections = [];
  for (let x = searchLeft; x < Math.min(searchRight, W - 1); x++) {
    if (!groundYReal[x] || !groundYReal[x + 1]) continue;
    const gx1 = x,     gy1 = groundY[x];
    const gx2 = x + 1, gy2 = groundY[x + 1];
    const ddx = gx2 - gx1;
    const ddy = gy2 - gy1;
    const ax  = gx1 - ccx, ay = gy1 - ccy;
    const A   = ddx * ddx + ddy * ddy;
    const B   = 2 * (ax * ddx + ay * ddy);
    const C   = ax * ax + ay * ay - cr * cr;
    const disc = B * B - 4 * A * C;
    if (disc < 0) continue;
    const sqrtD = Math.sqrt(disc);
    for (const sign of [-1, 1]) {
      const t = (-B + sign * sqrtD) / (2 * A);
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      const tc = Math.max(0, Math.min(1, t));
      const ix = gx1 + tc * ddx;
      const iy = gy1 + tc * ddy;
      intersections.push({ x: ix, angle: Math.atan2(iy - ccy, ix - ccx) });
    }
  }

  // LeftOption 미지정이지만 진입부가 지하인 경우:
  // 좌측 지형면 교점이 없으면 진입 구간 Y 수평선과 원의 교점으로 각도를 직접 산출
  if (leftAngleOverride === null && entryExit && Number.isFinite(entryExit.leftPtY)) {
    const midX = (searchLeft + searchRight) / 2;
    if (!intersections.some(i => i.x < midX)) {
      const [, leftZoneYc] = toC(0, entryExit.leftPtY);
      const dy = leftZoneYc - ccy;
      const d2 = cr * cr - dy * dy;
      if (d2 >= 0) {
        const lx = ccx - Math.sqrt(d2);
        if (lx >= searchLeft && lx <= searchRight) {
          leftAngleOverride = Math.atan2(dy, lx - ccx);
        }
      }
    }
  }

  const strokeArc = (sa, ea, acw) => {
    const lw       = slipStyle.lineWidth ?? 2;
    // outlineT: 0=완전 실선, 1=완전 외곽+점선. 애니메이션 중 0~1 사이 보간값
    const outlineT = slipStyle.outlineT != null ? slipStyle.outlineT
                   : (slipStyle.outline ? 1.0 : 0.0);

    const arcColor  = slipStyle.slipColor     ?? "#111111";
    const haloColor = slipStyle.slipHaloColor ?? "#ffffff";

    // 실선 (outlineT→1 일수록 서서히 사라짐)
    if (outlineT < 0.99) {
      ctx.save();
      ctx.globalAlpha = 1 - outlineT;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(ccx, ccy, cr, sa, ea, acw);
      ctx.strokeStyle = arcColor;
      ctx.lineWidth   = lw;
      ctx.stroke();
      ctx.restore();
    }

    // halo 외곽선 + 점선 (outlineT→0 일수록 서서히 사라짐)
    if (outlineT > 0.01) {
      ctx.save();
      ctx.globalAlpha = outlineT * 0.92;
      ctx.beginPath(); ctx.arc(ccx, ccy, cr, sa, ea, acw);
      ctx.strokeStyle = haloColor;
      ctx.lineWidth   = lw + (slipStyle.slipHaloWidth ?? 5);
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = outlineT;
      ctx.beginPath(); ctx.arc(ccx, ccy, cr, sa, ea, acw);
      ctx.strokeStyle = arcColor;
      ctx.lineWidth   = lw;
      ctx.setLineDash([10, 6]);
      ctx.stroke();
      ctx.restore();
    }
  };

  // 클립 경로: 항상 mLeft~mRight 전체 지형 기준 — searchLeft/Right는 교점 탐색용 제한이므로
  // 클립에 쓰면 searchLeft가 리즌 경계 밖 1px(groundY=topPx)일 때 하늘 영역이 노출됨
  const clipAndDraw = (sa, ea, acw) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(mLeft, groundY[mLeft]);
    for (let x = mLeft + 1; x <= mRight; x++) ctx.lineTo(x, groundY[x]);
    ctx.lineTo(mRight, H); ctx.lineTo(mLeft, H);
    ctx.closePath();
    ctx.clip();
    strokeArc(sa, ea, acw);
    ctx.restore();
  };

  const PI2 = Math.PI / 2;

  if (leftAngleOverride !== null) {
    // LeftOption=Point: 왼쪽 각도 = 진입 고정점 방향, 오른쪽 = 교점 탐색
    const midX = (searchLeft + searchRight) / 2;
    const rightCands = intersections.filter(i => i.x >= midX);
    rightCands.sort((a, b) => a.x - b.x);
    const rightAngle = rightCands.length > 0
      ? rightCands[rightCands.length - 1].angle
      : (intersections.length > 0
          ? [...intersections].sort((a, b) => b.x - a.x)[0].angle
          : null);
    if (rightAngle !== null && leftAngleOverride > PI2 && rightAngle < PI2) {
      clipAndDraw(leftAngleOverride, rightAngle, true);
    } else {
      clipAndDraw(0, 2 * Math.PI, false);
    }
  } else if (intersections.length >= 2) {
    intersections.sort((a, b) => a.x - b.x);
    const midX       = (searchLeft + searchRight) / 2;
    const leftCands  = intersections.filter(i => i.x <  midX);
    const rightCands = intersections.filter(i => i.x >= midX);
    // 좌측: 가장 오른쪽(= 해석 영역 마지막 진입) / 우측: 가장 오른쪽(= 최종 진출)
    const leftAngle  = leftCands.length  > 0 ? leftCands[leftCands.length   - 1].angle : intersections[0].angle;
    const rightAngle = rightCands.length > 0 ? rightCands[rightCands.length - 1].angle : intersections[intersections.length - 1].angle;
    if (leftAngle > PI2 && rightAngle < PI2) {
      clipAndDraw(leftAngle, rightAngle, true);
    } else {
      clipAndDraw(0, 2 * Math.PI, false);
    }
  } else {
    clipAndDraw(0, 2 * Math.PI, false);
  }

  const fosAlign = slipStyle.fosAlign ?? "auto";
  const isRTL = fosAlign !== "auto"
    ? fosAlign === "left"
    : (() => {
        if (intersections.length >= 2) {
          const ixMidX = (intersections[0].x + intersections[intersections.length - 1].x) / 2;
          return ccx > ixMidX;
        }
        return ccx > (mLeft + mRight) / 2;
      })();

  drawSlipFosAndCenter(ctx, { ccx, ccy, fos, W, H, topPx, isRTL, slipStyle });
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
function populateOneSelect(sel, allResults, autoKey) {
  sel.innerHTML = '<option value="">선택 안함</option>';
  allResults.forEach((r, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const fosStr = Number.isFinite(r.fos) ? ` (FOS=${r.fos.toFixed(3)})` : "";
    opt.textContent = `${r.analysisName}${fosStr}`;
    sel.appendChild(opt);
  });
  if (autoKey) {
    let bestIdx = -1, bestFos = Infinity;
    allResults.forEach((r, i) => {
      if (classifyAnalysis(r.analysisName) === autoKey && r.fos < bestFos) {
        bestFos = r.fos;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) sel.value = String(bestIdx);
  }
}

function populateCaseSelects(allResults) {
  const staticSelIds = {
    normal:            "rv-case-normal",
    seismic:           "rv-case-seismic",
    eccentric_normal:  "rv-case-eccentric-normal",
    eccentric_seismic: "rv-case-eccentric-seismic",
  };
  for (const [caseKey, selId] of Object.entries(staticSelIds)) {
    const sel = $(selId);
    if (sel) populateOneSelect(sel, allResults, caseKey);
  }
  // 시공시 단계 드롭다운 전부 채우기
  document.querySelectorAll(".rv-construction-sel").forEach(sel => {
    populateOneSelect(sel, allResults, "construction");
  });
}

// 시공시 단계 행 추가
function addConstructionStageRow(labelText, allResults) {
  const container = $("rv-construction-stages");
  if (!container) return;
  const stageNum = container.querySelectorAll(".rv-stage-row").length + 1;
  const label = labelText ?? `시공시 ${stageNum}단계`;

  const row = document.createElement("div");
  row.className = "rv-case-select-row rv-stage-row";
  row.innerHTML = `
    <input type="text" class="rv-case-label-inp rv-stage-label-inp" value="${label}" placeholder="단계명"/>
    <span class="rv-case-sublabel">해석</span>
    <select class="rv-select rv-case-sel rv-construction-sel">
      <option value="">선택 안함</option>
    </select>
    <button type="button" class="btn rv-stage-remove" style="padding:0;width:26px;height:26px;font-size:13px;line-height:1;flex-shrink:0">✕</button>
  `;
  const sel = row.querySelector("select");
  const results = allResults ?? rvState.allResults;
  if (results.length) populateOneSelect(sel, results, "construction");

  row.querySelector(".rv-stage-remove").addEventListener("click", () => row.remove());
  container.appendChild(row);
}

// ─── 사용자 선택 대표 결과 ────────────────────────────────────
function getUserRepresentative() {
  // 시공시 다단계 수집
  const constructionStages = [];
  document.querySelectorAll("#rv-construction-stages .rv-stage-row").forEach(row => {
    const labelInp = row.querySelector(".rv-stage-label-inp");
    const sel      = row.querySelector(".rv-construction-sel");
    const label    = (labelInp?.value ?? "").trim() || "시공시";
    const val      = sel?.value.trim() ?? "";
    if (val === "") return;
    const idx = parseInt(val, 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < rvState.allResults.length) {
      constructionStages.push({ label, result: rvState.allResults[idx] });
    }
  });

  const getResult = (selId) => {
    const val = $(selId)?.value.trim() ?? "";
    if (!val) return null;
    const idx = parseInt(val, 10);
    return (Number.isFinite(idx) && idx >= 0 && idx < rvState.allResults.length)
      ? rvState.allResults[idx] : null;
  };

  return {
    constructionStages,
    normal:       getResult("rv-case-normal"),
    seismic:      getResult("rv-case-seismic"),
    normalLabel:  ($("rv-label-normal")?.value  ?? "").trim() || "상시",
    seismicLabel: ($("rv-label-seismic")?.value ?? "").trim() || "지진시",
    // 하위 호환 (편심 등에서 사용하는 rep.construction)
    construction: constructionStages.length > 0 ? constructionStages[0].result : null,
  };
}

// ─── 파괴원호 스타일 애니메이션 헬퍼 ─────────────────────────
function renderCached() {
  const canvas = $("rv-canvas");
  if (!canvas || !rvRenderCache) return;
  const { regionMatMap, surchargeLoads, piezoLines, slip, slipEntryExit } = rvRenderCache;
  const wrapEl   = canvas.closest(".rv-canvas-wrap");
  const naturalW = (wrapEl ? wrapEl.clientWidth : 0) || 700;
  const hasCrop  = (rvFixedWidth && rvFixedWidth > 0) || rvCropLeft > 0;
  canvas.style.width = hasCrop ? naturalW + "px" : "";
  renderResultCanvas(canvas, rvState.regions, rvState.materials, regionMatMap, slip, surchargeLoads, piezoLines,
    { viewRegion: rvViewRegion, fixedHeight: rvFixedHeight, slipStyle: rvSlipStyleAnim, slipEntryExit });
  updateResizeOverlay();
}

function startSlipAnim() {
  if (_slipAnimId !== null) cancelAnimationFrame(_slipAnimId);
  const SPEED = 0.14;
  function tick() {
    const t = rvSlipStyle;
    const a = rvSlipStyleAnim;
    let running = false;
    const lerp = (cur, tgt) => {
      const d = tgt - cur;
      if (Math.abs(d) < 0.002) return tgt;
      running = true;
      return cur + d * SPEED;
    };
    a.lineWidth = lerp(a.lineWidth, t.lineWidth);
    a.fosScale  = lerp(a.fosScale,  t.fosScale);
    a.outlineT  = lerp(a.outlineT,  t.outline ? 1.0 : 0.0);
    // 비애니메이션 프로퍼티는 즉시 동기화
    a.fosAlign        = t.fosAlign;
    a.slipColor       = t.slipColor;
    a.slipHaloColor   = t.slipHaloColor;
    a.slipHaloWidth   = t.slipHaloWidth;
    a.fosColor          = t.fosColor;
    a.fosUnderlineColor = t.fosUnderlineColor;
    a.fosOutlineColor   = t.fosOutlineColor;
    a.fosOutlineWidth   = t.fosOutlineWidth;
    a.fosTextOutline    = t.fosTextOutline;
    renderCached();
    _slipAnimId = running ? requestAnimationFrame(tick) : null;
  }
  _slipAnimId = requestAnimationFrame(tick);
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
  const slipEntryExit  = extractSlipEntryExit(rvState.doc, result.analysisName);
  const slip = buildSlipPayload(result);

  // 진행 중인 스타일 애니메이션 취소 → 현재 목표값으로 즉시 스냅
  if (_slipAnimId !== null) { cancelAnimationFrame(_slipAnimId); _slipAnimId = null; }
  rvSlipStyleAnim.lineWidth       = rvSlipStyle.lineWidth;
  rvSlipStyleAnim.fosScale        = rvSlipStyle.fosScale;
  rvSlipStyleAnim.outlineT        = rvSlipStyle.outline ? 1.0 : 0.0;
  rvSlipStyleAnim.fosAlign        = rvSlipStyle.fosAlign;
  rvSlipStyleAnim.slipColor       = rvSlipStyle.slipColor;
  rvSlipStyleAnim.slipHaloColor   = rvSlipStyle.slipHaloColor;
  rvSlipStyleAnim.slipHaloWidth   = rvSlipStyle.slipHaloWidth;
  rvSlipStyleAnim.fosColor          = rvSlipStyle.fosColor;
  rvSlipStyleAnim.fosUnderlineColor = rvSlipStyle.fosUnderlineColor;
  rvSlipStyleAnim.fosOutlineColor   = rvSlipStyle.fosOutlineColor;
  rvSlipStyleAnim.fosOutlineWidth   = rvSlipStyle.fosOutlineWidth;
  rvSlipStyleAnim.fosTextOutline    = rvSlipStyle.fosTextOutline;

  rvRenderCache = { regionMatMap, surchargeLoads, piezoLines, slip, slipEntryExit };
  renderCached();
  updateInfoPanel(result);
}

function updateResizeOverlay() {
  const canvas  = $("rv-canvas");
  const overlay = $("rv-resize-overlay");
  const shadowL = $("rv-shadow-l");
  const shadowR = $("rv-shadow-r");
  if (!canvas || !overlay) return;

  const canvasW = canvas.offsetWidth;
  const h       = canvas.clientHeight;
  if (canvasW <= 0 || h <= 0 || !rvState.allResults.length) {
    overlay.style.display = "none";
    if (shadowL) shadowL.style.display = "none";
    if (shadowR) shadowR.style.display = "none";
    return;
  }

  const visL = rvCropLeft;
  const visR = (rvFixedWidth && rvFixedWidth > 0) ? Math.min(rvFixedWidth, canvasW) : canvasW;
  const visW = Math.max(50, visR - visL);

  // 오버레이: 가시 영역 위에 테두리 표시
  overlay.style.display = "";
  overlay.style.left    = visL + "px";
  overlay.style.top     = "0";
  overlay.style.width   = visW + "px";
  overlay.style.height  = h + "px";

  // 왼쪽 그림자
  if (shadowL) {
    if (visL > 0) {
      shadowL.style.display = "";
      shadowL.style.left    = "0";
      shadowL.style.width   = visL + "px";
      shadowL.style.height  = h + "px";
    } else {
      shadowL.style.display = "none";
    }
  }
  // 오른쪽 그림자
  if (shadowR) {
    if (visR < canvasW) {
      shadowR.style.display = "";
      shadowR.style.left    = visR + "px";
      shadowR.style.width   = (canvasW - visR) + "px";
      shadowR.style.height  = h + "px";
    } else {
      shadowR.style.display = "none";
    }
  }
}

let _rafPending = false;
function scheduleUpdate() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(async () => {
    _rafPending = false;
    if (rvState.allResults.length) await updateCanvas(rvState.selectedIdx);
  });
}

function initResizeHandles() {
  const overlay = $("rv-resize-overlay");
  if (!overlay) return;

  let dragging     = false;
  let dragDir      = "";
  let startX = 0, startY = 0;
  let startVisW = 0, startH = 0, startCanvasW = 0, startCropLeft = 0;

  overlay.querySelectorAll(".rv-handle").forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const canvas = $("rv-canvas");
      if (!canvas || !rvState.allResults.length) return;
      dragging     = true;
      dragDir      = handle.dataset.dir;
      startX       = e.clientX;
      startY       = e.clientY;
      startCanvasW = canvas.offsetWidth;
      // startVisW = 현재 가시 너비 (오버레이 기준)
      const visR   = (rvFixedWidth && rvFixedWidth > 0) ? Math.min(rvFixedWidth, startCanvasW) : startCanvasW;
      startVisW    = visR - rvCropLeft;
      startH       = canvas.clientHeight;
      startCropLeft = rvCropLeft;
    });
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (dragDir === "r" || dragDir === "br") {
      // 오른쪽 경계 = 현재 왼쪽크롭 + 기존가시폭 + dx
      const newRight = Math.round(rvCropLeft + startVisW + dx);
      rvFixedWidth   = Math.max(rvCropLeft + 50, Math.min(startCanvasW, newRight));
      const chk = $("rv-fix-width-enable");
      const val = $("rv-fix-width-val");
      if (chk) chk.checked = true;
      if (val) { val.style.display = ""; val.value = rvFixedWidth - rvCropLeft; }
    }
    if (dragDir === "l") {
      // 왼쪽 핸들 오른쪽으로 드래그 = 왼쪽 크롭 증가
      const maxL   = (rvFixedWidth && rvFixedWidth > 0 ? rvFixedWidth : startCanvasW) - 50;
      rvCropLeft   = Math.max(0, Math.min(maxL, Math.round(startCropLeft + dx)));
    }
    if (dragDir === "b" || dragDir === "br") {
      rvFixedHeight = Math.max(50, Math.min(3000, Math.round(startH + dy)));
      const chk  = $("rv-fix-height-enable");
      const val  = $("rv-fix-height-val");
      const hint = $("rv-fix-height-hint");
      if (chk)  chk.checked = true;
      if (val)  { val.style.display = ""; val.value = rvFixedHeight; }
      if (hint) hint.style.display = "";
    }

    scheduleUpdate();
  });

  document.addEventListener("mouseup", () => { dragging = false; });
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

async function copyCanvasToClipboard() {
  if (!rvRenderCache) return;
  const srcCanvas = $("rv-canvas");
  if (!srcCanvas) return;

  const btn = $("rv-copy-btn");
  const origText = btn?.textContent ?? "";

  try {
    // 흰 배경으로 오프스크린 렌더링 (현재 캔버스와 동일 크기)
    const offCanvas = document.createElement("canvas");
    const { regionMatMap, surchargeLoads, piezoLines, slip, slipEntryExit } = rvRenderCache;
    renderResultCanvas(offCanvas, rvState.regions, rvState.materials, regionMatMap, slip,
      surchargeLoads, piezoLines,
      { forExcel: true, width: srcCanvas.width, viewRegion: rvViewRegion,
        fixedHeight: rvFixedHeight, slipStyle: rvSlipStyle, slipEntryExit });

    const blob = await new Promise((resolve) => offCanvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("blob 생성 실패");

    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);

    if (btn) { btn.textContent = "✓ 복사됨"; setTimeout(() => { btn.textContent = origText; }, 1500); }
  } catch (e) {
    console.error("클립보드 복사 실패:", e);
    if (btn) { btn.textContent = "✗ 실패"; setTimeout(() => { btn.textContent = origText; }, 2000); }
  }
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

  // 시공시 단계 초기화 후 1개 재생성
  const stagesContainer = $("rv-construction-stages");
  if (stagesContainer) {
    stagesContainer.innerHTML = "";
    addConstructionStageRow("시공시", rvState.allResults);
  }

  // Excel 케이스 선택 드롭다운 채우기 (상시/지진시/편심 등)
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
  const hasAny = rep.constructionStages.length > 0 || rep.normal != null || rep.seismic != null;
  if (!hasAny) {
    alert("시공시/상시/지진시 중 하나 이상을 선택하세요.");
    return;
  }

  const btnEl = $("rv-excel-btn");
  if (btnEl) btnEl.disabled = true;
  setStatus("Excel 생성 중...");

  // Excel 버튼 클릭 시점의 UI 값으로 rvFixedHeight 동기화
  // (input blur 없이 바로 클릭한 경우에도 최신값 사용)
  {
    const fhChk = $("rv-fix-height-enable");
    const fhVal = $("rv-fix-height-val");
    if (fhChk && fhVal) {
      rvFixedHeight = fhChk.checked ? (parseInt(fhVal.value, 10) || null) : null;
    }
  }

  try {
    // 오프스크린 캔버스 (Excel 이미지용) — 너비 고정, 높이는 리즌 범위에 맞게 자동 산정
    const CANVAS_W = 900;
    const offCanvas = document.createElement("canvas");

    // 웹 뷰의 크롭 상태를 Excel에 정비율로 반영
    const webCanvas  = $("rv-canvas");
    const nativeW    = (webCanvas?.width) || CANVAS_W;
    const pixelVisL  = rvCropLeft;
    const pixelVisR  = (rvFixedWidth && rvFixedWidth > 0) ? Math.min(rvFixedWidth, nativeW) : nativeW;
    const pixelVisW  = Math.max(1, pixelVisR - pixelVisL);
    const hasCropW   = rvCropLeft > 0 || (rvFixedWidth && rvFixedWidth > 0 && rvFixedWidth < nativeW);
    // Excel 렌더 크기: 가시 너비가 CANVAS_W가 되도록 정비율 확대
    const excelScale   = hasCropW ? CANVAS_W / pixelVisW : 1;
    const excelRenderW = hasCropW ? Math.round(nativeW * excelScale)  : CANVAS_W;
    const excelCropL   = hasCropW ? Math.round(pixelVisL * excelScale) : 0;
    const excelFixedH  = (rvFixedHeight && rvFixedHeight > 0)
      ? Math.round(rvFixedHeight * excelScale)
      : null;

    async function makePng(caseResult) {
      if (!caseResult) return null;
      const rmap           = extractRegionMaterials(rvState.doc, caseResult.analysisName);
      const surchargeLoads = extractSurchargeLoads(rvState.doc, caseResult.analysisName);
      const piezoLines     = extractPiezometricLines(rvState.doc, caseResult.analysisName);
      const slipEntryExit  = extractSlipEntryExit(rvState.doc, caseResult.analysisName);
      const slip = buildSlipPayload(caseResult);
      renderResultCanvas(offCanvas, rvState.regions, rvState.materials, rmap, slip, surchargeLoads, piezoLines,
        { forExcel: true, width: excelRenderW, viewRegion: rvViewRegion, fixedHeight: excelFixedH, slipStyle: rvSlipStyle, slipEntryExit });
      if (!hasCropW) return offCanvas.toDataURL("image/png");
      // 가시 영역만 크롭하여 CANVAS_W × excelH 크기로 출력
      const excelH  = offCanvas.height;
      const outCvs  = document.createElement("canvas");
      outCvs.width  = CANVAS_W;
      outCvs.height = excelH;
      outCvs.getContext("2d").drawImage(offCanvas, excelCropL, 0, CANVAS_W, excelH, 0, 0, CANVAS_W, excelH);
      return outCvs.toDataURL("image/png");
    }

    // 시공시 단계별 PNG 생성
    const constructionCases = [];
    for (const stage of rep.constructionStages) {
      constructionCases.push({
        key: "construction",
        label: stage.label,
        result: stage.result,
        image: await makePng(stage.result),
      });
    }

    const images = {
      normal:  await makePng(rep.normal),
      seismic: await makePng(rep.seismic),
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

    // 케이스 목록: 시공시 단계들 + 상시 + 지진시
    const excelCases = [
      ...constructionCases,
      ...(rep.normal  ? [{ key: "normal",  label: rep.normalLabel,  result: rep.normal,  image: images.normal  }] : []),
      ...(rep.seismic ? [{ key: "seismic", label: rep.seismicLabel, result: rep.seismic, image: images.seismic }] : []),
    ];

    const blob = await generateStructuralReport({
      cases:           excelCases,
      materials:       rvState.materials,
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
  $("rv-copy-btn")?.addEventListener("click", copyCanvasToClipboard);

  // 시공시 단계 추가 버튼
  $("rv-construction-add")?.addEventListener("click", () => addConstructionStageRow());
  // 초기 단계 행 1개 생성 (파일 로드 전이라 드롭다운은 비어있음)
  addConstructionStageRow("시공시");

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

  const fixHeightChk = $("rv-fix-height-enable");
  const fixHeightVal = $("rv-fix-height-val");
  const fixHeightHint = $("rv-fix-height-hint");

  if (fixHeightChk) {
    fixHeightChk.addEventListener("change", () => {
      const on = fixHeightChk.checked;
      fixHeightVal.style.display  = on ? "" : "none";
      fixHeightHint.style.display = on ? "" : "none";
      rvFixedHeight = on ? (parseInt(fixHeightVal.value, 10) || null) : null;
      if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
    });
  }

  if (fixHeightVal) {
    // input: 타이핑 즉시 반영 (blur 없이 Excel 버튼 눌러도 최신값 적용)
    fixHeightVal.addEventListener("input", () => {
      const v = parseInt(fixHeightVal.value, 10);
      rvFixedHeight = (v > 0) ? v : null;
      if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
    });
    fixHeightVal.addEventListener("change", () => {
      const v = parseInt(fixHeightVal.value, 10);
      rvFixedHeight = (v > 0) ? v : null;
      if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
    });
  }

  const fixWidthChk = $("rv-fix-width-enable");
  const fixWidthVal = $("rv-fix-width-val");

  if (fixWidthChk) {
    fixWidthChk.addEventListener("change", () => {
      const on = fixWidthChk.checked;
      fixWidthVal.style.display = on ? "" : "none";
      if (on) {
        // input 값 = 가시 너비 → rvFixedWidth = 가시너비 + 왼쪽크롭
        const v = parseInt(fixWidthVal.value, 10);
        rvFixedWidth = (v > 0) ? v + rvCropLeft : null;
      } else {
        rvFixedWidth = null;
        rvCropLeft   = 0;
      }
      if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
    });
  }

  if (fixWidthVal) {
    const applyWidthVal = () => {
      const v = parseInt(fixWidthVal.value, 10);
      // input은 가시 너비, rvFixedWidth = 가시너비 + 왼쪽크롭 (= 오른쪽 경계)
      rvFixedWidth = (v > 0) ? v + rvCropLeft : null;
      if (rvState.allResults.length) updateCanvas(rvState.selectedIdx);
    };
    fixWidthVal.addEventListener("input",  applyWidthVal);
    fixWidthVal.addEventListener("change", applyWidthVal);
  }

  initResizeHandles();

  // 파괴원호 스타일 컨트롤
  const slipLwSlider  = $("rv-slip-linewidth");
  const slipLwVal     = $("rv-slip-linewidth-val");
  const slipOutline   = $("rv-slip-outline");
  const slipFosSlider = $("rv-slip-fosscale");
  const slipFosVal    = $("rv-slip-fosscale-val");

  if (slipLwSlider) {
    slipLwSlider.addEventListener("input", () => {
      rvSlipStyle.lineWidth = parseFloat(slipLwSlider.value);
      if (slipLwVal) slipLwVal.textContent = slipLwSlider.value;
      if (rvState.allResults.length) startSlipAnim();
    });
  }
  if (slipOutline) {
    slipOutline.addEventListener("change", () => {
      rvSlipStyle.outline = slipOutline.checked;
      if (rvState.allResults.length) startSlipAnim();
    });
  }
  if (slipFosSlider) {
    slipFosSlider.addEventListener("input", () => {
      rvSlipStyle.fosScale = parseFloat(slipFosSlider.value);
      if (slipFosVal) slipFosVal.textContent = parseFloat(slipFosSlider.value).toFixed(1);
      if (rvState.allResults.length) startSlipAnim();
    });
  }

  const fosAlignBtns = $("rv-fos-align-btns");
  if (fosAlignBtns) {
    fosAlignBtns.addEventListener("click", (e) => {
      const btn = e.target.closest(".rv-align-btn");
      if (!btn) return;
      fosAlignBtns.querySelectorAll(".rv-align-btn").forEach(b => b.classList.remove("rv-align-btn--active"));
      btn.classList.add("rv-align-btn--active");
      rvSlipStyle.fosAlign = btn.dataset.align;
      rvSlipStyleAnim.fosAlign = btn.dataset.align;
      if (rvState.allResults.length) renderCached();
    });
  }

  const fosTextOutlineChk = $("rv-fos-text-outline");
  if (fosTextOutlineChk) {
    fosTextOutlineChk.addEventListener("change", () => {
      rvSlipStyle.fosTextOutline = fosTextOutlineChk.checked;
      rvSlipStyleAnim.fosTextOutline = fosTextOutlineChk.checked;
      if (rvState.allResults.length) renderCached();
    });
  }

  const colorFields = [
    ["rv-slip-color",          "slipColor"],
    ["rv-slip-halo-color",     "slipHaloColor"],
    ["rv-fos-color",           "fosColor"],
    ["rv-fos-underline-color", "fosUnderlineColor"],
    ["rv-fos-outline-color",   "fosOutlineColor"],
  ];
  colorFields.forEach(([id, key]) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      rvSlipStyle[key]     = el.value;
      rvSlipStyleAnim[key] = el.value;
      if (rvState.allResults.length) renderCached();
    });
  });

  const slipHaloWSlider = $("rv-slip-halo-width");
  const slipHaloWVal    = $("rv-slip-halo-width-val");
  if (slipHaloWSlider) {
    slipHaloWSlider.addEventListener("input", () => {
      const v = parseFloat(slipHaloWSlider.value);
      rvSlipStyle.slipHaloWidth     = v;
      rvSlipStyleAnim.slipHaloWidth = v;
      if (slipHaloWVal) slipHaloWVal.textContent = v;
      if (rvState.allResults.length) renderCached();
    });
  }

  const fosOutlineWSlider = $("rv-fos-outline-width");
  const fosOutlineWVal    = $("rv-fos-outline-width-val");
  if (fosOutlineWSlider) {
    fosOutlineWSlider.addEventListener("input", () => {
      const v = parseFloat(fosOutlineWSlider.value);
      rvSlipStyle.fosOutlineWidth     = v;
      rvSlipStyleAnim.fosOutlineWidth = v;
      if (fosOutlineWVal) fosOutlineWVal.textContent = v;
      if (rvState.allResults.length) renderCached();
    });
  }

  const copyTableBtn = $("rv-copy-table-btn");
  if (copyTableBtn) {
    copyTableBtn.addEventListener("click", () => {
      const table = $("rv-result-table");
      if (!table) return;
      const rows = Array.from(table.querySelectorAll("tr"));
      const text = rows.map(tr =>
        Array.from(tr.querySelectorAll("th,td")).map(cell => cell.textContent.trim()).join("\t")
      ).join("\n");
      navigator.clipboard.writeText(text).then(() => {
        const orig = copyTableBtn.textContent;
        copyTableBtn.textContent = "복사됨!";
        setTimeout(() => { copyTableBtn.textContent = orig; }, 1500);
      });
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

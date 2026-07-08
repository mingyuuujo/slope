/**
 * GSZ 파라미터 편집 탭
 * - GSZ 업로드 → XML 파싱 → 해석별 파라미터 편집 + 물성치 편집 + 리즌 매핑
 * - 편집 내용 localStorage 자동 저장 → 페이지 재오픈 시 복원
 * - 저장 버튼 클릭 시 편집값 적용된 GSZ 다운로드
 */
import { loadGszFromArrayBuffer, zipToBlob, getJSZip } from "./deps.js";
import {
  serializeXmlDocument,
  findFirstTag,
  allChildEl,
  firstChildEl,
  setMaterialDisplayName,
  createEl,
} from "./xml-utils.js";
import { installTableArrowNav } from "./keyboard-nav.js";

const LS_KEY = "slope-gsz-editor-v2";

// ─── 런타임 상태 ──────────────────────────────────────────────
/**
 * gState: {
 *   xmlText, xmlName, unitWaterWeight,
 *   materials: [{ id, name, colorStr, color, slopeModel, props:{...} }],
 *   regions:   [{ id, pointIds, coords:[{x,y}] }],
 *   slopeItems: [{
 *     analysisId, analysisName, seismicH, seismicV,
 *     pressureLines, lineLoads, slipEntryExit, waterPoints,
 *     regionMaterials: [{ regionId, materialId }]
 *   }]
 * }
 */
let gState = null;
let gZip   = null;
let gActiveIdx = 0;
let gSelectedRegionId = null;

// canvas transform for hit-testing (set when drawing)
let gCanvasTf   = null; // { scale, offX, offY, minX, minY }
let gCanvasView = { zoom: 1, panX: 0, panY: 0 };
let gCanvasWH   = { W: 680, H: 260 };

// ─── localStorage ────────────────────────────────────────────
function saveLS() {
  if (!gState) return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(gState)); } catch (_) {}
}
function loadLS() {
  try { const r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; }
  catch (_) { return null; }
}

// ─── DOM 헬퍼 ────────────────────────────────────────────────
const $id = (id) => document.getElementById(id);

function escHtml(s) {
  const d = document.createElement("div"); d.textContent = s; return d.innerHTML;
}
function toastMsg(msg, ok = true) {
  const el = document.createElement("div");
  el.className = `toast ${ok ? "ok" : "err"}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
function setProgress(pct) {
  const bar = $id("gszedit-progress");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function appendLog(msg) { const el = $id("gszedit-log"); if (el) el.textContent += msg + "\n"; }
function clearLog()    { const el = $id("gszedit-log"); if (el) el.textContent = ""; }

// ─── XML 헬퍼 ────────────────────────────────────────────────
function getAttr(parent, childTag, attr) {
  const c = firstChildEl(parent, childTag);
  return c ? (c.getAttribute(attr) ?? "") : "";
}
function getText(parent, childTag) {
  const c = firstChildEl(parent, childTag);
  return c ? c.textContent.trim() : "";
}

// ─── 색상 ────────────────────────────────────────────────────
function parseRgbColor(str) {
  const m = str?.match(/RGB=\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return "#aaaaaa";
  const [, r, g, b] = m;
  return `#${(+r).toString(16).padStart(2,"0")}${(+g).toString(16).padStart(2,"0")}${(+b).toString(16).padStart(2,"0")}`;
}

// 배경색 밝기에 따라 텍스트 색 결정
function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return (r*299+g*587+b*114)/1000 > 140 ? "#333" : "#fff";
}

// ─── XML → 상태 파싱 ─────────────────────────────────────────

function parseMaterials(doc) {
  const matsEl = findFirstTag(doc, "Materials");
  const materials = [];
  if (!matsEl) return materials;
  for (const mat of allChildEl(matsEl, "Material")) {
    const id        = firstChildEl(mat, "ID")?.textContent.trim() ?? "";
    const name      = firstChildEl(mat, "Name")?.textContent.trim() ?? "";
    const colorStr  = firstChildEl(mat, "Color")?.textContent.trim() ?? "";
    const slopeModel= firstChildEl(mat, "SlopeModel")?.textContent.trim() ?? "";
    const ssEl      = firstChildEl(mat, "StressStrain");
    const props = {};
    if (ssEl) {
      for (let c = ssEl.firstElementChild; c; c = c.nextElementSibling) {
        props[c.tagName] = c.textContent.trim();
      }
    }
    materials.push({ id, name, colorStr, color: parseRgbColor(colorStr), slopeModel, props });
  }
  return materials;
}

function parseRegionsAndPoints(doc) {
  // GeometryItems > Points/Regions (직계 자식으로만 접근 — 다른 곳의 Points 혼동 방지)
  const geomEl = findFirstTag(doc, "GeometryItems");
  const ptsMap = new Map();
  const regions = [];
  if (!geomEl) return { ptsMap, regions };

  const ptsEl = firstChildEl(geomEl, "Points");
  if (ptsEl) {
    for (const pt of allChildEl(ptsEl, "Point")) {
      const pid = pt.getAttribute("ID");
      ptsMap.set(pid, { x: parseFloat(pt.getAttribute("X") || 0), y: parseFloat(pt.getAttribute("Y") || 0) });
    }
  }

  const regionsEl = firstChildEl(geomEl, "Regions");
  if (regionsEl) {
    for (const r of allChildEl(regionsEl, "Region")) {
      const id    = firstChildEl(r, "ID")?.textContent.trim() ?? "";
      const ptStr = firstChildEl(r, "PointIDs")?.textContent.trim() ?? "";
      const pointIds = ptStr.split(",").map(s => s.trim()).filter(Boolean);
      const coords   = pointIds.map(pid => ptsMap.get(pid) || { x: 0, y: 0 });
      if (id) regions.push({ id, pointIds, coords });
    }
  }
  return { ptsMap, regions };
}

function buildContextMap(doc) {
  const map = new Map(); // analysisId → [{regionId, materialId}]
  const contextsEl = findFirstTag(doc, "Contexts");
  if (!contextsEl) return map;
  for (const ctx of allChildEl(contextsEl, "Context")) {
    const aid   = firstChildEl(ctx, "AnalysisID")?.textContent.trim();
    const rumEl = firstChildEl(ctx, "RegionUsesMaterials");
    const items = [];
    if (rumEl) {
      for (let c = rumEl.firstElementChild; c; c = c.nextElementSibling) {
        if (c.tagName === "RegionUsesMaterial") {
          items.push({ regionId: c.getAttribute("ID") ?? "", materialId: c.getAttribute("UsesID") ?? "" });
        }
      }
    }
    if (aid) map.set(aid, items);
  }
  return map;
}

function parseSlopeItem(si, analysesMap, contextMap) {
  const aidEl = firstChildEl(si, "AnalysisID");
  if (!aidEl) return null;
  const analysisId   = aidEl.textContent.trim();
  const analysisName = analysesMap.get(analysisId) || `해석 ${analysisId}`;

  const entry = firstChildEl(si, "Entry");
  if (!entry) return null;

  // Entry DataPoints map
  const dpMap = new Map();
  const dpRootEl = firstChildEl(entry, "DataPoints");
  if (dpRootEl) {
    for (const dp of allChildEl(dpRootEl, "DataPoint")) {
      const num = dp.getAttribute("Number");
      if (num) dpMap.set(num, { x: dp.getAttribute("X") ?? "", y: dp.getAttribute("Y") ?? "" });
    }
  }

  // Seismic
  const seismicEl = firstChildEl(entry, "Seismic");
  const seismicH  = seismicEl ? (seismicEl.getAttribute("Horizontal") ?? "") : "";
  const seismicV  = seismicEl ? (seismicEl.getAttribute("Vertical")   ?? "") : "";

  // PressureLines
  const pressureLines = [];
  const plsEl = firstChildEl(entry, "PressureLines");
  if (plsEl) {
    for (const pl of allChildEl(plsEl, "PressureLine")) {
      pressureLines.push({ id: getText(pl, "ID"), pressure: getText(pl, "Pressure") });
    }
  }

  // LineLoadPoints
  const lineLoads = [];
  const llsEl = firstChildEl(entry, "LineLoadPoints");
  if (llsEl) {
    for (const llp of allChildEl(llsEl, "LineLoadPoint")) {
      const llEl = firstChildEl(llp, "LineLoad");
      lineLoads.push({
        id:        getText(llp, "ID"),
        value:     llEl ? (llEl.getAttribute("Value")     ?? "") : "",
        direction: llEl ? (llEl.getAttribute("Direction") ?? "") : "",
      });
    }
  }

  // SlipEntryExit
  const seeEl = firstChildEl(entry, "SlipEntryExit");
  const see = {
    leftOption: "", leftSideLeftX: "", leftSideLeftY: "",
    leftSideRightX: "", leftSideRightY: "", leftInc: "",
    rightSideLeftX: "", rightSideLeftY: "",
    rightSideRightX: "", rightSideRightY: "", rightInc: "", radiusInc: "",
  };
  if (seeEl) {
    const loEl = firstChildEl(seeEl, "LeftOption");
    see.leftOption       = loEl ? loEl.textContent.trim() : "";
    see.leftSideLeftX    = getAttr(seeEl, "LeftSideLeftPt",   "X");
    see.leftSideLeftY    = getAttr(seeEl, "LeftSideLeftPt",   "Y");
    see.leftSideRightX   = getAttr(seeEl, "LeftSideRightPt",  "X");
    see.leftSideRightY   = getAttr(seeEl, "LeftSideRightPt",  "Y");
    see.leftInc          = getText(seeEl, "LeftInc");
    see.rightSideLeftX   = getAttr(seeEl, "RightSideLeftPt",  "X");
    see.rightSideLeftY   = getAttr(seeEl, "RightSideLeftPt",  "Y");
    see.rightSideRightX  = getAttr(seeEl, "RightSideRightPt", "X");
    see.rightSideRightY  = getAttr(seeEl, "RightSideRightPt", "Y");
    see.rightInc         = getText(seeEl, "RightInc");
    see.radiusInc        = getText(seeEl, "RadiusInc");
  }

  // Water table
  const waterPoints = [];
  const pizsEl = firstChildEl(entry, "PiezometricLines");
  if (pizsEl) {
    const pizEl = firstChildEl(pizsEl, "PiezometricLine");
    if (pizEl) {
      const dpsEl = firstChildEl(pizEl, "DataPoints");
      if (dpsEl) {
        for (const dpRef of allChildEl(dpsEl, "DataPoint")) {
          const numRef = dpRef.textContent.trim();
          const coords = dpMap.get(numRef);
          waterPoints.push({ num: numRef, x: coords ? coords.x : "", y: coords ? coords.y : "" });
        }
      }
    }
  }

  // Region-material mapping from Context
  const regionMaterials = contextMap ? ([...(contextMap.get(analysisId) || [])]) : [];

  return { analysisId, analysisName, seismicH, seismicV, pressureLines, lineLoads,
           slipEntryExit: see, waterPoints, regionMaterials };
}

function parseFromDoc(doc, xmlName, xmlText) {
  const engCoords      = findFirstTag(doc, "EngCoords");
  const unitWaterWeight= engCoords ? (engCoords.getAttribute("UnitWaterWeight") ?? "") : "";

  const analysesMap = new Map();
  const analysesEl  = findFirstTag(doc, "Analyses");
  if (analysesEl) {
    for (const a of allChildEl(analysesEl, "Analysis")) {
      const idEl   = firstChildEl(a, "ID");
      const nameEl = firstChildEl(a, "Name");
      if (idEl) analysesMap.set(idEl.textContent.trim(), nameEl ? nameEl.textContent.trim() : "");
    }
  }

  const contextMap          = buildContextMap(doc);
  const materials           = parseMaterials(doc);
  const { regions }         = parseRegionsAndPoints(doc);

  const slopeItemsEl = findFirstTag(doc, "SlopeItems");
  const slopeItems   = [];
  if (slopeItemsEl) {
    for (const si of allChildEl(slopeItemsEl, "SlopeItem")) {
      const item = parseSlopeItem(si, analysesMap, contextMap);
      if (item) slopeItems.push(item);
    }
  }

  return { xmlText, xmlName, unitWaterWeight, materials, regions, slopeItems };
}

// ─── 상태 → XML 적용 ─────────────────────────────────────────
function applyToDoc(doc, state) {
  // 단위 수중무게
  const engCoords = findFirstTag(doc, "EngCoords");
  if (engCoords && state.unitWaterWeight.trim()) {
    engCoords.setAttribute("UnitWaterWeight", state.unitWaterWeight.trim());
  }

  // ── 물성치 ──
  const matsEl = findFirstTag(doc, "Materials");
  if (matsEl && state.materials) {
    for (const savedMat of state.materials) {
      for (const mat of allChildEl(matsEl, "Material")) {
        const idEl = firstChildEl(mat, "ID");
        if (!idEl || idEl.textContent.trim() !== savedMat.id) continue;

        // 이름 갱신 (Name + legacy n)
        setMaterialDisplayName(mat, doc, savedMat.name);

        // StressStrain 속성 갱신
        const ssEl = firstChildEl(mat, "StressStrain");
        if (ssEl && savedMat.props) {
          for (const [propName, propVal] of Object.entries(savedMat.props)) {
            const propEl = firstChildEl(ssEl, propName);
            if (propEl) {
              propEl.textContent = propVal;
            } else if (propVal.trim()) {
              ssEl.appendChild(createEl(doc, propName, propVal));
            }
          }
        }
        break;
      }
    }
  }

  // ── 해석별 ──
  const analysesEl   = findFirstTag(doc, "Analyses");
  const slopeItemsEl = findFirstTag(doc, "SlopeItems");
  const contextsEl   = findFirstTag(doc, "Contexts");
  if (!slopeItemsEl) return;

  for (const item of state.slopeItems) {
    // Analysis 이름
    if (analysesEl) {
      for (const a of allChildEl(analysesEl, "Analysis")) {
        const idEl = firstChildEl(a, "ID");
        if (idEl && idEl.textContent.trim() === item.analysisId) {
          const nameEl = firstChildEl(a, "Name");
          if (nameEl) nameEl.textContent = item.analysisName;
          break;
        }
      }
    }

    // Context → RegionUsesMaterials
    if (contextsEl) {
      for (const ctx of allChildEl(contextsEl, "Context")) {
        const aidEl = firstChildEl(ctx, "AnalysisID");
        if (!aidEl || aidEl.textContent.trim() !== item.analysisId) continue;
        const rumEl = firstChildEl(ctx, "RegionUsesMaterials");
        if (rumEl && item.regionMaterials) {
          for (const savedRm of item.regionMaterials) {
            for (let c = rumEl.firstElementChild; c; c = c.nextElementSibling) {
              if (c.tagName === "RegionUsesMaterial" && c.getAttribute("ID") === savedRm.regionId) {
                c.setAttribute("UsesID", savedRm.materialId);
                break;
              }
            }
          }
        }
        break;
      }
    }

    // SlopeItem
    let targetSi = null;
    for (const si of allChildEl(slopeItemsEl, "SlopeItem")) {
      const aidEl = firstChildEl(si, "AnalysisID");
      if (aidEl && aidEl.textContent.trim() === item.analysisId) { targetSi = si; break; }
    }
    if (!targetSi) continue;

    const entry = firstChildEl(targetSi, "Entry");
    if (!entry) continue;

    // Seismic
    const seismicEl = firstChildEl(entry, "Seismic");
    if (seismicEl) {
      seismicEl.setAttribute("Horizontal", item.seismicH ?? "");
      seismicEl.setAttribute("Vertical",   item.seismicV ?? "");
    }

    // PressureLines
    const plsEl = firstChildEl(entry, "PressureLines");
    if (plsEl) {
      for (const savedPl of item.pressureLines) {
        for (const pl of allChildEl(plsEl, "PressureLine")) {
          if (getText(pl, "ID") === savedPl.id) {
            const pEl = firstChildEl(pl, "Pressure");
            if (pEl) pEl.textContent = savedPl.pressure;
            break;
          }
        }
      }
    }

    // LineLoadPoints
    const llsEl = firstChildEl(entry, "LineLoadPoints");
    if (llsEl) {
      for (const savedLl of item.lineLoads) {
        for (const llp of allChildEl(llsEl, "LineLoadPoint")) {
          if (getText(llp, "ID") === savedLl.id) {
            const llEl = firstChildEl(llp, "LineLoad");
            if (llEl) {
              llEl.setAttribute("Value",     savedLl.value);
              llEl.setAttribute("Direction", savedLl.direction);
            }
            break;
          }
        }
      }
    }

    // SlipEntryExit
    const seeEl = firstChildEl(entry, "SlipEntryExit");
    if (seeEl) {
      const see = item.slipEntryExit;
      let loEl  = firstChildEl(seeEl, "LeftOption");
      if (see.leftOption === "Point") {
        if (!loEl) { loEl = doc.createElement("LeftOption"); seeEl.insertBefore(loEl, seeEl.firstChild); }
        loEl.textContent = "Point";
      } else if (loEl) { seeEl.removeChild(loEl); }

      function setA(tag, attr, val) { const c = firstChildEl(seeEl, tag); if (c) c.setAttribute(attr, val ?? ""); }
      function setT(tag, val)       { const c = firstChildEl(seeEl, tag); if (c) c.textContent = val ?? ""; }

      setA("LeftSideLeftPt",   "X", see.leftSideLeftX);
      setA("LeftSideLeftPt",   "Y", see.leftSideLeftY);
      setA("LeftSideRightPt",  "X", see.leftSideRightX);
      setA("LeftSideRightPt",  "Y", see.leftSideRightY);
      setT("LeftInc",              see.leftInc);
      setA("RightSideLeftPt",  "X", see.rightSideLeftX);
      setA("RightSideLeftPt",  "Y", see.rightSideLeftY);
      setA("RightSideRightPt", "X", see.rightSideRightX);
      setA("RightSideRightPt", "Y", see.rightSideRightY);
      setT("RightInc",             see.rightInc);
      setT("RadiusInc",            see.radiusInc);
    }

    // Water table DataPoints
    const dpRootEl = firstChildEl(entry, "DataPoints");
    if (dpRootEl && item.waterPoints.length > 0) {
      for (const wp of item.waterPoints) {
        for (const dp of allChildEl(dpRootEl, "DataPoint")) {
          if (dp.getAttribute("Number") === wp.num) {
            dp.setAttribute("X", wp.x);
            dp.setAttribute("Y", wp.y);
            break;
          }
        }
      }
    }
  }
}

// ─── 캔버스 렌더 ─────────────────────────────────────────────
function drawRegionCanvas() {
  const canvas = $id("gszedit-region-canvas");
  if (!canvas || !gState || !gState.regions.length) return;
  if (!gState.slopeItems[gActiveIdx]) return;
  const item = gState.slopeItems[gActiveIdx];

  // 캔버스 실제 픽셀 크기 설정 (CSS width 기반)
  const W = canvas.offsetWidth || 680;
  const H = 260;
  canvas.width  = W;
  canvas.height = H;
  gCanvasWH.W   = W;
  gCanvasWH.H   = H;

  const ctx2d = canvas.getContext("2d");
  ctx2d.clearRect(0, 0, W, H);

  // 리즌 → 물성치 맵
  const rmMap = new Map();
  (item.regionMaterials || []).forEach(rm => rmMap.set(rm.regionId, rm.materialId));
  const matColorMap = new Map();
  const matNameMap  = new Map();
  (gState.materials || []).forEach(m => { matColorMap.set(m.id, m.color); matNameMap.set(m.id, m.name); });

  // 좌표 범위
  let minX =  Infinity, maxX = -Infinity, minY =  Infinity, maxY = -Infinity;
  for (const r of gState.regions) {
    for (const c of r.coords) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    }
  }
  if (minX === Infinity) return;

  const pad = 20;
  const dataW = maxX - minX || 1;
  const dataH = maxY - minY || 1;
  const scale = Math.min((W - 2*pad) / dataW, (H - 2*pad) / dataH);
  const drawW = dataW * scale;
  const drawH = dataH * scale;
  const offX  = pad + (W - 2*pad - drawW) / 2;
  const offY  = H - pad - (H - 2*pad - drawH) / 2;

  gCanvasTf = { scale, offX, offY, minX, minY };

  function toC(x, y) { return [offX + (x - minX)*scale, offY - (y - minY)*scale]; }

  // zoom/pan 변환 적용
  const { zoom, panX, panY } = gCanvasView;
  ctx2d.save();
  ctx2d.translate(W / 2 + panX, H / 2 + panY);
  ctx2d.scale(zoom, zoom);
  ctx2d.translate(-W / 2, -H / 2);

  for (const r of gState.regions) {
    if (!r.coords.length) continue;
    const matId      = rmMap.get(r.id);
    const hasMat     = Boolean(matId && matColorMap.has(matId));
    const fillCol    = hasMat ? matColorMap.get(matId) : null;
    const isSelected = r.id === gSelectedRegionId;

    ctx2d.beginPath();
    const [sx, sy] = toC(r.coords[0].x, r.coords[0].y);
    ctx2d.moveTo(sx, sy);
    for (let i = 1; i < r.coords.length; i++) {
      const [cx, cy] = toC(r.coords[i].x, r.coords[i].y);
      ctx2d.lineTo(cx, cy);
    }
    ctx2d.closePath();

    if (hasMat) {
      ctx2d.fillStyle = fillCol;
      ctx2d.fill();
    }

    ctx2d.setLineDash(hasMat ? [] : [5, 3]);
    ctx2d.strokeStyle = isSelected ? "#1976D2" : (hasMat ? "#555" : "#888");
    ctx2d.lineWidth   = isSelected ? 2.5 / zoom : (hasMat ? 1 / zoom : 1.5 / zoom);
    ctx2d.stroke();
    ctx2d.setLineDash([]);

    // 리즌 번호 표시 (폴리곤 무게중심)
    if (r.coords.length >= 2) {
      const cx = r.coords.reduce((s, c) => s + c.x, 0) / r.coords.length;
      const cy = r.coords.reduce((s, c) => s + c.y, 0) / r.coords.length;
      const [tx, ty] = toC(cx, cy);
      const tcolor = hasMat ? contrastColor(fillCol) : "#888";
      ctx2d.fillStyle   = tcolor;
      ctx2d.font        = `bold ${Math.max(9, Math.min(13, scale*2.5))}px sans-serif`;
      ctx2d.textAlign   = "center";
      ctx2d.textBaseline= "middle";
      ctx2d.fillText(`R${r.id}`, tx, ty);
    }
  }

  ctx2d.restore();
}

function canvasHitRegion(canvasX, canvasY) {
  if (!gCanvasTf || !gState?.regions) return null;
  const { scale, offX, offY, minX, minY } = gCanvasTf;
  const { zoom, panX, panY } = gCanvasView;
  const { W, H } = gCanvasWH;
  // zoom/pan 역변환: 화면 좌표 → 베이스 캔버스 좌표
  const bx = (canvasX - W / 2 - panX) / zoom + W / 2;
  const by = (canvasY - H / 2 - panY) / zoom + H / 2;
  const wx = (bx - offX) / scale + minX;
  const wy = -(by - offY) / scale + minY;

  for (const r of gState.regions) {
    if (pointInPolygon(wx, wy, r.coords)) return r.id;
  }
  return null;
}

function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj-xi)*(py-yi)/(yj-yi))+xi) inside = !inside;
  }
  return inside;
}

// ─── UI 렌더 ─────────────────────────────────────────────────
function renderHint() {
  const el = $id("gszedit-hint");
  if (!el) return;
  el.textContent = gState?.slopeItems.length
    ? `${gState.slopeItems.length}개 해석 · ${gState.materials?.length ?? 0}개 물성치 · ${gState.regions?.length ?? 0}개 리즌 로드됨 (${gState.xmlName ?? ""})`
    : "GSZ 파일을 선택하면 파라미터가 표시됩니다. 이전에 저장된 상태가 있으면 자동으로 복원합니다.";
}

function renderGlobalSettings() {
  const uwInp = $id("gszedit-unit-ww");
  if (!uwInp || !gState) return;
  uwInp.value = gState.unitWaterWeight;
  uwInp.oninput = () => { if (gState) { gState.unitWaterWeight = uwInp.value; saveLS(); } };
}

// ── 물성치 테이블 ─────────────────────────────────────────
const MAT_PROP_COLS = [
  { key: "UnitWeight",                label: "γ (kN/m³)" },
  { key: "CohesionPrime",             label: "c' (kPa)" },
  { key: "PhiPrime",                  label: "φ' (°)" },
  { key: "DryWeight",                 label: "γd (kN/m³)" },
  { key: "CTopOfLayer",               label: "c상단 (kPa)" },
  { key: "CRateOfIncrease",           label: "c증가율" },
];

function renderMaterialsTable() {
  const tbody = $id("gszedit-mat-tbody");
  const hint  = $id("gszedit-mat-hint");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (!gState?.materials?.length) {
    if (hint) hint.style.display = "";
    return;
  }
  if (hint) hint.style.display = "none";

  gState.materials.forEach((mat, mi) => {
    const tr = document.createElement("tr");

    // ID (read-only)
    const tdId = document.createElement("td");
    tdId.className = "map-cell-label";
    const dot = document.createElement("span");
    dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${mat.color};border:1px solid #aaa;margin-right:4px;vertical-align:middle;`;
    tdId.appendChild(dot);
    tdId.appendChild(document.createTextNode(mat.id));
    tr.appendChild(tdId);

    // 이름 (editable)
    const tdName = document.createElement("td");
    const nameInp = document.createElement("input");
    nameInp.type  = "text";
    nameInp.value = mat.name;
    nameInp.className = "gszedit-mat-name-inp";
    nameInp.oninput = () => { gState.materials[mi].name = nameInp.value; saveLS(); };
    tdName.appendChild(nameInp);
    tr.appendChild(tdName);

    // 모델 (read-only)
    const tdModel = document.createElement("td");
    tdModel.textContent = mat.slopeModel;
    tdModel.className   = "map-cell-label";
    tr.appendChild(tdModel);

    // 속성 컬럼
    for (const col of MAT_PROP_COLS) {
      const td  = document.createElement("td");
      const val = mat.props?.[col.key];
      if (val !== undefined) {
        const inp = document.createElement("input");
        inp.type  = "text";
        inp.value = val;
        inp.className = "gszedit-mat-prop-inp";
        inp.oninput = () => { gState.materials[mi].props[col.key] = inp.value; saveLS(); };
        td.appendChild(inp);
      } else {
        td.textContent = "—";
        td.className   = "gszedit-mat-na";
      }
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  });
}

// ── 해석 탭 ──────────────────────────────────────────────────
function renderAnalysisTabs() {
  const tabsEl = $id("gszedit-analysis-tabs");
  if (!tabsEl) return;
  tabsEl.innerHTML = "";
  if (!gState?.slopeItems.length) return;

  gState.slopeItems.forEach((item, idx) => {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = "gszedit-atab-btn" + (idx === gActiveIdx ? " active" : "");
    const label   = item.analysisName.length > 18 ? item.analysisName.slice(0, 18) + "…" : item.analysisName;
    btn.textContent = `${item.analysisId}. ${label}`;
    btn.title       = `해석 ${item.analysisId}: ${item.analysisName}`;
    btn.addEventListener("click", () => {
      gActiveIdx = idx;
      gSelectedRegionId = null;
      renderAnalysisTabs();
      renderActiveAnalysis();
    });
    tabsEl.appendChild(btn);
  });
}

function renderActiveAnalysis() {
  const editorEl = $id("gszedit-analysis-editor");
  if (!editorEl) return;
  if (!gState || gActiveIdx >= gState.slopeItems.length) {
    editorEl.style.display = "none";
    return;
  }
  editorEl.style.display = "";
  const item = gState.slopeItems[gActiveIdx];

  wireText("gszedit-name",     item, "analysisName");
  wireText("gszedit-seismic-h", item, "seismicH");
  renderPressureTable(item);
  renderLineLoadTable(item);
  renderSlipEntryExit(item);
  renderWaterTable(item);
  renderRegionMapping(item);
}

function wireText(inputId, item, prop) {
  const inp = $id(inputId);
  if (!inp) return;
  inp.value = item[prop] ?? "";
  inp.oninput = () => { item[prop] = inp.value; saveLS(); };
}

function wireCoord(inputId, see, prop) {
  const inp = $id(inputId);
  if (!inp) return;
  inp.value = see[prop] ?? "";
  inp.oninput = () => { see[prop] = inp.value; saveLS(); };
}

function renderPressureTable(item) {
  const tbody = $id("gszedit-pressure-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!item.pressureLines.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="gszedit-empty-cell">없음</td></tr>';
    return;
  }
  item.pressureLines.forEach((pl, pi) => {
    const tr = document.createElement("tr");
    const tdId = document.createElement("td"); tdId.className = "map-cell-label"; tdId.textContent = `PL-${pl.id}`;
    const tdP  = document.createElement("td");
    const inp  = document.createElement("input"); inp.type = "text"; inp.value = pl.pressure;
    inp.oninput = () => { item.pressureLines[pi].pressure = inp.value; saveLS(); };
    tdP.appendChild(inp);
    tr.appendChild(tdId); tr.appendChild(tdP); tbody.appendChild(tr);
  });
}

function renderLineLoadTable(item) {
  const tbody = $id("gszedit-lineload-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!item.lineLoads.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="gszedit-empty-cell">없음</td></tr>';
    return;
  }
  item.lineLoads.forEach((ll, li) => {
    const tr = document.createElement("tr");
    const tdId  = document.createElement("td"); tdId.className = "map-cell-label"; tdId.textContent = `LL-${ll.id}`;
    const tdVal = document.createElement("td");
    const vInp  = document.createElement("input"); vInp.type = "text"; vInp.value = ll.value;
    vInp.oninput = () => { item.lineLoads[li].value = vInp.value; saveLS(); };
    tdVal.appendChild(vInp);
    const tdDir = document.createElement("td");
    const dInp  = document.createElement("input"); dInp.type = "text"; dInp.value = ll.direction;
    dInp.oninput = () => { item.lineLoads[li].direction = dInp.value; saveLS(); };
    tdDir.appendChild(dInp);
    tr.appendChild(tdId); tr.appendChild(tdVal); tr.appendChild(tdDir); tbody.appendChild(tr);
  });
}

function renderSlipEntryExit(item) {
  const see     = item.slipEntryExit;
  const isPoint = see.leftOption === "Point";
  const ml = $id("gszedit-left-mode-label"); if (ml) ml.textContent = isPoint ? "점(Point)" : "범위(Range)";
  const rr = $id("gszedit-left-range-rows");  if (rr) rr.style.display = isPoint ? "none" : "";
  wireCoord("gszedit-left-l-x",   see, "leftSideLeftX");
  wireCoord("gszedit-left-l-y",   see, "leftSideLeftY");
  wireCoord("gszedit-left-r-x",   see, "leftSideRightX");
  wireCoord("gszedit-left-r-y",   see, "leftSideRightY");
  wireCoord("gszedit-left-inc",   see, "leftInc");
  wireCoord("gszedit-right-l-x",  see, "rightSideLeftX");
  wireCoord("gszedit-right-l-y",  see, "rightSideLeftY");
  wireCoord("gszedit-right-r-x",  see, "rightSideRightX");
  wireCoord("gszedit-right-r-y",  see, "rightSideRightY");
  wireCoord("gszedit-right-inc",  see, "rightInc");
  wireCoord("gszedit-radius-inc", see, "radiusInc");
}

function renderWaterTable(item) {
  const tbody = $id("gszedit-water-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!item.waterPoints.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="gszedit-empty-cell">PiezometricLine 없음</td></tr>';
    return;
  }
  item.waterPoints.forEach((wp, i) => {
    const tr = document.createElement("tr");
    const tdN = document.createElement("td"); tdN.className = "map-cell-label"; tdN.textContent = `DP-${wp.num}`;
    const tdX = document.createElement("td");
    const xInp = document.createElement("input"); xInp.type = "text"; xInp.value = wp.x;
    xInp.oninput = () => { item.waterPoints[i].x = xInp.value; saveLS(); };
    tdX.appendChild(xInp);
    const tdY = document.createElement("td");
    const yInp = document.createElement("input"); yInp.type = "text"; yInp.value = wp.y;
    yInp.oninput = () => { item.waterPoints[i].y = yInp.value; saveLS(); };
    tdY.appendChild(yInp);
    tr.appendChild(tdN); tr.appendChild(tdX); tr.appendChild(tdY); tbody.appendChild(tr);
  });
}

// ── 리즌 매핑 ────────────────────────────────────────────────
function renderRegionMapping(item) {
  renderRegionMappingTable(item);
  // rAF로 canvas offsetWidth 확정 후 그리기
  requestAnimationFrame(() => {
    setupCanvasEvents();
    drawRegionCanvas();
    renderCanvasLegend(item);
  });
}

function renderCanvasLegend(item) {
  const legendEl = $id("gszedit-canvas-legend");
  if (!legendEl || !gState) return;
  legendEl.innerHTML = "";

  const matColorMap = new Map();
  const matNameMap  = new Map();
  (gState.materials || []).forEach(m => { matColorMap.set(m.id, m.color); matNameMap.set(m.id, m.name); });

  const usedMats = new Set((item.regionMaterials || []).map(rm => rm.materialId));
  usedMats.forEach(matId => {
    const color = matColorMap.get(matId) || "#ccc";
    const name  = matNameMap.get(matId)  || `ID=${matId}`;
    const span  = document.createElement("span");
    span.className = "gszedit-legend-item";
    span.innerHTML = `<span class="gszedit-legend-swatch" style="background:${color}"></span>${escHtml(name)}`;
    legendEl.appendChild(span);
  });
}

function renderRegionMappingTable(item) {
  const tbody = $id("gszedit-region-map-tbody");
  if (!tbody || !gState) return;
  tbody.innerHTML = "";

  if (!item.regionMaterials?.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="gszedit-empty-cell">이 해석에 매핑된 리즌 없음</td></tr>';
    return;
  }

  const matColorMap = new Map();
  const matNameMap  = new Map();
  (gState.materials || []).forEach(m => { matColorMap.set(m.id, m.color); matNameMap.set(m.id, m.name); });

  item.regionMaterials.forEach((rm, ri) => {
    const tr = document.createElement("tr");
    tr.dataset.regionId = rm.regionId;

    const tdReg = document.createElement("td");
    tdReg.className = "map-cell-label gszedit-region-cell";
    const color    = matColorMap.get(rm.materialId) || "#eee";
    tdReg.style.borderLeft = `4px solid ${color}`;
    tdReg.textContent = `리즌 ${rm.regionId}`;
    if (rm.regionId === gSelectedRegionId) tr.classList.add("gszedit-row-selected");

    const tdMat = document.createElement("td");
    const sel   = document.createElement("select");
    sel.className = "gszedit-mat-sel";

    (gState.materials || []).forEach(m => {
      const opt = document.createElement("option");
      opt.value       = m.id;
      opt.textContent = `${m.id}. ${m.name}`;
      if (m.id === rm.materialId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => {
      item.regionMaterials[ri].materialId = sel.value;
      saveLS();
      drawRegionCanvas();
      renderCanvasLegend(item);
      // 테두리 색 갱신
      tdReg.style.borderLeft = `4px solid ${matColorMap.get(sel.value) || "#eee"}`;
    };
    tdMat.appendChild(sel);

    // 클릭으로 캔버스 선택 동기화
    tdReg.addEventListener("click", () => {
      gSelectedRegionId = rm.regionId;
      highlightTableRow(rm.regionId);
      drawRegionCanvas();
    });

    tr.appendChild(tdReg); tr.appendChild(tdMat); tbody.appendChild(tr);
  });
}

function highlightTableRow(regionId) {
  const tbody = $id("gszedit-region-map-tbody");
  if (!tbody) return;
  tbody.querySelectorAll("tr").forEach(tr => {
    tr.classList.toggle("gszedit-row-selected", tr.dataset.regionId === regionId);
  });
}

let gCanvasEventsSet = false;
function setupCanvasEvents() {
  if (gCanvasEventsSet) return;
  gCanvasEventsSet = true;
  const canvas = $id("gszedit-region-canvas");
  if (!canvas) return;

  canvas.style.cursor = "pointer";

  // 휠 줌
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const { W, H } = gCanvasWH;
    const mx = ((e.clientX - rect.left) / rect.width)  * W;
    const my = ((e.clientY - rect.top)  / rect.height) * H;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const oldZ = gCanvasView.zoom;
    const newZ = Math.min(50, Math.max(0.12, oldZ * factor));
    const relX = (mx - W / 2 - gCanvasView.panX) / oldZ;
    const relY = (my - H / 2 - gCanvasView.panY) / oldZ;
    gCanvasView.zoom = newZ;
    gCanvasView.panX = mx - W / 2 - relX * newZ;
    gCanvasView.panY = my - H / 2 - relY * newZ;
    drawRegionCanvas();
  }, { passive: false });

  // 드래그 팬
  let dragStart = null;
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragStart = { x: e.clientX, y: e.clientY, panX: gCanvasView.panX, panY: gCanvasView.panY };
    canvas.style.cursor = "grabbing";
  });
  canvas.addEventListener("mousemove", (e) => {
    if (dragStart) {
      gCanvasView.panX = dragStart.panX + (e.clientX - dragStart.x);
      gCanvasView.panY = dragStart.panY + (e.clientY - dragStart.y);
      drawRegionCanvas();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const rid  = canvasHitRegion(e.clientX - rect.left, e.clientY - rect.top);
    canvas.title = rid ? `리즌 ${rid}` : "";
  });
  const endDrag = (e) => {
    if (!dragStart) return;
    const moved = Math.abs(e.clientX - dragStart.x) > 4 || Math.abs(e.clientY - dragStart.y) > 4;
    dragStart = null;
    canvas.style.cursor = "pointer";
    if (!moved) {
      // 클릭으로 처리
      const rect = canvas.getBoundingClientRect();
      const rid  = canvasHitRegion(e.clientX - rect.left, e.clientY - rect.top);
      if (rid) {
        gSelectedRegionId = rid;
        drawRegionCanvas();
        highlightTableRow(rid);
        const row = $id("gszedit-region-map-tbody")?.querySelector(`tr[data-region-id="${rid}"]`);
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  };
  canvas.addEventListener("mouseup",    endDrag);
  canvas.addEventListener("mouseleave", endDrag);

  // 더블클릭: 뷰 초기화
  canvas.addEventListener("dblclick", () => {
    gCanvasView.zoom = 1; gCanvasView.panX = 0; gCanvasView.panY = 0;
    drawRegionCanvas();
  });
}

function renderAll() {
  renderHint();
  renderGlobalSettings();
  renderMaterialsTable();
  renderAnalysisTabs();
  renderActiveAnalysis();
  const runBtn = $id("gszedit-run");
  if (runBtn) runBtn.disabled = !gState?.slopeItems.length;
}

// ─── 파일 로드 ───────────────────────────────────────────────
async function handleFileLoad(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  clearLog(); setProgress(10);
  try {
    const buf = await file.arrayBuffer();
    const { zip, xmlName, doc } = await loadGszFromArrayBuffer(buf);
    gZip = zip;
    setProgress(40);
    const xmlText = serializeXmlDocument(doc);
    gState = parseFromDoc(doc, xmlName, xmlText);
    gActiveIdx = 0;
    gSelectedRegionId = null;
    gCanvasView.zoom = 1; gCanvasView.panX = 0; gCanvasView.panY = 0;
    saveLS(); setProgress(80);
    renderAll(); setProgress(100);
    appendLog(`✓ ${file.name} 로드 완료`);
    appendLog(`  → 해석 ${gState.slopeItems.length}개 · 물성치 ${gState.materials.length}개 · 리즌 ${gState.regions.length}개 · XML: ${xmlName}`);
    toastMsg(`GSZ 로드 완료 — 해석 ${gState.slopeItems.length}개`);
    const outInp = $id("gszedit-out-name");
    if (outInp && !outInp.value.trim()) outInp.value = `${file.name.replace(/\.gsz$/i, "")}_edited.gsz`;
  } catch (err) {
    setProgress(0); appendLog(`❌ ${err.message}`); toastMsg(err.message, false);
  }
}

// ─── 저장 (다운로드) ──────────────────────────────────────────
async function handleDownload() {
  if (!gState?.xmlText) { toastMsg("GSZ 파일을 먼저 업로드하거나 이전 저장 데이터를 복원하세요.", false); return; }
  clearLog(); setProgress(10);
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(gState.xmlText, "application/xml");
    const pe     = doc.querySelector("parsererror");
    if (pe) throw new Error("저장된 XML 파싱 오류: " + pe.textContent?.slice(0, 120));
    setProgress(30);
    appendLog("● 파라미터 적용 중...");
    applyToDoc(doc, gState);
    setProgress(55);
    appendLog("● ZIP 생성 중...");
    let blob;
    if (gZip) {
      gZip.file(gState.xmlName, serializeXmlDocument(doc));
      blob = await zipToBlob(gZip);
    } else {
      appendLog("  ※ 세션 재오픈으로 인해 XML만 포함된 ZIP을 생성합니다.");
      const JSZip = await getJSZip();
      const zip   = new JSZip();
      zip.file(gState.xmlName, serializeXmlDocument(doc));
      blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    }
    setProgress(85);
    let outName = $id("gszedit-out-name")?.value.trim() || "output_edited.gsz";
    if (!outName.toLowerCase().endsWith(".gsz")) outName += ".gsz";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = outName; a.click();
    URL.revokeObjectURL(a.href);
    setProgress(100);
    appendLog(`✓ 완료 → ${outName}`);
    toastMsg("GSZ 저장 완료 · 다운로드 폴더를 확인하세요.");
  } catch (err) {
    setProgress(0); appendLog(`❌ ${err.message}`); toastMsg(err.message, false);
  }
}

// ─── 초기화 ──────────────────────────────────────────────────
export function initGszEditor() {
  const saved = loadLS();
  if (saved?.slopeItems?.length > 0) {
    gState = saved;
    gActiveIdx = 0;
    renderAll();
    appendLog("● 이전에 저장된 편집 상태를 복원했습니다.");
    appendLog("  다운로드하려면 [▶ GSZ 저장 및 다운로드]를 클릭하거나, 파일을 다시 업로드하세요.");
  } else {
    renderAll();
  }

  $id("gszedit-file")?.addEventListener("change", handleFileLoad);
  $id("gszedit-run")?.addEventListener("click", handleDownload);
  $id("gszedit-mat-copy")?.addEventListener("click", () => {
    const table = $id("gszedit-mat-table");
    if (!table) return;
    const rows = [];
    // 헤더
    const ths = table.querySelectorAll("thead th");
    rows.push([...ths].map(th => th.innerText.replace(/\n/g, " ").trim()).join("\t"));
    // 데이터행
    table.querySelectorAll("tbody tr").forEach(tr => {
      const cells = [...tr.querySelectorAll("td")].map(td => {
        const inp = td.querySelector("input");
        if (inp) return inp.value;
        return td.textContent.trim();
      });
      rows.push(cells.join("\t"));
    });
    navigator.clipboard.writeText(rows.join("\n"))
      .then(() => toastMsg("물성치 데이터가 복사되었습니다."))
      .catch(() => toastMsg("복사 실패 — 클립보드 권한을 확인하세요.", false));
  });

  // 탭 전환 시 캔버스 재그리기 (panel 가시화 후 width 확정)
  document.querySelectorAll('.tab-btn[data-tab="gsz-edit"]').forEach(btn => {
    btn.addEventListener("click", () => {
      requestAnimationFrame(() => {
        if (gState?.slopeItems.length) drawRegionCanvas();
      });
    });
  });

  // 윈도우 리사이즈
  window.addEventListener("resize", () => {
    if (gState?.slopeItems.length) drawRegionCanvas();
  });

  // GSZ 편집 테이블 키보드 탐색 (이벤트 위임 — tbody 재빌드 후에도 유효)
  [
    "gszedit-mat-tbody",
    "gszedit-pressure-tbody",
    "gszedit-lineload-tbody",
    "gszedit-water-tbody",
  ].forEach((id) => {
    const el = $id(id);
    if (el) installTableArrowNav(el);
  });
}

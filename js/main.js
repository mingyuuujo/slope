/**
 * SLOPE/W 웹 UI (순수 정적) — slope_gui 로직 JavaScript 이식
 * JSZip · dxf-parser 는 index.html에서 vendor 스크립트로 선로드됩니다.
 */

import { applyMaterialsToDocument } from "./materials.js";
import { initGszEditor } from "./gsz-editor.js";
import { initResultViewer } from "./result-viewer.js";
import {
  applyRegionMappingToDocument,
  syncMaterialsForAnalysisFromRegions,
  computePreviewRegionsFromDxf,
} from "./mapping.js";
import {
  readLayersFromDxfParsed,
  readWaterTablePolylineFromDxf,
  WATER_TABLE_LAYER_NAME,
} from "./dxf-read.js";
import {
  loadGszFromArrayBuffer,
  zipToBlob,
  parseDxfText,
} from "./deps.js";
import { serializeXmlDocument, allChildEl, firstChildEl, findFirstTag } from "./xml-utils.js";
import { installTableArrowNav, installWheelBlockOnNumberInputs } from "./keyboard-nav.js";
import { listMaterialsFromDocument } from "./template-materials.js";
import { listAnalysesFromDocument, ensureAnalysisExists } from "./analyses.js";
import {
  readWaterDataPointsFromDocument,
  applyWaterDataPointsToAllSlopeItems,
} from "./water-datapoints.js";
import {
  computeSlipEntryExitFromDxf,
  applySlipEntryExitToAllSlopeItems,
} from "./slip-entry-exit.js";
import {
  drawMapDxfPreviewRegions,
  findRegionIdAtCanvasClient,
  materialRgbMapFromMaterialsList,
  materialNameMapFromMaterialsList,
  renderMapDxfLegendRegions,
  applyWheelToMapView,
  stepMapViewZoomCenter,
  resetMapPreviewView,
  computeDxfPreviewLayoutFromRegions,
  clientToWorldWithView,
  worldToCanvasWithView,
} from "./map-preview.js";
import { initDxfGeoStudioTab } from "./dxf-geostudio-ui.js";

/** Region 매핑: 해석별 GeoStudio Region ID → Material (여러 Analysis 지원) */
const mapAnalysesState = {
  /** @type {{ id: number, title: string, regionMaterials: Record<string, number|null>, seismicH: string, pressureLines: Array, slipPts: object|null }[]} */
  rows: [{ id: 1, title: "Analysis 1", regionMaterials: {}, seismicH: "", pressureLines: [], slipPts: null }],
  activeIndex: 0,
};

let mapDxfLayersCache = null;
/** DXF→지오메트리 파이프라인과 동일 순서의 닫힌 영역 목록 (미리보기·히트·표 행) */
let mapRegionPreviewCache = null;
/** Region 미리보기 캔버스 확대/이동 (CSS 픽셀 기준 pan) */
const mapDxfCanvasView = { zoom: 1, panX: 0, panY: 0 };
/** DXF 기반 자동 계산 SlipEntryExit (캔버스 오버레이 + runMapping 기본값) */
let mapSlipAutoComputed = null;
/** drawMapDxfPreviewRegions 가 마지막으로 반환한 layout 캐시 (setupCanvas 재호출 방지용) */
let mapLastDrawFrame = null;

/** 캔버스 그리기 모드: "paint" | "pressure" | "slip" */
let mapCanvasMode = "paint";
/** 상재하중 그리기 — 현재 선택 중인 노드 목록 (N개까지 누적, 완료 시 pressureLine 생성) */
let mapPressurePoints = []; // {x, y}[]
/** 슬립 핸들 드래그 상태 */
let mapSlipDragHandle = null; // null | { handle:"ll"|"lr"|"rl"|"rr", origX, origY }
/** 격자 탐색 핸들 드래그 상태 */
let mapGridDragHandle = null; // null | { zone:"grid"|"radius", corner:"ul"|"ll"|"lr"|"ur" }
/** 격자 사각형 그리기 모드: 어느 존을 그리는 중인지 */
let mapGridDrawZone = null; // null | "grid" | "radius"
/** 사각형 그리기 첫 번째 클릭점 (앵커) */
let mapGridDrawAnchor = null; // null | {x, y}
/** 마우스 이동 시 월드 좌표 (그리기 프리뷰용) */
let mapMouseWorldXY = null;
/** pressure 모드에서 현재 스냅 대상 DXF 노드 ({x,y} | null) */
let mapSnapNode = null;
/** 드래그 이동 직후 재료 클릭 할당 1회 무시 */
let mapCanvasSuppressNextClick = false;
/** 레이어 가시성 (UI 표시 여부만 제어, 데이터에 영향 없음) */
const mapLayerVisible = { materials: true, pressure: true, slip: true, nodes: true, grid: true };
/** 템플릿 GSZ Material ID → RGB (Color 필드) */
let mapMaterialRgbById = new Map();
/** 템플릿 GSZ Material ID → 재료명 */
let mapMaterialNameById = new Map();

/** 수위 꺾은선 — 모든 Analysis 공통 (PiezometricLines·MaterialUsesPiezs, 경계 DataPoints 유지) */
let mapWaterPoints = [];

/** 클릭으로 칠하기: 템플릿 재료 ID(문자열). null 이면 끔 */
let mapPaintMaterialId = null;

const MAT_HEADERS = [
  "ID",
  "재료명",
  "모델",
  "포화단위중량\n(kN/m³)",
  "습윤단위중량\n(kN/m³)",
  "점착력 c'\n(kPa)",
  "마찰각 φ'\n(°)",
  "초기점착력\nC_top(kPa)",
  "증가율\n(kPa/m)",
  "기준점착력\nC_datum",
  "기준고\n(EL.m)",
  "색상 RGB\n(미리보기 ◼)",
];

const COL_MODEL = 2;
const COL_COLOR = 11;

const MODEL_EXPORT_KEYS = {
  MohrCoulomb: new Set(["uw", "dw", "c", "phi"]),
  SFnDepth: new Set(["uw", "dw", "c_top", "c_rate"]),
  SFnDatum: new Set(["uw", "dw", "c_rate", "c_datum", "datum_elev"]),
};

const MODEL_EDIT_COLS = {
  MohrCoulomb: new Set([3, 4, 5, 6]),
  SFnDepth: new Set([3, 4, 7, 8]),
  SFnDatum: new Set([3, 4, 8, 9, 10]),
};

const BASE_EDIT_COLS = new Set([1, COL_COLOR]);

const MAT_KEYS = [
  "id",
  "name",
  null,
  "uw",
  "dw",
  "c",
  "phi",
  "c_top",
  "c_rate",
  "c_datum",
  "datum_elev",
  "color",
];

const DEFAULT_GUI_MATERIAL_ROWS = [
  {
    id: "1",
    name: "매립사석",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(240,245,237)",
  },
  {
    id: "2",
    name: "매립토",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(240,245,237)",
  },
  {
    id: "3",
    name: "무근콘크리트",
    model: "MohrCoulomb",
    uw: "22.6",
    dw: "22.6",
    c: "100",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(212,202,200)",
  },
  {
    id: "4",
    name: "철근콘크리트",
    model: "MohrCoulomb",
    uw: "24",
    dw: "24",
    c: "100",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(212,202,200)",
  },
  {
    id: "5",
    name: "와록블록",
    model: "MohrCoulomb",
    uw: "0",
    dw: "",
    c: "100",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(212,202,200)",
  },
  {
    id: "6",
    name: "이글루블록",
    model: "MohrCoulomb",
    uw: "0",
    dw: "",
    c: "100",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(212,202,200)",
  },
  {
    id: "7",
    name: "피복석",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "40",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(176,160,128)",
  },
  {
    id: "8",
    name: "기초사석",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "40",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(235,224,206)",
  },
  {
    id: "9",
    name: "기초사석(편심)",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "20",
    phi: "35",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(235,224,206)",
  },
  {
    id: "10",
    name: "뒤채움사석",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "40",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(235,224,206)",
  },
  {
    id: "11",
    name: "필터사석",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "35",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(246,238,227)",
  },
  {
    id: "12",
    name: "퇴적점토0-5m",
    model: "SFnDepth",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(232,224,213)",
  },
  {
    id: "13",
    name: "퇴적점토5-10m",
    model: "SFnDepth",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(221,213,201)",
  },
  {
    id: "14",
    name: "퇴적점토10m이하",
    model: "SFnDepth",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(209,201,189)",
  },
  {
    id: "15",
    name: "퇴적모래",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "35",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(198,190,177)",
  },
  {
    id: "16",
    name: "퇴적자갈",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "40",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(187,178,165)",
  },
  {
    id: "17",
    name: "풍화토",
    model: "MohrCoulomb",
    uw: "20",
    dw: "20",
    c: "20",
    phi: "30",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(153,144,128)",
  },
  {
    id: "18",
    name: "풍화암",
    model: "MohrCoulomb",
    uw: "21",
    dw: "21",
    c: "30",
    phi: "40",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(141,132,116)",
  },
  {
    id: "19",
    name: "연암",
    model: "MohrCoulomb",
    uw: "24",
    dw: "24",
    c: "100",
    phi: "45",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(130,121,104)",
  },
  {
    id: "20",
    name: "DCM(00%)[장주(상시)]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(155,145,143)",
  },
  {
    id: "21",
    name: "DCM(00%)[장주(지진시)]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(155,145,143)",
  },
  {
    id: "22",
    name: "DCM(00%)[단주(상시)]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(209,204,200)",
  },
  {
    id: "23",
    name: "DCM(00%)[단주(지진시)]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(209,204,200)",
  },
  {
    id: "24",
    name: "고압분사(00%)[상시]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(155,145,143)",
  },
  {
    id: "25",
    name: "고압분사(00%)[지진시]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(155,145,143)",
  },
  {
    id: "26",
    name: "저유동성몰탈(00%)[상시]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(155,145,143)",
  },
  {
    id: "27",
    name: "저유동성몰탈(00%)[지진시]",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(155,145,143)",
  },
  {
    id: "28",
    name: "수평배수층",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "0",
    phi: "35",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(240,234,223)",
  },
  {
    id: "29",
    name: "재하성토",
    model: "MohrCoulomb",
    uw: "20",
    dw: "18",
    c: "10",
    phi: "25",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "RGB=(254,247,231)",
  },
];

const DEFAULT_LAYER_MAP = {
  매립사석: 1,
  매립토: 2,
  무근콘크리트: 3,
  철근콘크리트: 4,
  와록블록: 5,
  이글루블록: 6,
  피복석: 7,
  기초사석: 8,
  "기초사석(편심)": 9,
  뒤채움사석: 10,
  필터사석: 11,
  "퇴적점토0-5m": 12,
  "퇴적점토5-10m": 13,
  퇴적점토10m이하: 14,
  퇴적모래: 15,
  퇴적자갈: 16,
  풍화토: 17,
  풍화암: 18,
  연암: 19,
  "DCM(00%)[장주(상시)]": 20,
  "DCM(00%)[장주(지진시)]": 21,
  "DCM(00%)[단주(상시)]": 22,
  "DCM(00%)[단주(지진시)]": 23,
  "고압분사(00%)[상시]": 24,
  "고압분사(00%)[지진시]": 25,
  "저유동성몰탈(00%)[상시]": 26,
  "저유동성몰탈(00%)[지진시]": 27,
  수평배수층: 28,
  재하성토: 29,
  퇴적점토: 12,
  매립자갈: 16,
  지반개량: 24,
  "지반개량(장주)": 20,
  쇄석: 11,
  재하토: 29,
};

function geometryLayersExceptWater() {
  if (!mapDxfLayersCache) return new Set();
  return new Set(
    Object.keys(mapDxfLayersCache).filter((l) => l !== WATER_TABLE_LAYER_NAME),
  );
}

function recomputeRegionPreviewCache() {
  if (!mapDxfLayersCache) {
    mapRegionPreviewCache = null;
    mapSlipAutoComputed = null;
    return;
  }
  const gl = geometryLayersExceptWater();
  mapRegionPreviewCache = computePreviewRegionsFromDxf(
    mapDxfLayersCache,
    gl,
    () => {},
  );
  mapSlipAutoComputed = computeSlipEntryExitFromDxf(mapDxfLayersCache, gl);
  mergeRegionKeysIntoAllAnalysisRows();
}

/** 분석 행의 새 필드 초기화 (seismicH, pressureLines, slipPts, gridData) */
function initRowExtras(row) {
  if (!("seismicH" in row)) row.seismicH = "";
  if (!("pressureLines" in row)) row.pressureLines = [];
  if (!("slipPts" in row)) row.slipPts = null;
  if (!("gridData" in row)) row.gridData = null;
}

/** 현재 활성 분석의 유효 SlipEntryExit 데이터 반환 (사용자 오버라이드 우선) */
function getEffectiveSlipPts(row) {
  return row?.slipPts ?? mapSlipAutoComputed;
}

function mergeRegionKeysIntoAllAnalysisRows() {
  const regions = mapRegionPreviewCache?.regions;
  if (!regions || !regions.length) return;
  for (const row of mapAnalysesState.rows) {
    if (!row.regionMaterials) row.regionMaterials = {};
    for (const { regId, layer } of regions) {
      const key = String(regId);
      if (!(key in row.regionMaterials)) {
        const def = DEFAULT_LAYER_MAP[layer];
        row.regionMaterials[key] =
          def != null && Number.isFinite(def) ? def : null;
      }
    }
  }
}

function parseOptionalFloat(txt) {
  if (txt == null) return null;
  const t = String(txt).trim().replace(/,/g, "");
  if (!t) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function parseRgbForPreview(text) {
  if (text == null || !String(text).trim()) return null;
  const s = String(text).trim();
  let r;
  let g;
  let b;
  const m = s.match(/RGB\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (m) {
    r = +m[1];
    g = +m[2];
    b = +m[3];
  } else if (/^\d{1,10}$/.test(s)) {
    const n = parseInt(s, 10);
    r = n & 0xff;
    g = (n >> 8) & 0xff;
    b = (n >> 16) & 0xff;
  } else {
    const nums = s.match(/\d+/g);
    if (!nums || nums.length < 3) return null;
    r = +nums[0];
    g = +nums[1];
    b = +nums[2];
  }
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return { r, g, b };
}

function normalizeMaterialColor(text) {
  if (text == null || !String(text).trim()) return null;
  const s = String(text).trim();
  const m = s.match(/RGB\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (m) return `${m[1]},${m[2]},${m[3]}`;
  const nums = s.match(/\d+/g);
  if (nums && nums.length >= 3) return `${nums[0]},${nums[1]},${nums[2]}`;
  return s;
}

function rgbToHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toast(msg, ok = true) {
  const el = document.createElement("div");
  el.className = `toast ${ok ? "ok" : "err"}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename || "download.gsz";
  a.click();
  URL.revokeObjectURL(a.href);
}

function setProgress(id, pct) {
  const bar = document.getElementById(id);
  if (!bar) return;
  const normalized = Math.min(100, Math.max(0, pct));
  bar.style.width = `${normalized}%`;
  const wrap = bar.parentElement;
  if (wrap) wrap.classList.toggle("active", normalized > 0);
}

function buildMatThead() {
  const tr = document.getElementById("mat-thead-row");
  tr.innerHTML = "";
  MAT_HEADERS.forEach((h) => {
    const th = document.createElement("th");
    th.innerHTML = h.replace(/\n/g, "<br>");
    tr.appendChild(th);
  });
}

function wireColorCell(td, initialColor) {
  const wrap = document.createElement("div");
  wrap.className = "color-cell";
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "color-swatch";
  swatch.title = "클릭하여 색 선택";
  const picker = document.createElement("input");
  picker.type = "color";
  picker.className = "color-picker-hidden";
  picker.setAttribute("aria-hidden", "true");
  const text = document.createElement("input");
  text.type = "text";
  text.placeholder = "RGB=(r,g,b)";
  text.value = initialColor || "";

  function syncSwatch() {
    const rgb = parseRgbForPreview(text.value);
    if (rgb) {
      swatch.style.background = rgbToHex(rgb.r, rgb.g, rgb.b);
      swatch.classList.add("valid");
      picker.value = rgbToHex(rgb.r, rgb.g, rgb.b);
    } else {
      swatch.style.background = "";
      swatch.classList.remove("valid");
    }
  }

  swatch.addEventListener("click", () => picker.click());
  function applyPickerToCell() {
    const rgb = hexToRgb(picker.value);
    if (!rgb) return;
    text.value = `RGB=(${rgb.r},${rgb.g},${rgb.b})`;
    syncSwatch();
  }
  picker.addEventListener("input", applyPickerToCell);
  picker.addEventListener("change", applyPickerToCell);
  text.addEventListener("input", syncSwatch);
  syncSwatch();

  wrap.appendChild(swatch);
  wrap.appendChild(picker);
  wrap.appendChild(text);
  td.appendChild(wrap);

  return {
    getValue: () => text.value.trim(),
    setValue: (v) => {
      text.value = v || "";
      syncSwatch();
    },
  };
}

function createMatRow(d) {
  const tr = document.createElement("tr");
  const cells = [];

  for (let ci = 0; ci < MAT_KEYS.length; ci++) {
    const key = MAT_KEYS[ci];
    const td = document.createElement("td");
    td.dataset.col = String(ci);

    if (key === null) {
      const sel = document.createElement("select");
      ["MohrCoulomb", "SFnDepth", "SFnDatum"].forEach((m) => {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        sel.appendChild(o);
      });
      sel.value = d.model || "MohrCoulomb";
      sel.addEventListener("change", () => applyRowEditPolicy(tr));
      td.appendChild(sel);
    } else if (key === "color") {
      const api = wireColorCell(td, d.color || "");
      cells[COL_COLOR] = api;
    } else if (key === "id") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.readOnly = true;
      inp.value = d[key] != null ? String(d[key]) : "";
      inp.className = "mat-id-cell";
      td.appendChild(inp);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = d[key] != null ? String(d[key]) : "";
      td.appendChild(inp);
    }
    tr.appendChild(td);
  }

  tr._colorApi = cells[COL_COLOR];
  return tr;
}

function applyRowEditPolicy(tr) {
  const sel = tr.querySelector(`td[data-col="${COL_MODEL}"] select`);
  const model = sel ? sel.value : "MohrCoulomb";
  const editable = new Set(BASE_EDIT_COLS);
  const extra = MODEL_EDIT_COLS[model] || MODEL_EDIT_COLS.MohrCoulomb;
  extra.forEach((c) => editable.add(c));

  tr.classList.remove("model-mc", "model-depth", "model-datum");
  if (model === "MohrCoulomb") tr.classList.add("model-mc");
  else if (model === "SFnDepth") tr.classList.add("model-depth");
  else tr.classList.add("model-datum");

  tr.querySelectorAll("td").forEach((td) => {
    const c = parseInt(td.dataset.col, 10);
    if (Number.isNaN(c) || c === COL_MODEL) return;

    if (c === COL_COLOR) return;

    const inp = td.querySelector("input[type=text]");
    if (!inp) return;
    const ro = !editable.has(c);
    inp.readOnly = ro;
    td.classList.toggle("readonly-cell", ro);
  });
}

function collectMaterials() {
  const tbody = document.getElementById("mat-tbody");
  const out = [];
  tbody.querySelectorAll("tr").forEach((tr) => {
    const idInp = tr.querySelector(`td[data-col="0"] input`);
    const idTxt = idInp ? idInp.value.trim() : "";
    if (!idTxt) return;

    const sel = tr.querySelector(`td[data-col="${COL_MODEL}"] select`);
    const model = sel ? sel.value : "MohrCoulomb";
    const nameInp = tr.querySelector(`td[data-col="1"] input`);
    const name = nameInp ? nameInp.value.trim() : "";

    const mat = { id: idTxt, model, name };
    const allowed = MODEL_EXPORT_KEYS[model] || MODEL_EXPORT_KEYS.MohrCoulomb;

    MAT_KEYS.forEach((key, ci) => {
      if (!key || key === "id" || key === "name") return;
      if (key === "color") {
        const colTxt = tr._colorApi ? tr._colorApi.getValue() : "";
        const col = normalizeMaterialColor(colTxt);
        if (col) mat.color = col;
        return;
      }
      const inp = tr.querySelector(`td[data-col="${ci}"] input`);
      const txt = inp ? inp.value.trim() : "";
      if (!allowed.has(key)) return;
      const v = parseOptionalFloat(txt);
      if (v !== null) mat[key] = v;
    });
    out.push(mat);
  });
  return out;
}

function initMaterialsTable() {
  buildMatThead();
  const tbody = document.getElementById("mat-tbody");
  tbody.innerHTML = "";
  DEFAULT_GUI_MATERIAL_ROWS.forEach((d) => {
    const tr = createMatRow(d);
    tbody.appendChild(tr);
    applyRowEditPolicy(tr);
  });
  renumberMatRows();
}

function renumberMatRows() {
  const tbody = document.getElementById("mat-tbody");
  tbody.querySelectorAll("tr").forEach((tr, i) => {
    const idInp = tr.querySelector('td[data-col="0"] input');
    if (idInp) idInp.value = String(i + 1);
  });
}

function matAddRow() {
  const tbody = document.getElementById("mat-tbody");
  const tr = createMatRow({
    id: "",
    name: "",
    model: "MohrCoulomb",
    uw: "",
    dw: "",
    c: "",
    phi: "",
    c_top: "",
    c_rate: "",
    c_datum: "",
    datum_elev: "",
    color: "",
  });
  tbody.appendChild(tr);
  applyRowEditPolicy(tr);
  renumberMatRows();
}

function matDelSelectedRow() {
  const tbody = document.getElementById("mat-tbody");
  const selected = tbody.querySelectorAll("tr[data-selected]");
  if (!selected.length) {
    toast("삭제할 행을 선택(Ctrl+클릭: 개별, Shift+클릭: 범위)한 뒤 눌러 주세요.", false);
    return;
  }
  selected.forEach((r) => r.remove());
  if (!tbody.querySelector("tr")) matAddRow();
  else renumberMatRows();
}

async function runMaterials() {
  const fileEl = document.getElementById("mat-template");
  const logEl = document.getElementById("mat-log");
  if (!fileEl.files || !fileEl.files[0]) {
    toast("템플릿 GSZ 파일을 선택하세요.", false);
    return;
  }
  let outName = document.getElementById("mat-out-name").value.trim();
  if (!outName) outName = "output_materials.gsz";
  if (!outName.toLowerCase().endsWith(".gsz")) outName += ".gsz";

  const materials = collectMaterials();
  if (!materials.length) {
    toast("적용할 재료(ID가 있는 행)가 없습니다.", false);
    return;
  }

  logEl.textContent = "GSZ 로드 및 처리 중...\n";
  setProgress("mat-progress", 10);

  try {
    const buf = await fileEl.files[0].arrayBuffer();
    const { zip, xmlName, doc } = await loadGszFromArrayBuffer(buf);
    const lines = [];
    const log = (m) => {
      lines.push(m);
      logEl.textContent = lines.join("\n") + "\n";
    };
    log(`● ${materials.length}개 재료 적용`);
    setProgress("mat-progress", 40);
    const count = applyMaterialsToDocument(doc, materials, log);
    setProgress("mat-progress", 70);
    log("● ZIP 재패킹...");
    zip.file(xmlName, serializeXmlDocument(doc));
    const blob = await zipToBlob(zip);
    downloadBlob(blob, outName);
    setProgress("mat-progress", 100);
    log(`✓ 완료 → ${outName} (${count}건 반영)`);
    logEl.textContent = lines.join("\n") + "\n";
    toast("물성치 적용 완료 · 다운로드 폴더를 확인하세요.");
  } catch (e) {
    setProgress("mat-progress", 0);
    logEl.textContent += `\n❌ ${e.message}\n`;
    toast(e.message, false);
  }
}

function syncWaterPointsFromTable() {
  const tbody = document.getElementById("map-water-tbody");
  if (!tbody) return;
  const next = [];
  tbody.querySelectorAll("tr").forEach((tr) => {
    const xInp = tr.querySelector(".map-water-x");
    const yInp = tr.querySelector(".map-water-y");
    const x = parseFloat(xInp?.value ?? "");
    const y = parseFloat(yInp?.value ?? "");
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    next.push({ x, y });
  });
  mapWaterPoints = next;
}

function renderWaterTable() {
  const tbody = document.getElementById("map-water-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  mapWaterPoints.forEach((p, i) => {
    const tr = document.createElement("tr");
    const tdN = document.createElement("td");
    tdN.className = "map-cell-muted";
    tdN.style.textAlign = "center";
    tdN.textContent = String(i + 1);
    const tdX = document.createElement("td");
    const inX = document.createElement("input");
    inX.type = "text";
    inX.className = "map-water-x";
    inX.value = String(p.x);
    tdX.appendChild(inX);
    const tdY = document.createElement("td");
    const inY = document.createElement("input");
    inY.type = "text";
    inY.className = "map-water-y";
    inY.value = String(p.y);
    tdY.appendChild(inY);
    const tdD = document.createElement("td");
    tdD.style.textAlign = "center";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn map-water-del-btn";
    btn.textContent = "삭제";
    tdD.appendChild(btn);
    tr.appendChild(tdN);
    tr.appendChild(tdX);
    tr.appendChild(tdY);
    tr.appendChild(tdD);
    tbody.appendChild(tr);
  });
}

function bindWaterTableUI() {
  const tbody = document.getElementById("map-water-tbody");
  if (!tbody || tbody.dataset.bound) return;
  tbody.dataset.bound = "1";
  installTableArrowNav(tbody, {
    onEnterLastRow() {
      syncWaterPointsFromTable();
      const last = mapWaterPoints[mapWaterPoints.length - 1];
      mapWaterPoints.push({ x: last ? last.x : 0, y: last ? last.y : 0 });
      renderWaterTable();
      redrawMapDxfPreview();
    },
  });
  tbody.addEventListener("input", (e) => {
    if (
      !e.target.classList.contains("map-water-x") &&
      !e.target.classList.contains("map-water-y")
    )
      return;
    syncWaterPointsFromTable();
    redrawMapDxfPreview();
  });
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".map-water-del-btn");
    if (!btn) return;
    const tr = btn.closest("tr");
    const tbodyEl = document.getElementById("map-water-tbody");
    const rows = [...tbodyEl.querySelectorAll("tr")];
    const idx = rows.indexOf(tr);
    if (idx < 0) return;
    syncWaterPointsFromTable();
    mapWaterPoints.splice(idx, 1);
    renderWaterTable();
    redrawMapDxfPreview();
  });
}

async function importWaterFromDxfFile() {
  const fileEl = document.getElementById("map-dxf");
  if (!fileEl.files || !fileEl.files[0]) {
    toast("DXF 파일을 선택하세요.", false);
    return;
  }
  try {
    const text = await fileEl.files[0].text();
    const parsed = await parseDxfText(text);
    const wt = readWaterTablePolylineFromDxf(parsed);
    if (!wt || wt.length < 2) {
      toast("DXF에 @수위 레이어 폴리라인(점 2개 이상)이 없습니다.", false);
      return;
    }
    mapWaterPoints = wt.map(([x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));
    renderWaterTable();
    redrawMapDxfPreview();
    toast(`@수위 레이어 ${mapWaterPoints.length}점 불러옴`);
  } catch (e) {
    toast(e.message, false);
  }
}

function readRegionMidMapFromTable() {
  const tbody = document.getElementById("map-tbody");
  const m = {};
  if (!tbody) return m;
  tbody.querySelectorAll("tr").forEach((tr) => {
    const ridInp = tr.querySelector(".map-region-mid-inp");
    if (!ridInp) return;
    const ridStr = tr.dataset.regionId;
    if (!ridStr) return;
    const idTxt = ridInp.value.trim() || "";
    if (!idTxt || idTxt === "0") {
      m[ridStr] = null;
      return;
    }
    const n = parseInt(idTxt, 10);
    m[ridStr] = Number.isFinite(n) && n !== 0 ? n : null;
  });
  return m;
}

// ─── 오버레이 드로잉 헬퍼 ─────────────────────────────────────

/** 상재하중 폴리라인 + 화살표 오버레이 (pl.points: [{x,y},...] 또는 구 형식 {x1,y1,x2,y2}) */
function drawPressureLineOnCanvas(ctx, wToC, pl, alpha = 1) {
  // 구 형식 호환
  const pts = pl.points
    ? pl.points.map(p => wToC(p.x, p.y))
    : [wToC(pl.x1, pl.y1), wToC(pl.x2, pl.y2)];
  if (pts.length < 2) return;

  // 각 세그먼트 길이 계산
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i+1][0] - pts[i][0], dy = pts[i+1][1] - pts[i][1];
    const l = Math.sqrt(dx*dx + dy*dy);
    segs.push({ dx, dy, l });
    totalLen += l;
  }
  if (totalLen < 2) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  // 폴리라인 선 그리기
  ctx.strokeStyle = "#ef5350";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();

  // 분포하중 화살표: 전체 길이 기준으로 균등 배치
  const arrowLen = Math.min(22, totalLen * 0.12);
  const nArrows = Math.max(2, Math.floor(totalLen / 28));
  const arrowHead = 5;
  ctx.strokeStyle = "#ef5350";
  ctx.lineWidth = 1.5;
  for (let a = 0; a <= nArrows; a++) {
    const dist = (a / nArrows) * totalLen;
    // 폴리라인 상의 위치 찾기
    let rem = dist, si = 0;
    while (si < segs.length - 1 && rem > segs[si].l) { rem -= segs[si].l; si++; }
    const seg = segs[si];
    const t = seg.l > 0 ? rem / seg.l : 0;
    const ax = pts[si][0] + seg.dx * t;
    const ay = pts[si][1] + seg.dy * t;
    const nx = -seg.dy / seg.l, ny = seg.dx / seg.l;
    const bx = ax + ny * arrowLen, by = ay - nx * arrowLen;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(ax, ay); ctx.stroke();
    const ang = Math.atan2(ay - by, ax - bx);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - arrowHead * Math.cos(ang - 0.4), ay - arrowHead * Math.sin(ang - 0.4));
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - arrowHead * Math.cos(ang + 0.4), ay - arrowHead * Math.sin(ang + 0.4));
    ctx.stroke();
  }

  // 압력값 라벨 (폴리라인 중앙 세그먼트 중점)
  const mid = pts[Math.floor(pts.length / 2)];
  const prev = pts[Math.floor(pts.length / 2) - 1] ?? pts[0];
  const mx = (prev[0] + mid[0]) / 2, my = (prev[1] + mid[1]) / 2;
  ctx.fillStyle = "#ef9a9a";
  ctx.font = "bold 11px system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${pl.pressure} kPa`, mx, my - 4);
  ctx.restore();
}

/**
 * X 좌표에서 DXF 리즌 경계의 최대 Y (지형 표면) 반환.
 * 드래그 중 핸들을 지형선 위로 스냅하는 데 사용.
 */
function getTerrainSurfaceY(x) {
  const regions = mapRegionPreviewCache?.regions;
  if (!regions?.length) return null;
  const EPS = 1e-9;
  let maxY = -Infinity;
  let found = false;
  for (const { poly } of regions) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % n];
      if (Math.abs(ax - x) < EPS) { if (ay > maxY) { maxY = ay; found = true; } }
      const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
      if (x > minX && x < maxX && Math.abs(bx - ax) > EPS) {
        const t = (x - ax) / (bx - ax);
        const y = ay + t * (by - ay);
        if (y > maxY) { maxY = y; found = true; }
      }
    }
  }
  return found ? maxY : null;
}

/**
 * x1~x2 사이 DXF 리즌 경계의 상단 윤곽(terrain profile)을 반환.
 * 반환: [{x, y}] (x1→x2 방향으로 정렬). 데이터 없으면 null.
 */
function getTerrainProfileBetween(x1, x2) {
  const regions = mapRegionPreviewCache?.regions;
  if (!regions?.length) return null;
  const xMin = Math.min(x1, x2);
  const xMax = Math.max(x1, x2);

  // 범위 내 모든 꼭짓점 X + 양 끝점
  const xSet = new Set([x1, x2]);
  for (const { poly } of regions) {
    for (const [ax] of poly) {
      if (ax > xMin && ax < xMax) xSet.add(ax);
    }
  }

  // 각 X에서 terrain 최대 Y
  const pts = [];
  for (const x of xSet) {
    const y = getTerrainSurfaceY(x);
    if (y !== null) pts.push({ x, y });
  }

  if (pts.length < 2) return null;
  const dir = x2 >= x1 ? 1 : -1;
  pts.sort((a, b) => dir * (a.x - b.x));
  return pts;
}

/** terrain profile 폴리라인을 캔버스에 그리는 헬퍼 */
function strokeTerrainProfile(ctx, wToC, profile, fallbackStart, fallbackEnd) {
  if (profile && profile.length >= 2) {
    ctx.beginPath();
    for (let i = 0; i < profile.length; i++) {
      const [pcx, pcy] = wToC(profile[i].x, profile[i].y);
      if (i === 0) ctx.moveTo(pcx, pcy); else ctx.lineTo(pcx, pcy);
    }
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(fallbackStart[0], fallbackStart[1]);
    ctx.lineTo(fallbackEnd[0], fallbackEnd[1]);
    ctx.stroke();
  }
}

/** 슬립 진입/출구 오버레이 (핸들 + 구간 밴드) */
function drawSlipOverlayOnCanvas(ctx, wToC, frame, row) {
  const slip = getEffectiveSlipPts(row);
  if (!slip) return;

  const ll = { x: parseFloat(slip.leftSideLeftPt?.x  ?? slip.ll?.x ?? 0), y: parseFloat(slip.leftSideLeftPt?.y  ?? slip.ll?.y ?? 0) };
  const lr = { x: parseFloat(slip.leftSideRightPt?.x ?? slip.lr?.x ?? 0), y: parseFloat(slip.leftSideRightPt?.y ?? slip.lr?.y ?? 0) };
  const rl = { x: parseFloat(slip.rightSideLeftPt?.x ?? slip.rl?.x ?? 0), y: parseFloat(slip.rightSideLeftPt?.y ?? slip.rl?.y ?? 0) };
  const rr = { x: parseFloat(slip.rightSideRightPt?.x?? slip.rr?.x ?? 0), y: parseFloat(slip.rightSideRightPt?.y?? slip.rr?.y ?? 0) };

  const [llcx, llcy] = wToC(ll.x, ll.y);
  const [lrcx, lrcy] = wToC(lr.x, lr.y);
  const [rlcx, rlcy] = wToC(rl.x, rl.y);
  const [rrcx, rrcy] = wToC(rr.x, rr.y);

  const dragH = mapSlipDragHandle?.handle;
  ctx.save();

  // ── 지형 경계를 따르는 선 ────────────────────────
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 4]);
  ctx.globalAlpha = 0.8;
  // 좌측 구간 LL→LR (주황): terrain profile
  ctx.strokeStyle = "#f9a825";
  strokeTerrainProfile(ctx, wToC, getTerrainProfileBetween(ll.x, lr.x), [llcx, llcy], [lrcx, lrcy]);
  // 우측 구간 RL→RR (하늘): terrain profile
  ctx.strokeStyle = "#4fc3f7";
  strokeTerrainProfile(ctx, wToC, getTerrainProfileBetween(rl.x, rr.x), [rlcx, rlcy], [rrcx, rrcy]);

  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // ── 핸들 ─────────────────────────────────────────
  const drawHandle = (cx, cy, color, label, dragging) => {
    ctx.beginPath();
    ctx.arc(cx, cy, dragging ? 9 : 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 9px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy);
  };

  drawHandle(llcx, llcy, "#e65100", "LL", dragH === "ll");
  drawHandle(lrcx, lrcy, "#f9a825", "LR", dragH === "lr");
  drawHandle(rlcx, rlcy, "#29b6f6", "RL", dragH === "rl");
  drawHandle(rrcx, rrcy, "#1565c0", "RR", dragH === "rr");

  // ── X 좌표 레이블 ─────────────────────────────────
  ctx.font = "10px system-ui";
  ctx.textBaseline = "top";
  ctx.globalAlpha = 0.7;
  const labels = [
    [llcx, llcy, "#e65100", ll.x],
    [lrcx, lrcy, "#f9a825", lr.x],
    [rlcx, rlcy, "#29b6f6", rl.x],
    [rrcx, rrcy, "#1565c0", rr.x],
  ];
  for (const [cx, cy, color, xv] of labels) {
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(`x=${xv.toFixed(1)}`, cx, cy + 11);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/** 격자 탐색 사각형(Grid+Radius) 오버레이 */
/** 앵커(ax,ay)와 현재 커서(cx,cy)에서 축-정렬 직각 사각형 4꼭짓점을 반환 */
function rectFromAnchorCurrent(ax, ay, cx, cy) {
  const x0 = Math.min(ax, cx), x1 = Math.max(ax, cx);
  const y0 = Math.min(ay, cy), y1 = Math.max(ay, cy);
  return {
    ul: { x: x0, y: y1 }, ll: { x: x0, y: y0 },
    lr: { x: x1, y: y0 }, ur: { x: x1, y: y1 },
  };
}

function drawGridOverlayOnCanvas(ctx, wToC, row) {
  const g = row.gridData;

  // corners 배열 [ul, ll, lr, ur] → ul→ur→lr→ll 시계방향으로 사각형 그리기
  function drawQuad(corners, color, labels, draggingZone, draggingCorner) {
    // corners 인덱스: 0=ul, 1=ll, 2=lr, 3=ur
    const cpts = corners.map(c => c ? wToC(c.x, c.y) : null);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    // ul(0)→ur(3)→lr(2)→ll(1) 순서로 닫힌 사각형
    const order = [0, 3, 2, 1];
    let first = true;
    for (const i of order) {
      const pt = cpts[i];
      if (!pt) continue;
      if (first) { ctx.moveTo(pt[0], pt[1]); first = false; }
      else ctx.lineTo(pt[0], pt[1]);
    }
    if (!first) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 핸들
    const keys = ["ul", "ll", "lr", "ur"];
    keys.forEach((key, i) => {
      const pt = cpts[i];
      if (!pt) return;
      const isDragging = (draggingZone === "grid" || draggingZone === "radius") && draggingCorner === key;
      ctx.beginPath();
      ctx.arc(pt[0], pt[1], isDragging ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 8px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(labels[i], pt[0], pt[1]);
    });
    ctx.restore();
  }

  if (g) {
    const dh = mapGridDragHandle;
    const gridCorners = [g.grid?.ul, g.grid?.ll, g.grid?.lr, g.grid?.ur];
    drawQuad(gridCorners, "#42a5f5", ["UL","LL","LR","UR"], dh?.zone === "grid" ? "grid" : null, dh?.corner);

    const radCorners = [g.radius?.ul, g.radius?.ll, g.radius?.lr, g.radius?.ur];
    drawQuad(radCorners, "#66bb6a", ["UL","LL","LR","UR"], dh?.zone === "radius" ? "radius" : null, dh?.corner);

    // 레이블
    ctx.save();
    ctx.font = "bold 10px system-ui,sans-serif";
    ctx.textBaseline = "bottom";
    if (g.grid?.ul) {
      const [cx, cy] = wToC(g.grid.ul.x, g.grid.ul.y);
      ctx.fillStyle = "#42a5f5";
      ctx.textAlign = "left";
      ctx.fillText(`Grid (${g.grid.numXInc ?? 10}×${g.grid.numYInc ?? 10})`, cx + 8, cy - 4);
    }
    if (g.radius?.ul) {
      const [cx, cy] = wToC(g.radius.ul.x, g.radius.ul.y);
      ctx.fillStyle = "#66bb6a";
      ctx.textAlign = "left";
      ctx.fillText(`Radius (${g.radius.numInc ?? 20})`, cx + 8, cy - 4);
    }
    ctx.restore();
  }

  // 사각형 그리기 중 라이브 프리뷰 (gridData 여부와 무관하게 항상 체크)
  if (mapGridDrawZone && mapGridDrawAnchor && mapMouseWorldXY) {
    const r = rectFromAnchorCurrent(
      mapGridDrawAnchor.x, mapGridDrawAnchor.y,
      mapMouseWorldXY[0], mapMouseWorldXY[1]
    );
    const color = mapGridDrawZone === "grid" ? "#42a5f5" : "#66bb6a";
    // ul→ur→lr→ll 순 (시계 방향)
    const pts = [r.ul, r.ur, r.lr, r.ll].map(c => wToC(c.x, c.y));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    // 앵커 마커
    const [ancX, ancY] = wToC(mapGridDrawAnchor.x, mapGridDrawAnchor.y);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(ancX, ancY, 5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }
}

/** mapDxfLayersCache 에서 모든 고유 꼭짓점을 {x,y}[] 로 반환 */
function getDxfNodePoints() {
  if (!mapDxfLayersCache) return [];
  const pts = [];
  const seen = new Set();
  for (const polys of Object.values(mapDxfLayersCache)) {
    for (const poly of polys) {
      for (const [x, y] of poly) {
        const k = `${Math.round(x * 1e4) / 1e4},${Math.round(y * 1e4) / 1e4}`;
        if (!seen.has(k)) { seen.add(k); pts.push({ x, y }); }
      }
    }
  }
  return pts;
}

/**
 * CSS 픽셀 좌표 (cssX, cssY) 에서 가장 가까운 DXF 노드를 반환.
 * 스냅 반경(12 CSS px) 내에 없으면 null.
 */
function snapDxfNode(cssX, cssY) {
  const frame = mapLastDrawFrame;
  if (!frame) return null;
  const nodes = getDxfNodePoints();
  const SNAP_PX = 12;
  let best = null, bestD = SNAP_PX;
  for (const node of nodes) {
    const [cx, cy] = worldToCanvasWithView(node.x, node.y, frame, mapDxfCanvasView);
    const d = Math.hypot(cx - cssX, cy - cssY);
    if (d < bestD) { bestD = d; best = node; }
  }
  return best;
}

/** 캔버스 오버레이 전체 (상재하중 + 슬립 + 그리기 중 프리뷰) */
function drawMapOverlayOnCanvas() {
  const canvas = document.getElementById("map-dxf-canvas");
  if (!canvas) return;
  // mapLastDrawFrame: drawMapDxfPreviewRegions 반환값 — 여기서 다시 setupCanvas를 호출하면 캔버스가 지워짐
  const frame = mapLastDrawFrame;
  if (!frame) return;

  const ctx = canvas.getContext("2d");
  // transform은 drawMapDxfPreviewRegions → setupCanvas 에서 이미 설정됨, 재설정 불필요
  const wToC = (x, y) => worldToCanvasWithView(x, y, frame, mapDxfCanvasView);
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  initRowExtras(row);

  // 상재하중 선분 그리기
  if (mapLayerVisible.pressure) {
    for (const pl of row.pressureLines) {
      drawPressureLineOnCanvas(ctx, wToC, pl);
    }
  }

  // pressure 모드 — 누적 노드 프리뷰 (레이어 off여도 현재 그리는 중이면 표시)
  if (mapCanvasMode === "pressure" && mapPressurePoints.length > 0) {
    // 이미 확정된 세그먼트들
    for (let i = 0; i < mapPressurePoints.length - 1; i++) {
      drawPressureLineOnCanvas(ctx, wToC, {
        points: [mapPressurePoints[i], mapPressurePoints[i + 1]], pressure: "…",
      }, 0.5);
    }
    // 마지막 노드 → 현재 마우스 미리보기
    if (mapMouseWorldXY) {
      const last = mapPressurePoints[mapPressurePoints.length - 1];
      drawPressureLineOnCanvas(ctx, wToC, {
        points: [last, { x: mapMouseWorldXY[0], y: mapMouseWorldXY[1] }], pressure: "…",
      }, 0.3);
    }
    // 확정 노드 마커 (빨간 점)
    ctx.save();
    ctx.fillStyle = "#ef5350";
    for (const pt of mapPressurePoints) {
      const [cx, cy] = wToC(pt.x, pt.y);
      ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // 슬립 오버레이 (슬립 모드이거나 슬립 데이터 있을 때, 레이어 off면 숨김)
  const hasSlip = row.slipPts != null || mapSlipAutoComputed != null;
  if (mapLayerVisible.slip && (mapCanvasMode === "slip" || hasSlip) && (mapRegionPreviewCache?.regions?.length)) {
    drawSlipOverlayOnCanvas(ctx, wToC, frame, row);
  }

  // 격자 탐색 오버레이 (grid 모드이거나 gridData 있을 때)
  const hasGrid = row.gridData != null;
  if (mapLayerVisible.grid && (mapCanvasMode === "grid" || hasGrid)) {
    drawGridOverlayOnCanvas(ctx, wToC, row);
  }

  // DXF 노드 점 (레이어 on일 때만) + pressure 모드 스냅 하이라이트
  if (mapLayerVisible.nodes && mapDxfLayersCache) {
    const nodes = getDxfNodePoints();
    if (nodes.length) {
      ctx.save();
      ctx.fillStyle = "rgba(80, 160, 255, 0.75)";
      for (const { x, y } of nodes) {
        const [cx, cy] = wToC(x, y);
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (mapCanvasMode === "pressure" && mapSnapNode) {
        const [scx, scy] = wToC(mapSnapNode.x, mapSnapNode.y);
        ctx.strokeStyle = "#ffd600";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(scx, scy, 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

// ─── 상재하중 목록 패널 ─────────────────────────────────────────
function renderPressureListPanel() {
  const el = document.getElementById("map-pressure-list");
  if (!el) return;
  el.innerHTML = "";
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  initRowExtras(row);
  if (!row.pressureLines.length) return;

  row.pressureLines.forEach((pl, i) => {
    // 구 형식(x1,y1,x2,y2) → 신 형식(points) 호환 변환
    if (!pl.points && pl.x1 !== undefined) {
      pl.points = [{ x: pl.x1, y: pl.y1 }, { x: pl.x2, y: pl.y2 }];
    }

    const item = document.createElement("div");
    item.className = "map-pressure-item";

    // ── 헤더 행 (항상 표시) ──
    const header = document.createElement("div");
    header.className = "map-pl-header";

    const no = document.createElement("span");
    no.className = "map-pressure-item-no";
    no.textContent = `PL-${i + 1}`;

    const summary = document.createElement("span");
    summary.className = "map-pl-summary";
    summary.textContent = `${pl.points.length}pts · ${pl.pressure} kPa`;

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "btn map-pl-expand-btn";
    expandBtn.textContent = "▶";
    expandBtn.title = "펼치기 / 접기";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn map-pressure-del-btn";
    delBtn.textContent = "삭제";
    delBtn.addEventListener("click", () => {
      row.pressureLines.splice(i, 1);
      renderPressureListPanel();
      redrawMapDxfPreview();
    });

    header.appendChild(no);
    header.appendChild(summary);
    header.appendChild(expandBtn);
    header.appendChild(delBtn);

    // ── 상세 패널 (접힘 기본값) ──
    const detail = document.createElement("div");
    detail.className = "map-pl-detail";
    detail.style.display = "none";

    const makeField = (label, rawVal, onChange) => {
      const wrap = document.createElement("span");
      wrap.className = "map-pl-field";
      if (label) {
        const lsp = document.createElement("span");
        lsp.className = "map-pl-field-lbl";
        lsp.textContent = label;
        wrap.appendChild(lsp);
      }
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "map-pl-coord-inp";
      inp.value = typeof rawVal === "string" ? rawVal : Number(rawVal).toFixed(3);
      inp.addEventListener("change", () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) { onChange(v); redrawMapDxfPreview(); }
        else inp.value = typeof rawVal === "string" ? rawVal : Number(rawVal).toFixed(3);
      });
      wrap.appendChild(inp);
      return wrap;
    };

    // 각 노드 행
    pl.points.forEach((pt, j) => {
      const nodeRow = document.createElement("div");
      nodeRow.className = "map-pl-node-row";
      const lbl = document.createElement("span");
      lbl.className = "map-pl-node-lbl";
      lbl.textContent = `P${j + 1}`;
      nodeRow.appendChild(lbl);
      nodeRow.appendChild(makeField("X", pt.x, v => { pt.x = v; }));
      nodeRow.appendChild(makeField("Y", pt.y, v => { pt.y = v; }));
      detail.appendChild(nodeRow);
    });

    // kPa 행
    const kpaRow = document.createElement("div");
    kpaRow.className = "map-pl-node-row";
    const kpaLbl = document.createElement("span");
    kpaLbl.className = "map-pl-node-lbl";
    kpaLbl.textContent = "kPa";
    kpaRow.appendChild(kpaLbl);
    kpaRow.appendChild(makeField("", pl.pressure, v => {
      pl.pressure = String(v);
      summary.textContent = `${pl.points.length}pts · ${pl.pressure} kPa`;
    }));
    detail.appendChild(kpaRow);

    // 펼치기/접기 토글
    expandBtn.addEventListener("click", () => {
      const open = detail.style.display !== "none";
      detail.style.display = open ? "none" : "";
      expandBtn.textContent = open ? "▶" : "▼";
    });

    item.appendChild(header);
    item.appendChild(detail);
    el.appendChild(item);
  });
}

// ─── 슬립 패널 동기화 ────────────────────────────────────────────
function syncSlipPanelFromRow() {
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  initRowExtras(row);
  const slip = getEffectiveSlipPts(row);
  const fmt = (v) => (v != null && Number.isFinite(Number(v)) ? String(v) : "");
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = fmt(val); };
  if (slip) {
    set("map-slip-ll-x",  slip.leftSideLeftPt?.x   ?? slip.ll?.x ?? "");
    set("map-slip-ll-y",  slip.leftSideLeftPt?.y   ?? slip.ll?.y ?? "");
    set("map-slip-lr-x",  slip.leftSideRightPt?.x  ?? slip.lr?.x ?? "");
    set("map-slip-lr-y",  slip.leftSideRightPt?.y  ?? slip.lr?.y ?? "");
    set("map-slip-rl-x",  slip.rightSideLeftPt?.x  ?? slip.rl?.x ?? "");
    set("map-slip-rl-y",  slip.rightSideLeftPt?.y  ?? slip.rl?.y ?? "");
    set("map-slip-rr-x",  slip.rightSideRightPt?.x ?? slip.rr?.x ?? "");
    set("map-slip-rr-y",  slip.rightSideRightPt?.y ?? slip.rr?.y ?? "");
    set("map-slip-linc",   slip.leftInc   ?? 20);
    set("map-slip-rinc",   slip.rightInc  ?? 20);
    set("map-slip-radinc", slip.radiusInc ?? 20);
  }
}

function flushSlipPanelToRow() {
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  initRowExtras(row);
  const g = (id) => document.getElementById(id)?.value.trim() ?? "";
  const pf = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const llX = pf(g("map-slip-ll-x")), llY = pf(g("map-slip-ll-y"));
  const lrX = pf(g("map-slip-lr-x")), lrY = pf(g("map-slip-lr-y"));
  const rlX = pf(g("map-slip-rl-x")), rlY = pf(g("map-slip-rl-y"));
  const rrX = pf(g("map-slip-rr-x")), rrY = pf(g("map-slip-rr-y"));
  if ([llX, llY, lrX, lrY, rlX, rlY, rrX, rrY].some(v => v === null)) return;
  row.slipPts = {
    leftSideLeftPt:   { x: llX, y: llY },
    leftSideRightPt:  { x: lrX, y: lrY },
    rightSideLeftPt:  { x: rlX, y: rlY },
    rightSideRightPt: { x: rrX, y: rrY },
    leftInc:   pf(g("map-slip-linc"))   ?? 20,
    rightInc:  pf(g("map-slip-rinc"))   ?? 20,
    radiusInc: pf(g("map-slip-radinc")) ?? 20,
  };
}

function redrawMapDxfPreview() {
  const canvas = document.getElementById("map-dxf-canvas");
  const legend = document.getElementById("map-dxf-legend");
  if (!canvas) return;
  const regions = mapRegionPreviewCache?.regions || [];
  const midMap = mapLayerVisible.materials ? readRegionMidMapFromTable() : {};
  mapLastDrawFrame = drawMapDxfPreviewRegions(
    canvas,
    regions,
    midMap,
    mapLayerVisible.materials ? mapMaterialRgbById : new Map(),
    mapWaterPoints,
    mapDxfCanvasView,
  ) ?? null;
  renderMapDxfLegendRegions(
    legend,
    regions,
    midMap,
    mapMaterialRgbById,
    mapMaterialNameById,
  );
  updateMapCanvasZoomPct();
  drawMapOverlayOnCanvas();
}

function updateMapCanvasZoomPct() {
  const el = document.getElementById("map-canvas-zoom-pct");
  if (!el) return;
  const z = mapDxfCanvasView.zoom != null && Number.isFinite(mapDxfCanvasView.zoom)
    ? mapDxfCanvasView.zoom
    : 1;
  el.textContent = `${Math.round(z * 100)}%`;
}

function syncMapMatRefPaintHighlight() {
  document
    .querySelectorAll("#map-mat-ref-tbody tr.map-mat-ref-tr")
    .forEach((tr) => {
      tr.classList.toggle(
        "map-mat-paint-on",
        mapPaintMaterialId != null &&
          tr.dataset.materialId === mapPaintMaterialId,
      );
    });
}

function setMapPaintMaterialId(id) {
  mapPaintMaterialId = id != null && String(id).trim() !== "" ? String(id) : null;
  syncMapMatRefPaintHighlight();
  const canvas = document.getElementById("map-dxf-canvas");
  if (canvas) {
    canvas.classList.toggle("map-canvas-paint-mode", !!mapPaintMaterialId);
  }
}

function assignMaterialToRegion(regId, mid) {
  if (regId == null || mid == null || !Number.isFinite(mid) || mid === 0)
    return;
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  row.regionMaterials[String(regId)] = mid;
  refillMapRegionTbodyFromCache();
  redrawMapDxfPreview();
}

async function performDxfScan(file, logEl) {
  if (!file) return;
  if (logEl != null) logEl.textContent = "DXF 파싱 중...\n";
  const text = await file.text();
  const parsed = await parseDxfText(text);
  const layers = readLayersFromDxfParsed(parsed);
  mapDxfLayersCache = layers;
  recomputeRegionPreviewCache();
  resetMapPreviewView(mapDxfCanvasView);
  refillMapRegionTbodyFromCache();
  const wt = readWaterTablePolylineFromDxf(parsed);
  if (wt && wt.length >= 2) {
    mapWaterPoints = wt.map(([x, y]) => ({
      x: Number(x),
      y: Number(y),
    }));
    renderWaterTable();
    if (logEl != null) {
      logEl.textContent += `✓ @수위 레이어 → 수위 표 ${mapWaterPoints.length}점\n`;
    }
  }
  redrawMapDxfPreview();
  if (logEl != null) {
    logEl.textContent += `✓ ${mapRegionPreviewCache?.regions?.length ?? 0}개 Region · ${Object.keys(layers).length}개 DXF 레이어\n`;
  }
}

function setupMapPreviewResize() {
  const wrap = document.querySelector(".map-preview-wrap");
  if (!wrap || wrap.dataset.roBound === "1") return;
  wrap.dataset.roBound = "1";
  let t = null;
  const ro = new ResizeObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => redrawMapDxfPreview(), 60);
  });
  ro.observe(wrap);
}

function flushActiveAnalysisRegionsFromTable() {
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  row.regionMaterials = collectFullRegionMapFromTbody();
}

function collectFullRegionMapFromTbody() {
  const tbody = document.getElementById("map-tbody");
  const m = {};
  if (!tbody) return m;
  tbody.querySelectorAll("tr").forEach((tr) => {
    const ridStr = tr.dataset.regionId;
    if (!ridStr) return;
    const idTxt =
      tr.querySelector(".map-region-mid-inp")?.value.trim() || "";
    if (!idTxt || idTxt === "0") m[ridStr] = null;
    else {
      const n = parseInt(idTxt, 10);
      m[ridStr] = Number.isFinite(n) && n !== 0 ? n : null;
    }
  });
  return m;
}

function refillMapRegionTbodyFromCache() {
  const tbody = document.getElementById("map-tbody");
  if (!tbody || !mapRegionPreviewCache?.regions) return;
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  tbody.innerHTML = "";
  for (const { regId, layer } of mapRegionPreviewCache.regions) {
    const mid = row.regionMaterials[String(regId)];
    const val =
      mid != null && mid !== 0 && Number.isFinite(mid) ? String(mid) : "";
    const tr = document.createElement("tr");
    tr.dataset.regionId = String(regId);
    tr.innerHTML = `
      <td class="map-cell-label">R${escapeHtml(String(regId))}</td>
      <td class="map-cell-text">${escapeHtml(layer)}</td>
      <td><input type="text" class="map-region-mid-inp" value="${escapeHtml(val)}" /></td>`;
    tbody.appendChild(tr);
  }
}

function initAnalysesFromTemplateDoc(doc) {
  const list = listAnalysesFromDocument(doc);
  if (!list.length) {
    const row = { id: 1, title: "Analysis 1", regionMaterials: {} };
    initRowExtras(row);
    mapAnalysesState.rows = [row];
  } else {
    mapAnalysesState.rows = list.map((a) => {
      const row = {
        id: parseInt(String(a.id), 10) || 1,
        title: (a.name && String(a.name).trim()) || `해석 ${a.id}`,
        regionMaterials: {},
      };
      initRowExtras(row);
      return row;
    });
  }
  mapAnalysesState.activeIndex = 0;
  mergeRegionKeysIntoAllAnalysisRows();
}

function resetMapAnalysesToDefault() {
  const row = { id: 1, title: "Analysis 1", regionMaterials: {} };
  initRowExtras(row);
  mapAnalysesState.rows = [row];
  mapAnalysesState.activeIndex = 0;
  mergeRegionKeysIntoAllAnalysisRows();
}

function setActiveAnalysisIndex(idx) {
  if (idx < 0 || idx >= mapAnalysesState.rows.length) return;
  flushActiveAnalysisRegionsFromTable();
  mapAnalysesState.activeIndex = idx;
  renderMapAnalysisRows();
  refillMapRegionTbodyFromCache();
  renderPressureListPanel();
  if (mapCanvasMode === "slip") syncSlipPanelFromRow();
  redrawMapDxfPreview();
}

function deleteAnalysisRow(idx) {
  if (mapAnalysesState.rows.length <= 1) return;
  flushActiveAnalysisRegionsFromTable();
  mapAnalysesState.rows.splice(idx, 1);
  if (mapAnalysesState.activeIndex >= mapAnalysesState.rows.length) {
    mapAnalysesState.activeIndex = mapAnalysesState.rows.length - 1;
  } else if (idx < mapAnalysesState.activeIndex) {
    mapAnalysesState.activeIndex--;
  }
  renderMapAnalysisRows();
  refillMapRegionTbodyFromCache();
  redrawMapDxfPreview();
}

function renderMapAnalysisRows() {
  const tbody = document.getElementById("map-analysis-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  mapAnalysesState.rows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(idx);

    const tdR = document.createElement("td");
    tdR.style.textAlign = "center";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "map-analysis-active";
    radio.value = String(idx);
    radio.checked = idx === mapAnalysesState.activeIndex;
    tdR.appendChild(radio);

    const tdId = document.createElement("td");
    const idInp = document.createElement("input");
    idInp.type = "number";
    idInp.min = "1";
    idInp.max = "999";
    idInp.className = "map-analysis-id-inp";
    idInp.value = String(row.id);
    tdId.appendChild(idInp);

    const tdTitle = document.createElement("td");
    const titleInp = document.createElement("input");
    titleInp.type = "text";
    titleInp.className = "map-analysis-title-inp";
    titleInp.placeholder = "GeoStudio Analysis NAME";
    titleInp.value = row.title;
    tdTitle.appendChild(titleInp);

    const tdKh = document.createElement("td");
    const khInp = document.createElement("input");
    khInp.type = "text";
    khInp.className = "map-analysis-kh-inp";
    khInp.placeholder = "0.066";
    khInp.title = "수평지진계수 kh (없으면 빈칸)";
    initRowExtras(row);
    khInp.value = row.seismicH ?? "";
    tdKh.appendChild(khInp);

    const tdDel = document.createElement("td");
    tdDel.style.textAlign = "center";
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn map-analysis-del-btn";
    delBtn.textContent = "삭제";
    delBtn.disabled = mapAnalysesState.rows.length <= 1;
    tdDel.appendChild(delBtn);

    tr.appendChild(tdR);
    tr.appendChild(tdId);
    tr.appendChild(tdTitle);
    tr.appendChild(tdKh);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

function bindMapAnalysisTable() {
  const tbody = document.getElementById("map-analysis-tbody");
  if (!tbody || tbody.dataset.bound) return;
  tbody.dataset.bound = "1";
  installTableArrowNav(tbody, {
    cellSelector: 'input.map-analysis-id-inp, input.map-analysis-title-inp, input.map-analysis-kh-inp',
  });
  tbody.addEventListener("change", (e) => {
    const t = e.target;
    const tr = t.closest("tr");
    const idx = parseInt(tr?.dataset.index ?? "", 10);
    if (Number.isNaN(idx)) return;
    if (t.matches('input[type="radio"][name="map-analysis-active"]')) {
      if (t.checked) setActiveAnalysisIndex(idx);
      return;
    }
    if (t.classList.contains("map-analysis-id-inp")) {
      flushActiveAnalysisRegionsFromTable();
      let newId = parseInt(t.value, 10);
      if (!Number.isFinite(newId) || newId < 1) newId = 1;
      const clash = mapAnalysesState.rows.some(
        (r, i) => i !== idx && r.id === newId,
      );
      if (clash) {
        toast("Analysis ID가 다른 행과 중복됩니다.", false);
        t.value = String(mapAnalysesState.rows[idx].id);
        return;
      }
      mapAnalysesState.rows[idx].id = newId;
      t.value = String(newId);
    }
  });
  tbody.addEventListener("input", (e) => {
    const t = e.target;
    const tr = t.closest("tr");
    const idx = parseInt(tr?.dataset.index ?? "", 10);
    if (Number.isNaN(idx)) return;
    if (t.classList.contains("map-analysis-title-inp")) {
      mapAnalysesState.rows[idx].title = t.value;
    }
    if (t.classList.contains("map-analysis-kh-inp")) {
      initRowExtras(mapAnalysesState.rows[idx]);
      mapAnalysesState.rows[idx].seismicH = t.value;
    }
  });
  tbody.addEventListener("click", (e) => {
    const btn = e.target.closest(".map-analysis-del-btn");
    if (!btn || btn.disabled) return;
    const tr = btn.closest("tr");
    const idx = parseInt(tr?.dataset.index ?? "", 10);
    if (Number.isNaN(idx)) return;
    deleteAnalysisRow(idx);
  });
}

function ensureMapTbodyPreviewBound() {
  const mt = document.getElementById("map-tbody");
  if (mt && !mt.dataset.dxfPreviewInputBound) {
    mt.dataset.dxfPreviewInputBound = "1";
    mt.addEventListener("input", redrawMapDxfPreview);
  }
}

// ─── 캔버스 그리기 모드 ──────────────────────────────────────────

function switchMapCanvasMode(mode) {
  mapCanvasMode = mode;
  mapPressurePoints = [];
  mapSlipDragHandle = null;
  mapGridDragHandle = null;
  mapGridDrawZone = null;
  mapGridDrawAnchor = null;
  mapMouseWorldXY = null;
  mapSnapNode = null;

  ["map-tool-paint", "map-tool-pressure", "map-tool-slip", "map-tool-grid"].forEach((id) => {
    document.getElementById(id)?.classList.remove("active");
  });
  const modeBtn = { paint: "map-tool-paint", pressure: "map-tool-pressure", slip: "map-tool-slip", grid: "map-tool-grid" };
  document.getElementById(modeBtn[mode])?.classList.add("active");

  const canvas = document.getElementById("map-dxf-canvas");
  if (canvas) {
    canvas.classList.toggle("map-canvas-paint-mode",    mode === "paint");
    canvas.classList.toggle("map-canvas-pressure-mode", mode === "pressure");
    canvas.classList.toggle("map-canvas-slip-mode",     mode === "slip");
    canvas.classList.toggle("map-canvas-grid-mode",     mode === "grid");
  }

  // 패널 표시/숨김
  const pressurePanel = document.getElementById("map-pressure-input-panel");
  const slipPanel     = document.getElementById("map-slip-panel");
  const gridPanel     = document.getElementById("map-grid-panel");
  if (pressurePanel) pressurePanel.style.display = mode === "pressure" ? "" : "none";
  if (slipPanel)     slipPanel.style.display     = mode === "slip"     ? "" : "none";
  if (gridPanel)     gridPanel.style.display     = mode === "grid"     ? "" : "none";

  if (mode === "pressure") {
    const hint = document.getElementById("map-pressure-hint");
    const form = document.getElementById("map-pressure-form");
    if (hint) hint.style.display = "";
    if (form) form.style.display = "none";
  }
  if (mode !== "paint") setMapPaintMaterialId(null);

  if (mode === "slip") syncSlipPanelFromRow();
  if (mode === "grid") syncGridPanelFromRow();

  redrawMapDxfPreview();
}

/** 슬립 핸들 히트 테스트 (canvas client 좌표, 반환: null | "ll"|"lr"|"rl"|"rr") */
function hitTestSlipHandle(canvas, clientX, clientY) {
  const frame = mapLastDrawFrame;
  if (!frame) return null;
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return null;
  const slip = getEffectiveSlipPts(row);
  if (!slip) return null;

  const pts = {
    ll: slip.leftSideLeftPt   ?? slip.ll,
    lr: slip.leftSideRightPt  ?? slip.lr,
    rl: slip.rightSideLeftPt  ?? slip.rl,
    rr: slip.rightSideRightPt ?? slip.rr,
  };
  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const HIT_R = 14;
  for (const [key, pt] of Object.entries(pts)) {
    if (!pt) continue;
    const [pcx, pcy] = worldToCanvasWithView(Number(pt.x), Number(pt.y), frame, mapDxfCanvasView);
    if (Math.hypot(cx - pcx, cy - pcy) <= HIT_R) return key;
  }
  return null;
}

/** 격자 탐색 핸들 히트 테스트. 반환: null | { zone:"grid"|"radius", corner:"ul"|"ll"|"lr"|"ur" } */
function hitTestGridHandle(canvas, clientX, clientY) {
  const frame = mapLastDrawFrame;
  if (!frame) return null;
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return null;
  initRowExtras(row);
  if (!row.gridData) return null;

  const rect = canvas.getBoundingClientRect();
  const cx = clientX - rect.left;
  const cy = clientY - rect.top;
  const HIT_R = 14;
  const corners = ["ul", "ll", "lr", "ur"];
  for (const zone of ["grid", "radius"]) {
    const box = row.gridData[zone];
    if (!box) continue;
    for (const corner of corners) {
      const pt = box[corner];
      if (!pt) continue;
      const [pcx, pcy] = worldToCanvasWithView(Number(pt.x), Number(pt.y), frame, mapDxfCanvasView);
      if (Math.hypot(cx - pcx, cy - pcy) <= HIT_R) return { zone, corner };
    }
  }
  return null;
}

/** 격자 패널을 현재 행 데이터로 채우기 */
function syncGridPanelFromRow() {
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  initRowExtras(row);
  const g = row.gridData;
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
  if (!g) return;
  const { grid, radius } = g;
  if (grid) {
    set("map-grid-ul-x", grid.ul?.x ?? ""); set("map-grid-ul-y", grid.ul?.y ?? "");
    set("map-grid-ll-x", grid.ll?.x ?? ""); set("map-grid-ll-y", grid.ll?.y ?? "");
    set("map-grid-lr-x", grid.lr?.x ?? ""); set("map-grid-lr-y", grid.lr?.y ?? "");
    set("map-grid-ur-x", grid.ur?.x ?? ""); set("map-grid-ur-y", grid.ur?.y ?? "");
    set("map-grid-xinc", grid.numXInc ?? 10);
    set("map-grid-yinc", grid.numYInc ?? 10);
  }
  if (radius) {
    set("map-rad-ul-x", radius.ul?.x ?? ""); set("map-rad-ul-y", radius.ul?.y ?? "");
    set("map-rad-ll-x", radius.ll?.x ?? ""); set("map-rad-ll-y", radius.ll?.y ?? "");
    set("map-rad-lr-x", radius.lr?.x ?? ""); set("map-rad-lr-y", radius.lr?.y ?? "");
    set("map-rad-ur-x", radius.ur?.x ?? ""); set("map-rad-ur-y", radius.ur?.y ?? "");
    set("map-rad-ninc", radius.numInc ?? 20);
  }
}

/** 격자 패널 입력값을 현재 행에 flush */
function flushGridPanelToRow() {
  const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
  if (!row) return;
  initRowExtras(row);
  const g = (id) => document.getElementById(id)?.value.trim() ?? "";
  const pf = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const pt = (xi, yi) => {
    const x = pf(g(xi)), y = pf(g(yi));
    return (x !== null && y !== null) ? { x, y } : null;
  };
  const ul = pt("map-grid-ul-x","map-grid-ul-y");
  const ll = pt("map-grid-ll-x","map-grid-ll-y");
  const lr = pt("map-grid-lr-x","map-grid-lr-y");
  const ur = pt("map-grid-ur-x","map-grid-ur-y");
  const rul = pt("map-rad-ul-x","map-rad-ul-y");
  const rll = pt("map-rad-ll-x","map-rad-ll-y");
  const rlr = pt("map-rad-lr-x","map-rad-lr-y");
  const rur = pt("map-rad-ur-x","map-rad-ur-y");
  if (!row.gridData) row.gridData = {
    grid:   { ul: null, ll: null, lr: null, ur: null, numXInc: 10, numYInc: 10 },
    radius: { ul: null, ll: null, lr: null, ur: null, numInc: 20 },
  };
  if (ul || ll || lr || ur) {
    row.gridData.grid.ul = ul; row.gridData.grid.ll = ll;
    row.gridData.grid.lr = lr; row.gridData.grid.ur = ur;
    row.gridData.grid.numXInc = pf(g("map-grid-xinc")) ?? 10;
    row.gridData.grid.numYInc = pf(g("map-grid-yinc")) ?? 10;
  }
  if (rul || rll || rlr || rur) {
    row.gridData.radius.ul = rul; row.gridData.radius.ll = rll;
    row.gridData.radius.lr = rlr; row.gridData.radius.ur = rur;
    row.gridData.radius.numInc = pf(g("map-rad-ninc")) ?? 20;
  }
}

/** DXF 범위로 Grid/Radius 초기값 자동 설정 */
function autoInitGridDataFromDxf(row) {
  initRowExtras(row);
  const nodes = getDxfNodePoints();
  if (!nodes.length) { toast("DXF 데이터가 없습니다.", false); return; }
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const { x, y } of nodes) {
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  const W = xmax - xmin, H = ymax - ymin;
  // Grid: 상단 2/3 영역 (원의 중심이 비탈 위에 있음)
  const gxpad = W * 0.1, gypad = H * 0.1;
  const gUL = { x: xmin + gxpad, y: ymax - gypad };
  const gLL = { x: xmin + gxpad, y: ymin + H * 0.3 };
  const gLR = { x: xmax - gxpad, y: ymin + H * 0.3 };
  const gUR = { x: xmax - gxpad, y: ymax - gypad };
  // Radius: 하단 중간 영역 (반경 접선 제어)
  const rxpad = W * 0.2, rypad = H * 0.15;
  const rUL = { x: xmin + rxpad, y: ymin + H * 0.45 };
  const rLL = { x: xmin + rxpad, y: ymin + rypad };
  const rLR = { x: xmax - rxpad, y: ymin + rypad };
  const rUR = { x: xmax - rxpad, y: ymin + H * 0.45 };
  row.gridData = {
    grid:   { ul: gUL, ll: gLL, lr: gLR, ur: gUR, numXInc: 10, numYInc: 10 },
    radius: { ul: rUL, ll: rLL, lr: rLR, ur: rUR, numInc: 20 },
  };
  syncGridPanelFromRow();
  redrawMapDxfPreview();
  toast("Grid/Radius가 DXF 범위 기준으로 초기화되었습니다.");
}

function bindMapCanvasZoomPan() {
  const canvas = document.getElementById("map-dxf-canvas");
  if (!canvas || canvas.dataset.zoomPanBound === "1") return;
  canvas.dataset.zoomPanBound = "1";

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const frame = mapLastDrawFrame;
      if (!frame) return;
      applyWheelToMapView(
        mapDxfCanvasView,
        frame,
        canvas,
        e.clientX,
        e.clientY,
        e.deltaY,
      );
      redrawMapDxfPreview();
    },
    { passive: false },
  );

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    const regions = mapRegionPreviewCache?.regions || [];
    if (!regions.length) return;
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      drag = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        pan0X: mapDxfCanvasView.panX,
        pan0Y: mapDxfCanvasView.panY,
      };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const frame = mapLastDrawFrame;
    if (!frame) return;
    const rect = canvas.getBoundingClientRect();
    const dx =
      ((e.clientX - drag.startClientX) / (rect.width || 1)) * frame.w;
    const dy =
      ((e.clientY - drag.startClientY) / (rect.height || 1)) * frame.h;
    if (Math.hypot(dx, dy) > 2) mapCanvasSuppressNextClick = true;
    mapDxfCanvasView.panX = drag.pan0X + dx;
    mapDxfCanvasView.panY = drag.pan0Y + dy;
    redrawMapDxfPreview();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  });

  canvas.addEventListener("pointercancel", () => {
    drag = null;
  });

  canvas.addEventListener("contextmenu", (e) => {
    if (e.button === 1) e.preventDefault();
  });
}

function wireMapCanvasZoomButtons() {
  const canvas = document.getElementById("map-dxf-canvas");
  const getFrame = () => mapLastDrawFrame;
  document
    .getElementById("map-canvas-zoom-in")
    ?.addEventListener("click", () => {
      const frame = getFrame();
      if (!frame) return;
      stepMapViewZoomCenter(mapDxfCanvasView, frame, 1.2);
      redrawMapDxfPreview();
    });
  document
    .getElementById("map-canvas-zoom-out")
    ?.addEventListener("click", () => {
      const frame = getFrame();
      if (!frame) return;
      stepMapViewZoomCenter(mapDxfCanvasView, frame, 1 / 1.2);
      redrawMapDxfPreview();
    });
  document
    .getElementById("map-canvas-zoom-reset")
    ?.addEventListener("click", () => {
      resetMapPreviewView(mapDxfCanvasView);
      redrawMapDxfPreview();
    });
}

function bindMapDrawModeCanvas() {
  const canvas = document.getElementById("map-dxf-canvas");
  if (!canvas || canvas.dataset.drawModeBound === "1") return;
  canvas.dataset.drawModeBound = "1";

  // 마우스 이동 → 프리뷰 업데이트 (상재하중 모드) + 슬립 커서
  canvas.addEventListener("mousemove", (e) => {
    if (mapCanvasMode === "pressure") {
      const frame = mapLastDrawFrame;
      if (!frame) return;
      const rect = canvas.getBoundingClientRect();
      const snapped = snapDxfNode(e.clientX - rect.left, e.clientY - rect.top);
      mapSnapNode = snapped;
      mapMouseWorldXY = snapped
        ? [snapped.x, snapped.y]
        : clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);
      redrawMapDxfPreview(); // 스냅 하이라이트 + 선분 프리뷰 갱신
    } else if (mapCanvasMode === "slip") {
      const h = hitTestSlipHandle(canvas, e.clientX, e.clientY);
      canvas.style.cursor = h ? "grab" : "default";
    } else if (mapCanvasMode === "grid") {
      if (mapGridDrawZone) {
        // 그리기 모드 (앵커 설정 전/후 모두) — 마우스 위치 항상 갱신
        const frame = mapLastDrawFrame;
        if (frame) mapMouseWorldXY = clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);
        canvas.style.cursor = "crosshair";
        redrawMapDxfPreview();
      } else if (!mapGridDragHandle) {
        const h = hitTestGridHandle(canvas, e.clientX, e.clientY);
        canvas.style.cursor = h ? "grab" : "default";
      }
    } else {
      mapMouseWorldXY = null;
      mapSnapNode = null;
    }
  });

  // pointerdown → 상재하중 첫/두 번째 클릭 OR 슬립 드래그 시작
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.altKey) return; // alt+drag는 pan에서 처리

    if (mapCanvasMode === "pressure") {
      e.preventDefault();
      const frame = mapLastDrawFrame;
      if (!frame) return;
      const rect = canvas.getBoundingClientRect();
      const snapped = snapDxfNode(e.clientX - rect.left, e.clientY - rect.top);
      const [wx, wy] = snapped
        ? [snapped.x, snapped.y]
        : clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);

      mapPressurePoints.push({ x: wx, y: wy });
      const cnt = mapPressurePoints.length;
      const hint = document.getElementById("map-pressure-hint");
      const doneBtn = document.getElementById("map-pressure-done");
      if (hint) hint.textContent = `${cnt}번째 노드 추가됨 (${wx.toFixed(2)}, ${wy.toFixed(2)}) — 계속 클릭하거나 완료를 누르세요.`;
      if (doneBtn) doneBtn.style.display = cnt >= 2 ? "" : "none";
      redrawMapDxfPreview();
      return;
    }

    if (mapCanvasMode === "slip") {
      const h = hitTestSlipHandle(canvas, e.clientX, e.clientY);
      if (h) {
        e.preventDefault();
        const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
        if (!row) return;
        const slip = getEffectiveSlipPts(row);
        if (!slip) return;
        const ptMap = {
          ll: slip.leftSideLeftPt   ?? slip.ll,
          lr: slip.leftSideRightPt  ?? slip.lr,
          rl: slip.rightSideLeftPt  ?? slip.rl,
          rr: slip.rightSideRightPt ?? slip.rr,
        };
        const orig = ptMap[h];
        mapSlipDragHandle = { handle: h, origX: Number(orig?.x ?? 0), origY: Number(orig?.y ?? 0) };
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        canvas.style.cursor = "grabbing";
      }
    }

    if (mapCanvasMode === "grid") {
      const frame = mapLastDrawFrame;
      if (!frame) return;
      if (mapGridDrawZone) {
        // 그리기 모드: 첫 클릭 → 앵커 설정
        e.preventDefault();
        const [wx, wy] = clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);
        mapGridDrawAnchor = { x: wx, y: wy };
        mapMouseWorldXY = [wx, wy];
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        canvas.style.cursor = "crosshair";
        return;
      }
      const h = hitTestGridHandle(canvas, e.clientX, e.clientY);
      if (h) {
        e.preventDefault();
        mapGridDragHandle = h;
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
        canvas.style.cursor = "grabbing";
      }
    }
  });

  // pointermove → 슬립 핸들 드래그
  canvas.addEventListener("pointermove", (e) => {
    if (mapSlipDragHandle) {
      const frame = mapLastDrawFrame;
      if (!frame) return;
      const [wx, wyRaw] = clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);
      // Y를 지형 표면(DXF 리즌 경계 최대 Y)에 스냅
      const wy = getTerrainSurfaceY(wx) ?? wyRaw;

      const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
      if (!row) return;
      initRowExtras(row);

      const base = getEffectiveSlipPts(row) ?? {};
      if (!row.slipPts) {
        row.slipPts = {
          leftSideLeftPt:   { x: Number(base.leftSideLeftPt?.x   ?? base.ll?.x ?? 0), y: Number(base.leftSideLeftPt?.y   ?? base.ll?.y ?? 0) },
          leftSideRightPt:  { x: Number(base.leftSideRightPt?.x  ?? base.lr?.x ?? 0), y: Number(base.leftSideRightPt?.y  ?? base.lr?.y ?? 0) },
          rightSideLeftPt:  { x: Number(base.rightSideLeftPt?.x  ?? base.rl?.x ?? 0), y: Number(base.rightSideLeftPt?.y  ?? base.rl?.y ?? 0) },
          rightSideRightPt: { x: Number(base.rightSideRightPt?.x ?? base.rr?.x ?? 0), y: Number(base.rightSideRightPt?.y ?? base.rr?.y ?? 0) },
          leftInc:   base.leftInc   ?? 20,
          rightInc:  base.rightInc  ?? 20,
          radiusInc: base.radiusInc ?? 20,
        };
      }
      const keyMap = {
        ll: "leftSideLeftPt",
        lr: "leftSideRightPt",
        rl: "rightSideLeftPt",
        rr: "rightSideRightPt",
      };
      const ptKey = keyMap[mapSlipDragHandle.handle];
      if (ptKey) row.slipPts[ptKey] = { x: wx, y: wy };
      syncSlipPanelFromRow();
      redrawMapDxfPreview();
    }

    if (mapGridDrawAnchor) {
      // 사각형 그리기 중 — 현재 커서 위치로 프리뷰 갱신
      const frame = mapLastDrawFrame;
      if (!frame) return;
      const [wx, wy] = clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);
      mapMouseWorldXY = [wx, wy];
      redrawMapDxfPreview();
      return;
    }

    if (mapGridDragHandle) {
      const frame = mapLastDrawFrame;
      if (!frame) return;
      const [wx, wy] = clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);

      const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
      if (!row) return;
      initRowExtras(row);
      if (!row.gridData) row.gridData = {
        grid:   { ul: null, ll: null, lr: null, ur: null, numXInc: 10, numYInc: 10 },
        radius: { ul: null, ll: null, lr: null, ur: null, numInc: 20 },
      };
      row.gridData[mapGridDragHandle.zone][mapGridDragHandle.corner] = { x: wx, y: wy };
      syncGridPanelFromRow();
      redrawMapDxfPreview();
    }
  });

  // pointerup → 드래그 종료
  canvas.addEventListener("pointerup", (e) => {
    if (mapGridDrawAnchor) {
      const frame = mapLastDrawFrame;
      if (frame) {
        const [wx, wy] = clientToWorldWithView(canvas, e.clientX, e.clientY, frame, mapDxfCanvasView);
        const r = rectFromAnchorCurrent(mapGridDrawAnchor.x, mapGridDrawAnchor.y, wx, wy);
        const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
        if (row && mapGridDrawZone) {
          initRowExtras(row);
          if (!row.gridData) row.gridData = {
            grid:   { ul: null, ll: null, lr: null, ur: null, numXInc: 10, numYInc: 10 },
            radius: { ul: null, ll: null, lr: null, ur: null, numInc: 20 },
          };
          row.gridData[mapGridDrawZone].ul = r.ul;
          row.gridData[mapGridDrawZone].ll = r.ll;
          row.gridData[mapGridDrawZone].lr = r.lr;
          row.gridData[mapGridDrawZone].ur = r.ur;
          syncGridPanelFromRow();
        }
      }
      mapGridDrawAnchor = null;
      mapMouseWorldXY = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      canvas.style.cursor = mapGridDrawZone ? "crosshair" : "default";
      redrawMapDxfPreview();
      return;
    }

    if (mapSlipDragHandle) {
      mapSlipDragHandle = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      canvas.style.cursor = mapCanvasMode === "slip" ? "default" : "";
      flushSlipPanelToRow();
      redrawMapDxfPreview();
    }
    if (mapGridDragHandle) {
      mapGridDragHandle = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      canvas.style.cursor = mapCanvasMode === "grid" ? "default" : "";
      flushGridPanelToRow();
      redrawMapDxfPreview();
    }
  });

  canvas.addEventListener("pointercancel", () => {
    mapSlipDragHandle = null;
    mapGridDragHandle = null;
    mapGridDrawAnchor = null;
    mapMouseWorldXY = null;
  });
}

function bindMapDxfCanvasInteractions() {
  const canvas = document.getElementById("map-dxf-canvas");
  if (!canvas || canvas.dataset.mapInteractBound === "1") return;
  canvas.dataset.mapInteractBound = "1";
  const regions = () => mapRegionPreviewCache?.regions || [];

  canvas.addEventListener("dragover", (e) => {
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = "copy";
    } catch (_) {
      /* ignore */
    }
  });
  canvas.addEventListener("dragenter", () => {
    canvas.classList.add("map-canvas-drop-hover");
  });
  canvas.addEventListener("dragleave", (e) => {
    if (!canvas.contains(e.relatedTarget)) {
      canvas.classList.remove("map-canvas-drop-hover");
    }
  });
  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    canvas.classList.remove("map-canvas-drop-hover");
    const raw = (e.dataTransfer?.getData("text/plain") || "").trim();
    const mid = parseInt(raw, 10);
    if (!Number.isFinite(mid) || mid === 0) return;
    const regId = findRegionIdAtCanvasClient(
      canvas,
      regions(),
      mapWaterPoints,
      e.clientX,
      e.clientY,
      mapDxfCanvasView,
    );
    if (regId == null) {
      toast("할당할 Region(닫힌 폴리곤)을 찾지 못했습니다.", false);
      return;
    }
    assignMaterialToRegion(regId, mid);
    const name = (mapMaterialNameById.get(String(mid)) || "").trim();
    toast(`Region R${regId} → Material ${mid}${name ? ` (${name})` : ""}`);
  });
  canvas.addEventListener("click", (e) => {
    if (mapCanvasSuppressNextClick) {
      mapCanvasSuppressNextClick = false;
      return;
    }
    // 상재하중·슬립 모드는 pointerdown에서 처리, 여기서는 차단
    if (mapCanvasMode !== "paint") return;
    if (!mapPaintMaterialId) return;
    const mid = parseInt(mapPaintMaterialId, 10);
    if (!Number.isFinite(mid) || mid === 0) return;
    const regId = findRegionIdAtCanvasClient(
      canvas,
      regions(),
      mapWaterPoints,
      e.clientX,
      e.clientY,
      mapDxfCanvasView,
    );
    if (regId == null) {
      toast("도면에서 Region(폴리곤) 내부를 클릭하세요.", false);
      return;
    }
    assignMaterialToRegion(regId, mid);
    const name = (mapMaterialNameById.get(String(mid)) || "").trim();
    toast(`Region R${regId} → Material ${mid}${name ? ` (${name})` : ""}`);
  });
}

async function runScanLayers() {
  const fileEl = document.getElementById("map-dxf");
  const logEl = document.getElementById("map-log");
  if (!fileEl.files || !fileEl.files[0]) {
    toast("DXF 파일을 선택하세요.", false);
    return;
  }
  try {
    await performDxfScan(fileEl.files[0], logEl);
    toast("레이어 스캔 완료");
  } catch (e) {
    mapDxfLayersCache = null;
    mapRegionPreviewCache = null;
    resetMapPreviewView(mapDxfCanvasView);
    if (logEl) logEl.textContent += `❌ ${e.message}\n`;
    toast(e.message, false);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function renderMapMaterialRefPlaceholder() {
  const tbody = document.getElementById("map-mat-ref-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const tr = document.createElement("tr");
  tr.innerHTML =
    '<td colspan="3" style="color:var(--muted);text-align:center;padding:10px">템플릿 GSZ 파일을 선택하면 표시됩니다.</td>';
  tbody.appendChild(tr);
  setMapPaintMaterialId(null);
}

function renderMapMaterialRef(materials) {
  const tbody = document.getElementById("map-mat-ref-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!materials.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="3" style="color:var(--muted);text-align:center;padding:10px">&lt;Materials&gt;에 재료가 없습니다.</td>';
    tbody.appendChild(tr);
    setMapPaintMaterialId(null);
    return;
  }
  const sorted = [...materials].sort(
    (a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0),
  );
  const skipClickRef = { v: false };
  for (const m of sorted) {
    const tr = document.createElement("tr");
    tr.className = "map-mat-ref-tr";
    tr.draggable = true;
    tr.dataset.materialId = String(m.id);
    tr.title =
      "재료 행을 미리보기 도면으로 끌어놓거나, 클릭한 뒤 도면에서 클릭해 Region에 할당합니다.";

    tr.addEventListener("dragstart", (ev) => {
      skipClickRef.v = true;
      ev.dataTransfer.setData("text/plain", String(m.id));
      ev.dataTransfer.effectAllowed = "copy";
    });
    tr.addEventListener("dragend", () => {
      setTimeout(() => {
        skipClickRef.v = false;
      }, 0);
    });
    tr.addEventListener("click", () => {
      if (skipClickRef.v) return;
      setMapPaintMaterialId(String(m.id));
    });

    const tdId = document.createElement("td");
    tdId.className = "map-cell-id";
    tdId.textContent = String(m.id);

    const tdName = document.createElement("td");
    tdName.className = "map-cell-text";
    tdName.style.maxWidth = "260px";
    tdName.textContent = m.name || "(이름 없음)";

    const tdModel = document.createElement("td");
    tdModel.className = "map-cell-model";
    tdModel.textContent = m.model || "—";

    tr.appendChild(tdId);
    tr.appendChild(tdName);
    tr.appendChild(tdModel);
    tbody.appendChild(tr);
  }
  syncMapMatRefPaintHighlight();
}

async function refreshMapTemplateMaterials() {
  const gszEl = document.getElementById("map-template");
  const tbody = document.getElementById("map-mat-ref-tbody");
  if (!gszEl || !tbody) return;
  if (!gszEl.files || !gszEl.files[0]) {
    renderMapMaterialRefPlaceholder();
    mapMaterialRgbById = new Map();
    mapMaterialNameById = new Map();
    mapWaterPoints = [];
    renderWaterTable();
    resetMapAnalysesToDefault();
    renderMapAnalysisRows();
    refillMapRegionTbodyFromCache();
    redrawMapDxfPreview();
    return;
  }
  tbody.innerHTML = "";
  const loading = document.createElement("tr");
  loading.innerHTML =
    '<td colspan="3" style="color:var(--muted);text-align:center;padding:10px">GSZ에서 재료 목록 읽는 중…</td>';
  tbody.appendChild(loading);
  try {
    const buf = await gszEl.files[0].arrayBuffer();
    const { doc } = await loadGszFromArrayBuffer(buf);
    const list = listMaterialsFromDocument(doc);
    mapMaterialRgbById = materialRgbMapFromMaterialsList(list);
    mapMaterialNameById = materialNameMapFromMaterialsList(list);
    renderMapMaterialRef(list);
    initAnalysesFromTemplateDoc(doc);
    mapWaterPoints = readWaterDataPointsFromDocument(doc);
    renderWaterTable();
    renderMapAnalysisRows();
    refillMapRegionTbodyFromCache();
    redrawMapDxfPreview();
  } catch (e) {
    mapMaterialRgbById = new Map();
    mapMaterialNameById = new Map();
    mapWaterPoints = [];
    renderWaterTable();
    resetMapAnalysesToDefault();
    renderMapAnalysisRows();
    refillMapRegionTbodyFromCache();
    setMapPaintMaterialId(null);
    tbody.innerHTML = "";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="map-cell-error">${escapeHtml(e.message || String(e))}</td>`;
    tbody.appendChild(tr);
    redrawMapDxfPreview();
  }
}

async function runMapping() {
  const gszEl = document.getElementById("map-template");
  const dxfEl = document.getElementById("map-dxf");
  const logEl = document.getElementById("map-log");

  if (!gszEl.files || !gszEl.files[0]) {
    toast("템플릿 GSZ를 선택하세요.", false);
    return;
  }
  if (!dxfEl.files || !dxfEl.files[0]) {
    toast("DXF를 선택하세요.", false);
    return;
  }

  let outName = document.getElementById("map-out-name").value.trim();
  if (!outName) outName = "output_mapped.gsz";
  if (!outName.toLowerCase().endsWith(".gsz")) outName += ".gsz";

  flushActiveAnalysisRegionsFromTable();
  syncWaterPointsFromTable();

  logEl.textContent = `▶ 시작 (${mapAnalysesState.rows.length}개 해석 · 지오메트리 공통)...\n`;
  setProgress("map-progress", 12);

  try {
    const gszBuf = await gszEl.files[0].arrayBuffer();
    const { zip, xmlName, doc } = await loadGszFromArrayBuffer(gszBuf);
    const dxfText = await dxfEl.files[0].text();
    setProgress("map-progress", 28);
    const parsed = await parseDxfText(dxfText);
    const dxfLayers = readLayersFromDxfParsed(parsed);
    const lines = [logEl.textContent.trimEnd()];
    const log = (m) => {
      lines.push(m);
      logEl.textContent = lines.join("\n") + "\n";
    };

    const geometryLayers = new Set(
      Object.keys(dxfLayers).filter((l) => l !== WATER_TABLE_LAYER_NAME),
    );
    const dummyLayerMap = {};
    for (const L of geometryLayers) dummyLayerMap[L] = 1;

    let anyAssigned = false;
    for (const row of mapAnalysesState.rows) {
      for (const mid of Object.values(row.regionMaterials || {})) {
        if (mid != null && Number.isFinite(mid) && mid !== 0) {
          anyAssigned = true;
          break;
        }
      }
      if (anyAssigned) break;
    }
    if (!anyAssigned) {
      toast(
        "최소 한 해석에서 유효한 Material ID가 지정된 Region이 필요합니다.",
        false,
      );
      setProgress("map-progress", 0);
      return;
    }

    setProgress("map-progress", 42);
    for (const row of mapAnalysesState.rows) {
      ensureAnalysisExists(doc, row.id, row.title, log);
    }

    setProgress("map-progress", 52);
    const primaryId = mapAnalysesState.rows[0].id;
    const geoResult = applyRegionMappingToDocument(
      doc,
      dxfLayers,
      dummyLayerMap,
      primaryId,
      log,
      { geometryLayers, deferMaterialSync: true },
    );
    if (
      typeof geoResult !== "object" ||
      geoResult == null ||
      !geoResult.layerRegionIds
    ) {
      throw new Error("지오메트리 빌드 결과가 없습니다.");
    }

    // ── 슬립 진입/출구 (해석별 적용) ──
    const slipComputed = computeSlipEntryExitFromDxf(dxfLayers, geometryLayers);
    const slopeItemsEl = findFirstTag(doc, "SlopeItems");
    if (slopeItemsEl) {
      for (const row of mapAnalysesState.rows) {
        initRowExtras(row);
        const slipData = row.slipPts ?? slipComputed;
        // 해당 SlopeItem 찾기
        let targetSi = null;
        for (const si of allChildEl(slopeItemsEl, "SlopeItem")) {
          const aidEl = firstChildEl(si, "AnalysisID");
          if (aidEl && String(aidEl.textContent?.trim()) === String(row.id)) { targetSi = si; break; }
        }
        if (targetSi && slipData) {
          // 단일 SlopeItem에 SlipEntryExit 적용 (slip-entry-exit.js 패턴)
          let entry = firstChildEl(targetSi, "Entry");
          if (!entry) { entry = doc.createElement("Entry"); targetSi.appendChild(entry); }
          let seeEl = firstChildEl(entry, "SlipEntryExit");
          if (!seeEl) {
            seeEl = doc.createElement("SlipEntryExit");
            const grid = firstChildEl(entry, "SlipSurfaceGrid");
            const dp = firstChildEl(entry, "DataPoints");
            if (grid?.nextSibling) entry.insertBefore(seeEl, grid.nextSibling);
            else if (dp?.nextSibling) entry.insertBefore(seeEl, dp.nextSibling);
            else entry.appendChild(seeEl);
          }
          const removeChildren = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
          removeChildren(seeEl);
          const fmt = (v) => { const n = Number(v); if (!Number.isFinite(n)) return "0"; let s = n.toFixed(8).replace(/\.?0+$/, "").replace(/\.$/, ""); return s || "0"; };
          const setPt = (tag, x, y) => { const el = doc.createElement(tag); el.setAttribute("X", fmt(x)); el.setAttribute("Y", fmt(y)); seeEl.appendChild(el); };
          const setT  = (tag, v)    => { const el = doc.createElement(tag); el.textContent = fmt(v); seeEl.appendChild(el); };
          const ll = slipData.leftSideLeftPt  ?? slipData.ll  ?? { x: 0, y: 0 };
          const lr = slipData.leftSideRightPt ?? slipData.lr  ?? { x: 0, y: 0 };
          const rl = slipData.rightSideLeftPt ?? slipData.rl  ?? { x: 0, y: 0 };
          const rr = slipData.rightSideRightPt?? slipData.rr  ?? { x: 0, y: 0 };
          setPt("LeftSideLeftPt",   ll.x, ll.y);
          setPt("LeftSideRightPt",  lr.x, lr.y);
          setT("LeftInc",  slipData.leftInc  ?? 20);
          setPt("RightSideLeftPt",  rl.x, rl.y);
          setPt("RightSideRightPt", rr.x, rr.y);
          setT("RightInc", slipData.rightInc ?? 20);
          setT("RadiusInc",slipData.radiusInc?? 20);
          log(`  SlipEntryExit → Analysis ${row.id}${row.slipPts ? " (사용자 지정)" : " (DXF 자동)"}`);
        } else if (targetSi && !slipData) {
          applySlipEntryExitToAllSlopeItems(doc, slipComputed, log);
        }
      }
    } else {
      applySlipEntryExitToAllSlopeItems(doc, slipComputed, log);
    }

    setProgress("map-progress", 72);
    let totalRum = 0;
    for (const row of mapAnalysesState.rows) {
      initRowExtras(row);
      const n = syncMaterialsForAnalysisFromRegions(
        doc,
        row.regionMaterials,
        row.id,
        log,
      );
      totalRum += n;

      // ── 수평지진계수 (Seismic) ──
      if (slopeItemsEl) {
        for (const si of allChildEl(slopeItemsEl, "SlopeItem")) {
          const aidEl = firstChildEl(si, "AnalysisID");
          if (!aidEl || String(aidEl.textContent?.trim()) !== String(row.id)) continue;
          const entry = firstChildEl(si, "Entry");
          if (!entry) break;
          let seismicEl = firstChildEl(entry, "Seismic");
          if (!seismicEl) {
            seismicEl = doc.createElement("Seismic");
            entry.insertBefore(seismicEl, entry.firstChild);
          }
          seismicEl.setAttribute("Horizontal", row.seismicH ?? "");
          seismicEl.setAttribute("Vertical", "");
          if (row.seismicH?.trim()) log(`  Seismic kh=${row.seismicH} → Analysis ${row.id}`);
          break;
        }
      }

      // ── 상재하중 (PressureLines) ──
      if (slopeItemsEl && row.pressureLines?.length) {
        for (const si of allChildEl(slopeItemsEl, "SlopeItem")) {
          const aidEl = firstChildEl(si, "AnalysisID");
          if (!aidEl || String(aidEl.textContent?.trim()) !== String(row.id)) continue;
          const entry = firstChildEl(si, "Entry");
          if (!entry) break;
          // Entry/DataPoints에 새 좌표점 추가
          let dpRoot = firstChildEl(entry, "DataPoints");
          if (!dpRoot) { dpRoot = doc.createElement("DataPoints"); entry.insertBefore(dpRoot, entry.firstChild); }
          // 현재 최대 DataPoint Number 파악
          let maxNum = 0;
          for (const dp of allChildEl(dpRoot, "DataPoint")) {
            if (!dp.hasAttribute("X")) continue;
            const n = parseInt(dp.getAttribute("Number") ?? "0", 10);
            if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
          }
          const fmtC = (v) => { const n = Number(v); if (!Number.isFinite(n)) return "0"; let s = n.toFixed(8).replace(/\.?0+$/, "").replace(/\.$/, ""); return s || "0"; };
          // 기존 PressureLines 제거 후 재생성
          let plsEl = firstChildEl(entry, "PressureLines");
          if (plsEl) entry.removeChild(plsEl);
          plsEl = doc.createElement("PressureLines");
          plsEl.setAttribute("Len", String(row.pressureLines.length));
          let ptOffset = 0;
          row.pressureLines.forEach((pl, pi) => {
            // 구 형식 호환
            const pts = pl.points
              ? pl.points
              : [{ x: pl.x1, y: pl.y1 }, { x: pl.x2, y: pl.y2 }];
            const startNum = maxNum + 1 + ptOffset;
            // DataPoint 추가 (N개 노드)
            pts.forEach((pt, j) => {
              const dp = doc.createElement("DataPoint");
              dp.setAttribute("Number", String(startNum + j));
              dp.setAttribute("X", fmtC(pt.x));
              dp.setAttribute("Y", fmtC(pt.y));
              dpRoot.appendChild(dp);
            });
            ptOffset += pts.length;
            dpRoot.setAttribute("Len", String(allChildEl(dpRoot, "DataPoint").length));
            // PressureLine 요소
            const plEl = doc.createElement("PressureLine");
            const idEl = doc.createElement("ID"); idEl.textContent = String(pi + 1);
            const dpsEl = doc.createElement("DataPoints"); dpsEl.setAttribute("Len", String(pts.length));
            pts.forEach((_, j) => {
              const ref = doc.createElement("DataPoint"); ref.textContent = String(startNum + j);
              dpsEl.appendChild(ref);
            });
            const pEl = doc.createElement("Pressure"); pEl.textContent = String(pl.pressure);
            plEl.appendChild(idEl); plEl.appendChild(dpsEl); plEl.appendChild(pEl);
            plsEl.appendChild(plEl);
          });
          // SlipSurfaceLimit 앞에 삽입 (없으면 Entry 끝)
          const ssl = firstChildEl(entry, "SlipSurfaceLimit");
          if (ssl) entry.insertBefore(plsEl, ssl);
          else entry.appendChild(plsEl);
          log(`  PressureLines ${row.pressureLines.length}건 → Analysis ${row.id}`);
          break;
        }
      }

      // ── 격자 탐색 (SlipSurfaceGrid + SlipSurfaceRadius) ──
      if (slopeItemsEl && row.gridData) {
        const gd = row.gridData;
        const hasGrid = gd.grid && (gd.grid.ul || gd.grid.ll || gd.grid.lr);
        const hasRadius = gd.radius && (gd.radius.ul || gd.radius.ll || gd.radius.lr || gd.radius.ur);
        if (hasGrid || hasRadius) {
          for (const si of allChildEl(slopeItemsEl, "SlopeItem")) {
            const aidEl = firstChildEl(si, "AnalysisID");
            if (!aidEl || String(aidEl.textContent?.trim()) !== String(row.id)) continue;
            let entry = firstChildEl(si, "Entry");
            if (!entry) { entry = doc.createElement("Entry"); si.appendChild(entry); }

            let dpRoot = firstChildEl(entry, "DataPoints");
            if (!dpRoot) { dpRoot = doc.createElement("DataPoints"); entry.insertBefore(dpRoot, entry.firstChild); }
            let maxNum2 = 0;
            for (const dp of allChildEl(dpRoot, "DataPoint")) {
              if (!dp.hasAttribute("X")) continue;
              const dn = parseInt(dp.getAttribute("Number") ?? "0", 10);
              if (Number.isFinite(dn)) maxNum2 = Math.max(maxNum2, dn);
            }
            const fmtG = (v) => { const num = Number(v); if (!Number.isFinite(num)) return "0"; let s = num.toFixed(8).replace(/\.?0+$/, "").replace(/\.$/, ""); return s || "0"; };

            const addDp = (x, y) => {
              maxNum2++;
              const dp = doc.createElement("DataPoint");
              dp.setAttribute("Number", String(maxNum2));
              dp.setAttribute("X", fmtG(x));
              dp.setAttribute("Y", fmtG(y));
              dpRoot.appendChild(dp);
              dpRoot.setAttribute("Len", String(allChildEl(dpRoot, "DataPoint").length));
              return maxNum2;
            };

            // SlipSurfaceGrid 작성
            if (hasGrid) {
              const g = gd.grid;
              let gridEl = firstChildEl(entry, "SlipSurfaceGrid");
              if (!gridEl) { gridEl = doc.createElement("SlipSurfaceGrid"); }
              else { gridEl.parentNode.removeChild(gridEl); gridEl = doc.createElement("SlipSurfaceGrid"); }

              if (g.ul) gridEl.setAttribute("PointUL", String(addDp(g.ul.x, g.ul.y)));
              if (g.ll) gridEl.setAttribute("PointLL", String(addDp(g.ll.x, g.ll.y)));
              if (g.lr) gridEl.setAttribute("PointLR", String(addDp(g.lr.x, g.lr.y)));
              if (g.ur) gridEl.setAttribute("PointUR", String(addDp(g.ur.x, g.ur.y)));
              gridEl.setAttribute("NumXInc", String(g.numXInc ?? 10));
              gridEl.setAttribute("NumYInc", String(g.numYInc ?? 10));
              gridEl.setAttribute("ArrowCorner", "LowerLeft");

              const seeEl = firstChildEl(entry, "SlipEntryExit");
              const dpEl  = firstChildEl(entry, "DataPoints");
              if (seeEl) entry.insertBefore(gridEl, seeEl);
              else if (dpEl?.nextSibling) entry.insertBefore(gridEl, dpEl.nextSibling);
              else entry.appendChild(gridEl);
              log(`  SlipSurfaceGrid → Analysis ${row.id} (${g.numXInc ?? 10}×${g.numYInc ?? 10})`);
            }

            // SlipSurfaceRadius 작성
            if (hasRadius) {
              const r = gd.radius;
              let radEl = firstChildEl(entry, "SlipSurfaceRadius");
              if (!radEl) { radEl = doc.createElement("SlipSurfaceRadius"); }
              else { radEl.parentNode.removeChild(radEl); radEl = doc.createElement("SlipSurfaceRadius"); }

              const ulN = r.ul ? addDp(r.ul.x, r.ul.y) : null;
              const llN = r.ll ? addDp(r.ll.x, r.ll.y) : null;
              const lrN = r.lr ? addDp(r.lr.x, r.lr.y) : null;
              const urN = r.ur ? addDp(r.ur.x, r.ur.y) : null;
              if (ulN) radEl.setAttribute("PointUL", String(ulN));
              if (urN) radEl.setAttribute("PointUR", String(urN));
              if (llN) radEl.setAttribute("PointLL", String(llN));
              if (lrN) radEl.setAttribute("PointLR", String(lrN));
              radEl.setAttribute("NumInc", String(r.numInc ?? 20));
              if (ulN) radEl.setAttribute("PointLeftCorner", String(ulN));
              if (urN) radEl.setAttribute("PointRightCorner", String(urN));
              radEl.setAttribute("UsePoints", "1");

              const seeEl2 = firstChildEl(entry, "SlipEntryExit");
              const gridEl2 = firstChildEl(entry, "SlipSurfaceGrid");
              const sslEl = firstChildEl(entry, "SlipSurfaceLimit");
              if (sslEl) entry.insertBefore(radEl, sslEl);
              else if (seeEl2?.nextSibling) entry.insertBefore(radEl, seeEl2.nextSibling);
              else if (gridEl2?.nextSibling) entry.insertBefore(radEl, gridEl2.nextSibling);
              else entry.appendChild(radEl);
              log(`  SlipSurfaceRadius → Analysis ${row.id} (NumInc=${r.numInc ?? 20})`);
            }
            break;
          }
        }
      }

      log(`  └ Analysis ID=${row.id} 「${row.title}」 RegionUsesMaterials ${n}건`);
    }

    syncWaterPointsFromTable();
    applyWaterDataPointsToAllSlopeItems(doc, mapWaterPoints, log);

    setProgress("map-progress", 88);
    zip.file(xmlName, serializeXmlDocument(doc));
    const blob = await zipToBlob(zip);
    downloadBlob(blob, outName);
    setProgress("map-progress", 100);
    log(
      `✓ 완료 → ${outName} (해석 ${mapAnalysesState.rows.length}개 · RegionUsesMaterial 합계 ${totalRum}건)`,
    );
    logEl.textContent = lines.join("\n") + "\n";
    toast("Region 매핑 완료 · 다운로드 폴더를 확인하세요.");
  } catch (e) {
    setProgress("map-progress", 0);
    logEl.textContent += `\n❌ ${e.message}\n`;
    toast(e.message, false);
  }
}

const THEME_STORAGE_KEY = "slope-web-theme";

function getPreferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch (_) {
    /* ignore */
  }
  return "dark";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const label = document.getElementById("theme-toggle-label");
  if (label) label.textContent = theme === "dark" ? "라이트" : "다크";
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (_) {
    /* ignore */
  }
  redrawMapDxfPreview();
}

function setupTheme() {
  applyTheme(getPreferredTheme());
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const current =
      document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
  });
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`panel-${tab}`).classList.add("active");
      if (tab === "mapping") {
        requestAnimationFrame(() => redrawMapDxfPreview());
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupTheme();
  setupTabs();
  setupMapPreviewResize();
  bindWaterTableUI();
  ensureMapTbodyPreviewBound();
  renderWaterTable();
  renderMapMaterialRefPlaceholder();
  redrawMapDxfPreview();
  bindMapCanvasZoomPan();
  wireMapCanvasZoomButtons();
  bindMapDxfCanvasInteractions();
  document
    .getElementById("map-template")
    .addEventListener("change", refreshMapTemplateMaterials);
  document.getElementById("map-dxf").addEventListener("change", async (e) => {
    mapDxfLayersCache = null;
    mapRegionPreviewCache = null;
    resetMapPreviewView(mapDxfCanvasView);
    for (const row of mapAnalysesState.rows) row.regionMaterials = {};
    const tb = document.getElementById("map-tbody");
    if (tb) tb.innerHTML = "";
    redrawMapDxfPreview();
    const f = e.target.files?.[0];
    if (!f) return;
    const logEl = document.getElementById("map-log");
    try {
      if (logEl) logEl.textContent = "";
      await performDxfScan(f, logEl);
      toast("DXF 스캔 완료 (파일 선택 시 자동)");
    } catch (err) {
      mapDxfLayersCache = null;
      mapRegionPreviewCache = null;
      resetMapPreviewView(mapDxfCanvasView);
      if (logEl) logEl.textContent += `❌ ${err.message}\n`;
      toast(err.message, false);
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const panel = document.getElementById("panel-mapping");
    if (!panel || !panel.classList.contains("active")) return;
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      ae?.isContentEditable
    ) {
      return;
    }
    if (!mapPaintMaterialId) return;
    setMapPaintMaterialId(null);
  });
  bindMapAnalysisTable();
  renderMapAnalysisRows();
  document.getElementById("map-analysis-add").addEventListener("click", () => {
    flushActiveAnalysisRegionsFromTable();
    const maxId = Math.max(0, ...mapAnalysesState.rows.map((r) => r.id));
    const newId = maxId + 1;
    const regionMaterials = {};
    if (mapRegionPreviewCache?.regions) {
      for (const { regId, layer } of mapRegionPreviewCache.regions) {
        const def = DEFAULT_LAYER_MAP[layer];
        regionMaterials[String(regId)] =
          def != null && Number.isFinite(def) ? def : null;
      }
    }
    const newRow = {
      id: newId,
      title: `해석 ${newId}`,
      regionMaterials,
    };
    initRowExtras(newRow);
    mapAnalysesState.rows.push(newRow);
    mapAnalysesState.activeIndex = mapAnalysesState.rows.length - 1;
    renderMapAnalysisRows();
    refillMapRegionTbodyFromCache();
    redrawMapDxfPreview();
  });
  document.getElementById("map-analysis-clone").addEventListener("click", () => {
    flushActiveAnalysisRegionsFromTable();
    const sourceRow = mapAnalysesState.rows[mapAnalysesState.activeIndex];
    if (!sourceRow) return;
    initRowExtras(sourceRow);
    const maxId = Math.max(0, ...mapAnalysesState.rows.map((r) => r.id));
    const newId = maxId + 1;
    const newRow = {
      id: newId,
      title: `${sourceRow.title} (복제)`,
      regionMaterials: { ...sourceRow.regionMaterials },
      seismicH: sourceRow.seismicH,
      pressureLines: sourceRow.pressureLines.map(pl => ({ ...pl })),
      slipPts: sourceRow.slipPts ? { ...sourceRow.slipPts } : null,
    };
    mapAnalysesState.rows.push(newRow);
    mapAnalysesState.activeIndex = mapAnalysesState.rows.length - 1;
    renderMapAnalysisRows();
    refillMapRegionTbodyFromCache();
    redrawMapDxfPreview();
    toast(`「${sourceRow.title}」 → ID ${newId}으로 복제되었습니다.`);
  });
  initGszEditor();
  initResultViewer();
  initDxfGeoStudioTab();
  initMaterialsTable();
  const matBody = document.getElementById("mat-tbody");
  let matAnchorTr = null;
  matBody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr || !matBody.contains(tr)) return;
    if (e.shiftKey && matAnchorTr && matBody.contains(matAnchorTr)) {
      const rows = [...matBody.querySelectorAll("tr")];
      const aIdx = rows.indexOf(matAnchorTr);
      const bIdx = rows.indexOf(tr);
      const lo = Math.min(aIdx, bIdx), hi = Math.max(aIdx, bIdx);
      rows.forEach((r, i) => {
        if (i >= lo && i <= hi) r.setAttribute("data-selected", "1");
        else if (!e.ctrlKey && !e.metaKey) r.removeAttribute("data-selected");
      });
    } else if (e.ctrlKey || e.metaKey) {
      if (tr.hasAttribute("data-selected")) tr.removeAttribute("data-selected");
      else tr.setAttribute("data-selected", "1");
      matAnchorTr = tr;
    } else {
      matBody.querySelectorAll("tr").forEach((r) => r.removeAttribute("data-selected"));
      tr.setAttribute("data-selected", "1");
      matAnchorTr = tr;
    }
  });
  // 물성치 테이블 키보드 탐색 (↑↓ 행 이동, Enter 다음 행, Tab 칸 순환)
  installTableArrowNav(matBody, { onEnterLastRow: matAddRow });
  // Region 매핑 테이블 키보드 탐색
  const mapTbody = document.getElementById("map-tbody");
  if (mapTbody) installTableArrowNav(mapTbody);
  // input[type=number] 마우스 휠 차단 (편심 지지력 탭 등)
  installWheelBlockOnNumberInputs();

  document.getElementById("mat-add-row").addEventListener("click", matAddRow);
  document.getElementById("mat-del-row").addEventListener("click", matDelSelectedRow);
  document.getElementById("mat-copy")?.addEventListener("click", () => {
    const table = document.getElementById("mat-table");
    if (!table) return;
    const rows = [];
    // 헤더
    const ths = table.querySelectorAll("thead th");
    rows.push([...ths].map(th => th.innerText.replace(/\n/g, " ").trim()).join("\t"));
    // 데이터행
    table.querySelectorAll("tbody tr").forEach(tr => {
      const cells = [...tr.querySelectorAll("td")].map(td => {
        const sel = td.querySelector("select");
        if (sel) return sel.value;
        // 색상 셀: color-cell 안의 text input
        const colorInp = td.querySelector(".color-cell input[type='text']");
        if (colorInp) return colorInp.value;
        const inp = td.querySelector("input");
        if (inp) return inp.value;
        return td.textContent.trim();
      });
      rows.push(cells.join("\t"));
    });
    navigator.clipboard.writeText(rows.join("\n")).then(() => toast("물성치 데이터가 복사되었습니다."), () => toast("복사 실패 — 클립보드 권한을 확인하세요.", false));
  });
  document.getElementById("mat-run").addEventListener("click", runMaterials);
  document.getElementById("mat-json-export")?.addEventListener("click", () => {
    const mats = collectMaterials();
    if (!mats.length) { toast("내보낼 재료(ID가 있는 행)가 없습니다.", false); return; }
    const json = JSON.stringify({ version: 1, materials: mats }, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "materials.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  document.getElementById("mat-json-import")?.addEventListener("click", () => {
    document.getElementById("mat-json-import-file").click();
  });
  document.getElementById("mat-json-import-file")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const mats = parsed?.materials;
        if (!Array.isArray(mats) || !mats.length) {
          toast("유효한 물성치 JSON이 아닙니다.", false);
          return;
        }
        const tbody = document.getElementById("mat-tbody");
        const existingCount = tbody.querySelectorAll("tr").length;
        const hasData = existingCount > 0 && [...tbody.querySelectorAll("tr")].some((r) => {
          const nameInp = r.querySelector('td[data-col="1"] input');
          return nameInp && nameInp.value.trim();
        });
        const append = hasData && window.confirm(
          `기존 물성치 ${existingCount}개가 있습니다.\n\n[확인]  기존 목록에 추가\n[취소]  기존 목록 덮어쓰기`
        );
        if (!append) tbody.innerHTML = "";
        mats.forEach((m) => {
          const tr = createMatRow({
            id:         m.id   != null ? String(m.id) : "",
            name:       m.name ?? "",
            model:      m.model ?? "MohrCoulomb",
            uw:         m.uw         != null ? String(m.uw)         : "",
            dw:         m.dw         != null ? String(m.dw)         : "",
            c:          m.c          != null ? String(m.c)          : "",
            phi:        m.phi        != null ? String(m.phi)        : "",
            c_top:      m.c_top      != null ? String(m.c_top)      : "",
            c_rate:     m.c_rate     != null ? String(m.c_rate)     : "",
            c_datum:    m.c_datum    != null ? String(m.c_datum)    : "",
            datum_elev: m.datum_elev != null ? String(m.datum_elev) : "",
            color:      m.color ?? "",
          });
          tbody.appendChild(tr);
          applyRowEditPolicy(tr);
        });
        renumberMatRows();
        toast(`${mats.length}개 물성치를 ${append ? "추가" : "가져"}왔습니다.`);
      } catch (err) {
        toast(`JSON 파싱 오류: ${err.message}`, false);
      }
      e.target.value = "";   // 동일 파일 재선택 가능하도록 초기화
    };
    reader.readAsText(file);
  });
  // ─── 그리기 모드 버튼 ────────────────────────────────────────
  document.getElementById("map-tool-paint")?.addEventListener("click", () => switchMapCanvasMode("paint"));
  document.getElementById("map-tool-pressure")?.addEventListener("click", () => switchMapCanvasMode("pressure"));
  document.getElementById("map-tool-slip")?.addEventListener("click", () => switchMapCanvasMode("slip"));
  document.getElementById("map-tool-grid")?.addEventListener("click", () => switchMapCanvasMode("grid"));

  // ─── 레이어 가시성 토글 ───────────────────────────────────────
  ["materials", "pressure", "slip", "nodes", "grid"].forEach((key) => {
    const btn = document.getElementById(`map-layer-${key}`);
    if (!btn) return;
    btn.addEventListener("click", () => {
      mapLayerVisible[key] = !mapLayerVisible[key];
      btn.classList.toggle("map-layer-btn-off", !mapLayerVisible[key]);
      btn.title = mapLayerVisible[key] ? `${btn.dataset.label} 숨기기` : `${btn.dataset.label} 표시`;
      redrawMapDxfPreview();
      drawMapOverlayOnCanvas();
    });
  });

  // ─── 상재하중 패널 확인/취소 ─────────────────────────────────
  document.getElementById("map-pressure-done")?.addEventListener("click", () => {
    if (mapPressurePoints.length < 2) return;
    const form = document.getElementById("map-pressure-form");
    const hint = document.getElementById("map-pressure-hint");
    const doneBtn = document.getElementById("map-pressure-done");
    if (form) form.style.display = "";
    if (hint) hint.style.display = "none";
    if (doneBtn) doneBtn.style.display = "none";
    const kpaInp = document.getElementById("map-pressure-kpa");
    if (kpaInp) { kpaInp.value = ""; kpaInp.focus(); }
  });
  document.getElementById("map-pressure-ok")?.addEventListener("click", () => {
    const kpaInp = document.getElementById("map-pressure-kpa");
    const val = parseFloat(kpaInp?.value ?? "");
    if (!Number.isFinite(val) || val <= 0) { toast("유효한 압력값(kPa > 0)을 입력하세요.", false); return; }
    if (mapPressurePoints.length < 2) return;
    const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
    if (!row) return;
    initRowExtras(row);
    const nPts = mapPressurePoints.length;
    row.pressureLines.push({
      id: String(row.pressureLines.length + 1),
      points: mapPressurePoints.map(p => ({ ...p })),
      pressure: String(val),
    });
    mapPressurePoints = [];
    const form = document.getElementById("map-pressure-form");
    const hint = document.getElementById("map-pressure-hint");
    if (form) form.style.display = "none";
    if (hint) { hint.textContent = "캔버스에서 첫 번째 점을 클릭하세요."; hint.style.display = ""; }
    renderPressureListPanel();
    redrawMapDxfPreview();
    toast(`상재하중 ${val} kPa 추가됨 (${nPts}개 노드)`);
  });
  document.getElementById("map-pressure-kpa")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("map-pressure-ok")?.click();
  });
  document.getElementById("map-pressure-cancel")?.addEventListener("click", () => {
    mapPressurePoints = [];
    mapMouseWorldXY = null;
    mapSnapNode = null;
    const form = document.getElementById("map-pressure-form");
    const hint = document.getElementById("map-pressure-hint");
    const doneBtn = document.getElementById("map-pressure-done");
    if (form) form.style.display = "none";
    if (hint) { hint.textContent = "캔버스에서 첫 번째 점을 클릭하세요."; hint.style.display = ""; }
    if (doneBtn) doneBtn.style.display = "none";
    redrawMapDxfPreview();
  });

  // ─── 슬립 패널 입력 동기화 ───────────────────────────────────
  ["map-slip-ll-x","map-slip-ll-y",
   "map-slip-lr-x","map-slip-lr-y",
   "map-slip-rl-x","map-slip-rl-y",
   "map-slip-rr-x","map-slip-rr-y",
   "map-slip-linc","map-slip-rinc","map-slip-radinc"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      flushSlipPanelToRow();
      redrawMapDxfPreview();
    });
  });
  document.getElementById("map-slip-auto")?.addEventListener("click", () => {
    const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
    if (row) { initRowExtras(row); row.slipPts = null; }
    syncSlipPanelFromRow();
    redrawMapDxfPreview();
    toast("슬립 진입/출구가 DXF 자동값으로 초기화됨");
  });

  // ─── 격자 탐색 패널 입력 동기화 ──────────────────────────────
  ["map-grid-ul-x","map-grid-ul-y","map-grid-ll-x","map-grid-ll-y",
   "map-grid-lr-x","map-grid-lr-y","map-grid-ur-x","map-grid-ur-y",
   "map-grid-xinc","map-grid-yinc",
   "map-rad-ul-x","map-rad-ul-y","map-rad-ll-x","map-rad-ll-y",
   "map-rad-lr-x","map-rad-lr-y","map-rad-ur-x","map-rad-ur-y",
   "map-rad-ninc"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
      flushGridPanelToRow();
      redrawMapDxfPreview();
    });
  });
  document.getElementById("map-grid-auto")?.addEventListener("click", () => {
    const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
    if (!row) return;
    autoInitGridDataFromDxf(row);
  });
  // 격자 그리기 존 토글 (Grid/Radius 그리기 버튼)
  function setGridDrawZone(zone) {
    mapGridDrawZone = mapGridDrawZone === zone ? null : zone;
    mapGridDrawAnchor = null;
    mapMouseWorldXY = null;
    ["map-grid-draw-grid", "map-grid-draw-radius"].forEach((id) => {
      document.getElementById(id)?.classList.remove("active");
    });
    if (mapGridDrawZone) {
      document.getElementById(`map-grid-draw-${mapGridDrawZone}`)?.classList.add("active");
    }
    const canvas = document.getElementById("map-dxf-canvas");
    if (canvas) {
      canvas.classList.toggle("map-canvas-grid-draw", !!mapGridDrawZone);
      canvas.style.cursor = mapGridDrawZone ? "crosshair" : "default";
    }
  }
  document.getElementById("map-grid-draw-grid")?.addEventListener("click", () => setGridDrawZone("grid"));
  document.getElementById("map-grid-draw-radius")?.addEventListener("click", () => setGridDrawZone("radius"));

  document.getElementById("map-grid-clear")?.addEventListener("click", () => {
    const row = mapAnalysesState.rows[mapAnalysesState.activeIndex];
    if (row) { initRowExtras(row); row.gridData = null; }
    const inputs = ["map-grid-ul-x","map-grid-ul-y","map-grid-ll-x","map-grid-ll-y",
      "map-grid-lr-x","map-grid-lr-y","map-grid-ur-x","map-grid-ur-y",
      "map-rad-ul-x","map-rad-ul-y","map-rad-ll-x","map-rad-ll-y",
      "map-rad-lr-x","map-rad-lr-y","map-rad-ur-x","map-rad-ur-y"];
    inputs.forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    redrawMapDxfPreview();
    toast("격자 탐색 데이터가 삭제되었습니다.");
  });

  bindMapDrawModeCanvas();
  document.getElementById("map-scan").addEventListener("click", runScanLayers);
  document.getElementById("map-run").addEventListener("click", runMapping);
  document.getElementById("map-water-add-row").addEventListener("click", () => {
    syncWaterPointsFromTable();
    const last = mapWaterPoints[mapWaterPoints.length - 1];
    mapWaterPoints.push({
      x: last ? last.x : 0,
      y: last ? last.y : 0,
    });
    renderWaterTable();
    redrawMapDxfPreview();
  });
  document
    .getElementById("map-water-from-dxf")
    .addEventListener("click", () => importWaterFromDxfFile());
});

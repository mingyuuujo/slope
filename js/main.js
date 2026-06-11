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
import { serializeXmlDocument } from "./xml-utils.js";
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
} from "./map-preview.js";

/** Region 매핑: 해석별 GeoStudio Region ID → Material (여러 Analysis 지원) */
const mapAnalysesState = {
  /** @type {{ id: number, title: string, regionMaterials: Record<string, number|null> }[]} */
  rows: [{ id: 1, title: "Analysis 1", regionMaterials: {} }],
  activeIndex: 0,
};

let mapDxfLayersCache = null;
/** DXF→지오메트리 파이프라인과 동일 순서의 닫힌 영역 목록 (미리보기·히트·표 행) */
let mapRegionPreviewCache = null;
/** Region 미리보기 캔버스 확대/이동 (CSS 픽셀 기준 pan) */
const mapDxfCanvasView = { zoom: 1, panX: 0, panY: 0 };
/** 드래그 이동 직후 재료 클릭 할당 1회 무시 */
let mapCanvasSuppressNextClick = false;
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
    return;
  }
  const gl = geometryLayersExceptWater();
  mapRegionPreviewCache = computePreviewRegionsFromDxf(
    mapDxfLayersCache,
    gl,
    () => {},
  );
  mergeRegionKeysIntoAllAnalysisRows();
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
    toast("삭제할 행을 선택(Ctrl+클릭으로 다중 선택)한 뒤 눌러 주세요.", false);
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

function redrawMapDxfPreview() {
  const canvas = document.getElementById("map-dxf-canvas");
  const legend = document.getElementById("map-dxf-legend");
  if (!canvas) return;
  const regions = mapRegionPreviewCache?.regions || [];
  const midMap = readRegionMidMapFromTable();
  drawMapDxfPreviewRegions(
    canvas,
    regions,
    midMap,
    mapMaterialRgbById,
    mapWaterPoints,
    mapDxfCanvasView,
  );
  renderMapDxfLegendRegions(
    legend,
    regions,
    midMap,
    mapMaterialRgbById,
    mapMaterialNameById,
  );
  updateMapCanvasZoomPct();
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
    mapAnalysesState.rows = [{ id: 1, title: "Analysis 1", regionMaterials: {} }];
  } else {
    mapAnalysesState.rows = list.map((a) => ({
      id: parseInt(String(a.id), 10) || 1,
      title: (a.name && String(a.name).trim()) || `해석 ${a.id}`,
      regionMaterials: {},
    }));
  }
  mapAnalysesState.activeIndex = 0;
  mergeRegionKeysIntoAllAnalysisRows();
}

function resetMapAnalysesToDefault() {
  mapAnalysesState.rows = [{ id: 1, title: "Analysis 1", regionMaterials: {} }];
  mapAnalysesState.activeIndex = 0;
  mergeRegionKeysIntoAllAnalysisRows();
}

function setActiveAnalysisIndex(idx) {
  if (idx < 0 || idx >= mapAnalysesState.rows.length) return;
  flushActiveAnalysisRegionsFromTable();
  mapAnalysesState.activeIndex = idx;
  renderMapAnalysisRows();
  refillMapRegionTbodyFromCache();
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
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

function bindMapAnalysisTable() {
  const tbody = document.getElementById("map-analysis-tbody");
  if (!tbody || tbody.dataset.bound) return;
  tbody.dataset.bound = "1";
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

function bindMapCanvasZoomPan() {
  const canvas = document.getElementById("map-dxf-canvas");
  if (!canvas || canvas.dataset.zoomPanBound === "1") return;
  canvas.dataset.zoomPanBound = "1";

  canvas.addEventListener(
    "wheel",
    (e) => {
      const regions = mapRegionPreviewCache?.regions || [];
      if (!regions.length) return;
      e.preventDefault();
      const frame = computeDxfPreviewLayoutFromRegions(
        canvas,
        regions,
        mapWaterPoints,
      );
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
    const regions = mapRegionPreviewCache?.regions || [];
    const frame = computeDxfPreviewLayoutFromRegions(
      canvas,
      regions,
      mapWaterPoints,
    );
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
  const getFrame = () => {
    const regions = mapRegionPreviewCache?.regions || [];
    if (!canvas || !regions.length) return null;
    return computeDxfPreviewLayoutFromRegions(canvas, regions, mapWaterPoints);
  };
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

    const slipComputed = computeSlipEntryExitFromDxf(dxfLayers, geometryLayers);
    applySlipEntryExitToAllSlopeItems(doc, slipComputed, log);

    setProgress("map-progress", 72);
    let totalRum = 0;
    for (const row of mapAnalysesState.rows) {
      const n = syncMaterialsForAnalysisFromRegions(
        doc,
        row.regionMaterials,
        row.id,
        log,
      );
      totalRum += n;
      log(
        `  └ Analysis ID=${row.id} 「${row.title}」 RegionUsesMaterials ${n}건`,
      );
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
    mapAnalysesState.rows.push({
      id: newId,
      title: `해석 ${newId}`,
      regionMaterials,
    });
    mapAnalysesState.activeIndex = mapAnalysesState.rows.length - 1;
    renderMapAnalysisRows();
    refillMapRegionTbodyFromCache();
    redrawMapDxfPreview();
  });
  initGszEditor();
  initResultViewer();
  initMaterialsTable();
  const matBody = document.getElementById("mat-tbody");
  matBody.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (!tr || !matBody.contains(tr)) return;
    if (e.ctrlKey || e.metaKey) {
      if (tr.hasAttribute("data-selected")) tr.removeAttribute("data-selected");
      else tr.setAttribute("data-selected", "1");
    } else {
      matBody.querySelectorAll("tr").forEach((r) => r.removeAttribute("data-selected"));
      tr.setAttribute("data-selected", "1");
    }
  });

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

import { geostudioULongToRgb } from "./color.js";

const FALLBACK_RGB = [
  [79, 195, 247],
  [129, 199, 132],
  [186, 104, 200],
  [255, 167, 38],
  [239, 83, 80],
  [171, 71, 188],
  [255, 202, 40],
  [77, 182, 172],
  [158, 158, 158],
];

/** 템플릿 재료 목록(colorUl 포함) → Material ID → RGB */
export function materialRgbMapFromMaterialsList(list) {
  const m = new Map();
  if (!list) return m;
  for (const row of list) {
    if (!row.colorUl) continue;
    const rgb = geostudioULongToRgb(row.colorUl);
    if (rgb) m.set(String(row.id), rgb);
  }
  return m;
}

/** 템플릿 재료 목록 → Material ID → 표시 이름 */
export function materialNameMapFromMaterialsList(list) {
  const m = new Map();
  if (!list) return m;
  for (const row of list) {
    const name = String(row.name ?? "").trim();
    m.set(String(row.id), name);
  }
  return m;
}

function fallbackRgbForMid(mid) {
  const i = Math.abs(mid) % FALLBACK_RGB.length;
  const [r, g, b] = FALLBACK_RGB[i];
  return { r, g, b };
}

function ringArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

function centroid2d(pts) {
  let cx = 0;
  let cy = 0;
  const n = pts.length || 1;
  for (const [x, y] of pts) {
    cx += x;
    cy += y;
  }
  return [cx / n, cy / n];
}

function rgbCss(rgb) {
  return `rgb(${rgb.r},${rgb.g},${rgb.b})`;
}

function darkenRgb(rgb, f = 0.72) {
  return {
    r: Math.round(rgb.r * f),
    g: Math.round(rgb.g * f),
    b: Math.round(rgb.b * f),
  };
}

function themeVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function setupCanvas(canvas) {
  const main = canvas.closest(".map-preview-main") || canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, main?.clientWidth || 640);
  const h = Math.min(560, Math.max(300, Math.round(w * 0.52)));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawPlaceholder(canvas, message) {
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.fillStyle = themeVar("--canvas-bg", "#1e2230");
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = themeVar("--muted", "#8b90a8");
  ctx.font = "14px system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, w / 2, h / 2);
}

/** 닫힌 폴리곤 내부 판정 (월드 XY, 홀 없음 가정) */
function pointInPolygon(x, y, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = Number(poly[i][0]);
    const yi = Number(poly[i][1]);
    const xj = Number(poly[j][0]);
    const yj = Number(poly[j][1]);
    if (
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-18) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function collectDxfPreviewEntries(dxfLayers) {
  /** @type {{ layer: string, poly: Array<[number, number]>, area: number }[]} */
  const entries = [];
  if (!dxfLayers || !Object.keys(dxfLayers).length) return entries;
  for (const [layer, polys] of Object.entries(dxfLayers)) {
    if (!Array.isArray(polys)) continue;
    for (const poly of polys) {
      if (!poly || poly.length < 3) continue;
      entries.push({ layer, poly, area: ringArea(poly) });
    }
  }
  return entries;
}

/** @param {{ regId: number, layer: string, poly: Array<[number, number]> }[]} regions */
function regionsToPreviewEntries(regions) {
  if (!regions || !regions.length) return [];
  return regions.map((r) => ({
    regId: r.regId,
    layer: r.layer,
    poly: r.poly,
    area: ringArea(r.poly),
  }));
}

/**
 * GeoStudio Region 빌드와 동일한 외곽선으로 미리보기 항목 생성
 */
export function computeDxfPreviewLayoutFromRegions(canvas, regions, waterPoints) {
  const entriesAll = regionsToPreviewEntries(regions);
  return computeDxfPreviewLayoutFromEntries(canvas, entriesAll, waterPoints);
}

function extendBboxPoint(minX, minY, maxX, maxY, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { minX, minY, maxX, maxY, ok: Number.isFinite(minX) };
  }
  return {
    minX: Math.min(minX, x),
    minY: Math.min(minY, y),
    maxX: Math.max(maxX, x),
    maxY: Math.max(maxY, y),
    ok: true,
  };
}

/**
 * @param {{ regId?: number, layer: string, poly: Array<[number, number]>, area?: number }[]} entriesAll
 */
function computeDxfPreviewLayoutFromEntries(canvas, entriesAll, waterPoints) {
  if (!canvas) return null;
  const waterPts = Array.isArray(waterPoints) ? waterPoints : [];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hasGeom = false;

  for (const { poly } of entriesAll) {
    for (const p of poly) {
      const x = Number(p[0]);
      const y = Number(p[1]);
      const b = extendBboxPoint(minX, minY, maxX, maxY, x, y);
      minX = b.minX;
      minY = b.minY;
      maxX = b.maxX;
      maxY = b.maxY;
      if (b.ok) hasGeom = true;
    }
  }
  for (const p of waterPts) {
    const b = extendBboxPoint(
      minX,
      minY,
      maxX,
      maxY,
      Number(p.x),
      Number(p.y),
    );
    minX = b.minX;
    minY = b.minY;
    maxX = b.maxX;
    maxY = b.maxY;
    if (b.ok) hasGeom = true;
  }

  if (!hasGeom || !Number.isFinite(minX)) return null;

  const pad = 28;
  const { w, h } = setupCanvas(canvas);
  const dx = maxX - minX || 1;
  const dy = maxY - minY || 1;
  const sx = (w - 2 * pad) / dx;
  const sy = (h - 2 * pad) / dy;
  const scale = Math.min(sx, sy);
  const innerW = dx * scale;
  const innerH = dy * scale;
  const offsetX = pad + (w - 2 * pad - innerW) / 2;
  const offsetY = pad + (h - 2 * pad - innerH) / 2;
  const withArea = entriesAll.map((e) => ({
    ...e,
    area: e.area != null ? e.area : ringArea(e.poly),
  }));
  const entriesDraw = [...withArea].sort((a, b) => b.area - a.area);

  return {
    w,
    h,
    pad,
    minX,
    minY,
    maxX,
    maxY,
    scale,
    offsetX,
    offsetY,
    entriesDraw,
    entriesAll: withArea,
  };
}

/**
 * drawMapDxfPreview 와 동일한 스케일·패딩. 시각화 없이 좌표 변환·히트 테스트용.
 */
export function computeDxfPreviewLayout(canvas, dxfLayers, waterPoints) {
  if (!canvas) return null;
  const entriesAll = collectDxfPreviewEntries(dxfLayers);
  return computeDxfPreviewLayoutFromEntries(canvas, entriesAll, waterPoints);
}

/**
 * 캔버스 표시 좌표(CSS px) → DXF 월드 좌표
 * @param {object} frame {@link computeDxfPreviewLayout} 가 반환한 프레임
 */
export function canvasCssToWorld(canvas, clientX, clientY, frame) {
  const rect = canvas.getBoundingClientRect();
  const rw = rect.width || frame.w;
  const rh = rect.height || frame.h;
  const xCss = ((clientX - rect.left) / rw) * frame.w;
  const yCss = ((clientY - rect.top) / rh) * frame.h;
  const wx = frame.minX + (xCss - frame.offsetX) / frame.scale;
  const wy = frame.maxY - (yCss - frame.offsetY) / frame.scale;
  return [wx, wy];
}

/**
 * 중첩 폴리곤이면 가장 작은(면적 최소) 영역의 레이어를 반환합니다.
 * @param {Set<string>} [excludeLayers] 물성 할당에서 제외할 레이어명
 * @returns {string | null}
 */
export function findLayerAtCanvasClient(
  canvas,
  dxfLayers,
  waterPoints,
  clientX,
  clientY,
  excludeLayers,
) {
  const frame = computeDxfPreviewLayout(canvas, dxfLayers, waterPoints);
  if (!frame) return null;
  const skip =
    excludeLayers instanceof Set
      ? excludeLayers
      : new Set(excludeLayers || []);
  const [wx, wy] = canvasCssToWorld(canvas, clientX, clientY, frame);
  const hits = [];
  for (const e of frame.entriesAll) {
    if (skip.has(e.layer)) continue;
    if (pointInPolygon(wx, wy, e.poly)) hits.push(e);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.area - b.area);
  return hits[0].layer;
}

/**
 * 줌·팬 보정 후 화면(CSS px) 좌표에서 DXF 월드 좌표
 * @param {{ zoom?: number, panX?: number, panY?: number }} [view]
 */
export function clientToWorldWithView(canvas, clientX, clientY, frame, view) {
  const v = view || { zoom: 1, panX: 0, panY: 0 };
  const z =
    v.zoom != null && Number.isFinite(v.zoom) ? Math.max(0.05, v.zoom) : 1;
  const panX = v.panX != null && Number.isFinite(v.panX) ? v.panX : 0;
  const panY = v.panY != null && Number.isFinite(v.panY) ? v.panY : 0;
  const {
    w,
    h,
    minX,
    maxY,
    scale,
    offsetX,
    offsetY,
  } = frame;
  const rect = canvas.getBoundingClientRect();
  const rw = rect.width || w;
  const rh = rect.height || h;
  const mx = ((clientX - rect.left) / rw) * w;
  const my = ((clientY - rect.top) / rh) * h;
  const bx = w / 2 + (mx - w / 2 - panX) / z;
  const by = h / 2 + (my - h / 2 - panY) / z;
  const wx = minX + (bx - offsetX) / scale;
  const wy = maxY - (by - offsetY) / scale;
  return [wx, wy];
}

/**
 * 휠 확대·축소 (커서 위치 고정)
 */
export function applyWheelToMapView(view, frame, canvas, clientX, clientY, deltaY) {
  if (!view || !frame || !canvas) return;
  const { w, h } = frame;
  const rect = canvas.getBoundingClientRect();
  const rw = rect.width || w;
  const rh = rect.height || h;
  const mx = ((clientX - rect.left) / rw) * w;
  const my = ((clientY - rect.top) / rh) * h;
  const oldZ =
    view.zoom != null && Number.isFinite(view.zoom) ? view.zoom : 1;
  const panX = view.panX != null && Number.isFinite(view.panX) ? view.panX : 0;
  const panY = view.panY != null && Number.isFinite(view.panY) ? view.panY : 0;
  const factor = deltaY < 0 ? 1.12 : 0.89;
  const newZ = Math.min(50, Math.max(0.12, oldZ * factor));
  const relX = (mx - w / 2 - panX) / oldZ;
  const relY = (my - h / 2 - panY) / oldZ;
  view.zoom = newZ;
  view.panX = mx - w / 2 - relX * newZ;
  view.panY = my - h / 2 - relY * newZ;
}

/** 버튼용: 화면 중심 기준 배율 변경 */
export function stepMapViewZoomCenter(view, frame, factor) {
  if (!view || !frame) return;
  const oldZ =
    view.zoom != null && Number.isFinite(view.zoom) ? view.zoom : 1;
  const newZ = Math.min(50, Math.max(0.12, oldZ * factor));
  const r = newZ / oldZ;
  view.zoom = newZ;
  view.panX =
    (view.panX != null && Number.isFinite(view.panX) ? view.panX : 0) * r;
  view.panY =
    (view.panY != null && Number.isFinite(view.panY) ? view.panY : 0) * r;
}

export function resetMapPreviewView(view) {
  if (!view) return;
  view.zoom = 1;
  view.panX = 0;
  view.panY = 0;
}

export function findRegionIdAtCanvasClient(
  canvas,
  regions,
  waterPoints,
  clientX,
  clientY,
  view,
) {
  const frame = computeDxfPreviewLayoutFromRegions(
    canvas,
    regions,
    waterPoints,
  );
  if (!frame) return null;
  const [wx, wy] = clientToWorldWithView(
    canvas,
    clientX,
    clientY,
    frame,
    view,
  );
  const hits = [];
  for (const e of frame.entriesAll) {
    if (e.regId == null) continue;
    if (pointInPolygon(wx, wy, e.poly)) hits.push(e);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.area - b.area);
  return hits[0].regId;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Record<string, Array<Array<[number, number]>>>} dxfLayers
 * @param {Record<string, number|null|undefined>} layerMidMap 레이어명 → Material ID 또는 미입력
 * @param {Map<string, {r:number,g:number,b:number}>} templateRgbById
 * @param {{ x: number, y: number }[]} [waterPoints] 수위 꺾은선 (미리보기; 저장 시 PiezometricLines 로 반영)
 */
export function drawMapDxfPreview(
  canvas,
  dxfLayers,
  layerMidMap,
  templateRgbById,
  waterPoints,
) {
  const waterPts = Array.isArray(waterPoints) ? waterPoints : [];

  if (!canvas) return;

  const layout = computeDxfPreviewLayout(canvas, dxfLayers, waterPts);
  if (!layout) {
    drawPlaceholder(
      canvas,
      "DXF 스캔 후 Region 폴리선이 표시됩니다. 수위는 점 2개 이상이면 함께 표시됩니다.",
    );
    return;
  }

  const {
    minX,
    maxY,
    scale,
    offsetX,
    offsetY,
    entriesDraw: entries,
  } = layout;
  const { ctx, w, h } = setupCanvas(canvas);

  function tx(x) {
    return offsetX + (x - minX) * scale;
  }
  function ty(y) {
    return offsetY + (maxY - y) * scale;
  }

  ctx.fillStyle = themeVar("--canvas-bg", "#1e2230");
  ctx.fillRect(0, 0, w, h);

  for (const { layer, poly } of entries) {
    const midRaw = layerMidMap[layer];
    const hasMid =
      midRaw != null && Number.isFinite(midRaw) && midRaw !== 0;

    let fillRgb;
    if (hasMid) {
      fillRgb = resolveMidRgb(midRaw, templateRgbById);
    } else {
      fillRgb = { r: 74, g: 80, b: 110 };
    }

    const fillA = hasMid ? 0.72 : 0.28;
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const px = tx(Number(poly[i][0]));
      const py = ty(Number(poly[i][1]));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = hasMid
      ? rgbCss(fillRgb).replace("rgb", "rgba").replace(")", `, ${fillA})`)
      : `rgba(${fillRgb.r},${fillRgb.g},${fillRgb.b},${fillA})`;
    ctx.fill();
    ctx.strokeStyle = hasMid
      ? rgbCss(darkenRgb(fillRgb, 0.55))
      : "rgba(140,145,170,0.5)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }

  if (waterPts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(tx(Number(waterPts[0].x)), ty(Number(waterPts[0].y)));
    for (let i = 1; i < waterPts.length; i++) {
      ctx.lineTo(tx(Number(waterPts[i].x)), ty(Number(waterPts[i].y)));
    }
    ctx.strokeStyle = "rgba(0, 229, 255, 0.95)";
    ctx.lineWidth = 2.75;
    ctx.setLineDash([10, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "600 11px system-ui,sans-serif";
    ctx.fillStyle = "rgba(120, 245, 255, 0.98)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      "@수위",
      tx(Number(waterPts[0].x)) + 5,
      ty(Number(waterPts[0].y)) - 5,
    );
  }

  ctx.font = "bold 12px system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const { layer, poly } of entries) {
    const midRaw = layerMidMap[layer];
    const hasMid =
      midRaw != null && Number.isFinite(midRaw) && midRaw !== 0;
    const label = hasMid ? String(midRaw) : "—";
    const [cx, cy] = centroid2d(poly);
    const px = tx(cx);
    const py = ty(cy);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.82)";
    ctx.strokeText(label, px, py);
    ctx.fillStyle = hasMid ? "#ffffff" : "rgba(200,204,224,0.85)";
    ctx.fillText(label, px, py);
  }
}

/**
 * GeoStudio Region 단위 Material 매핑 미리보기
 * @param {{ regId: number, layer: string, poly: Array<[number, number]> }[]} regions
 * @param {Record<string, number|null|undefined>} regionMidMap Region ID → Material
 * @param {{ zoom?: number, panX?: number, panY?: number }} [view] 확대/이동 (기본 1,0,0)
 */
export function drawMapDxfPreviewRegions(
  canvas,
  regions,
  regionMidMap,
  templateRgbById,
  waterPoints,
  view,
) {
  const waterPts = Array.isArray(waterPoints) ? waterPoints : [];
  if (!canvas) return;
  const layout = computeDxfPreviewLayoutFromRegions(
    canvas,
    regions,
    waterPts,
  );
  if (!layout) {
    drawPlaceholder(
      canvas,
      "DXF 스캔 후 Region 폴리선이 표시됩니다. 수위는 점 2개 이상이면 함께 표시됩니다.",
    );
    return;
  }

  const v = view || { zoom: 1, panX: 0, panY: 0 };
  const vz =
    v.zoom != null && Number.isFinite(v.zoom) ? Math.max(0.05, v.zoom) : 1;
  const vpx = v.panX != null && Number.isFinite(v.panX) ? v.panX : 0;
  const vpy = v.panY != null && Number.isFinite(v.panY) ? v.panY : 0;

  const {
    minX,
    maxY,
    scale,
    offsetX,
    offsetY,
    entriesDraw: entries,
  } = layout;
  const { ctx, w, h } = setupCanvas(canvas);

  function tx(x) {
    return offsetX + (x - minX) * scale;
  }
  function ty(y) {
    return offsetY + (maxY - y) * scale;
  }
  function sx(px) {
    return w / 2 + (px - w / 2) * vz + vpx;
  }
  function sy(py) {
    return h / 2 + (py - h / 2) * vz + vpy;
  }

  ctx.fillStyle = themeVar("--canvas-bg", "#1e2230");
  ctx.fillRect(0, 0, w, h);

  for (const ent of entries) {
    const regId = ent.regId;
    const poly = ent.poly;
    const midRaw =
      regId != null ? regionMidMap[String(regId)] : undefined;
    const hasMid =
      midRaw != null && Number.isFinite(midRaw) && midRaw !== 0;

    let fillRgb;
    if (hasMid) {
      fillRgb = resolveMidRgb(midRaw, templateRgbById);
    } else {
      fillRgb = { r: 74, g: 80, b: 110 };
    }

    const fillA = hasMid ? 0.72 : 0.28;
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const px = sx(tx(Number(poly[i][0])));
      const py = sy(ty(Number(poly[i][1])));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = hasMid
      ? rgbCss(fillRgb).replace("rgb", "rgba").replace(")", `, ${fillA})`)
      : `rgba(${fillRgb.r},${fillRgb.g},${fillRgb.b},${fillA})`;
    ctx.fill();
    ctx.strokeStyle = hasMid
      ? rgbCss(darkenRgb(fillRgb, 0.55))
      : "rgba(140,145,170,0.5)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }

  if (waterPts.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(
      sx(tx(Number(waterPts[0].x))),
      sy(ty(Number(waterPts[0].y))),
    );
    for (let i = 1; i < waterPts.length; i++) {
      ctx.lineTo(
        sx(tx(Number(waterPts[i].x))),
        sy(ty(Number(waterPts[i].y))),
      );
    }
    ctx.strokeStyle = "rgba(0, 229, 255, 0.95)";
    ctx.lineWidth = 2.75;
    ctx.setLineDash([10, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "600 11px system-ui,sans-serif";
    ctx.fillStyle = "rgba(120, 245, 255, 0.98)";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      "@수위",
      sx(tx(Number(waterPts[0].x))) + 5,
      sy(ty(Number(waterPts[0].y))) - 5,
    );
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const ent of entries) {
    const regId = ent.regId;
    const poly = ent.poly;
    const midRaw =
      regId != null ? regionMidMap[String(regId)] : undefined;
    const hasMid =
      midRaw != null && Number.isFinite(midRaw) && midRaw !== 0;
    const matLabel = hasMid ? String(midRaw) : "—";
    const [cx, cy] = centroid2d(poly);
    const px = sx(tx(cx));
    const py = sy(ty(cy));

    ctx.font = "600 10px system-ui,sans-serif";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.82)";
    if (regId != null) {
      ctx.strokeText(`R${regId}`, px, py - 8);
      ctx.fillStyle = "rgba(200,204,224,0.95)";
      ctx.fillText(`R${regId}`, px, py - 8);
    }

    ctx.font = "bold 12px system-ui,sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.82)";
    ctx.strokeText(matLabel, px, py + 7);
    ctx.fillStyle = hasMid ? "#ffffff" : "rgba(200,204,224,0.85)";
    ctx.fillText(matLabel, px, py + 7);
  }
}

function resolveMidRgb(midRaw, templateRgbById) {
  const key = String(midRaw);
  return templateRgbById?.get?.(key) ?? fallbackRgbForMid(midRaw);
}

/**
 * 캔버스와 동일한 색 규칙으로 범례(색 ↔ Material ID)를 채웁니다.
 * @param {HTMLElement | null} el
 * @param {Map<string, string>} templateNameById Material ID → 재료명 (템플릿 GSZ)
 */
export function renderMapDxfLegend(
  el,
  dxfLayers,
  layerMidMap,
  templateRgbById,
  templateNameById,
) {
  if (!el) return;
  el.innerHTML = "";

  const title = document.createElement("div");
  title.className = "map-legend-title";
  title.textContent = "범례 · 색 → ID · 이름";
  el.appendChild(title);

  if (!dxfLayers || !Object.keys(dxfLayers).length) {
    const p = document.createElement("p");
    p.className = "map-legend-empty";
    p.textContent = "DXF 레이어 스캔 후 표시됩니다.";
    el.appendChild(p);
    return;
  }

  const ids = new Set();
  let hasUnassigned = false;

  const scannedLayers = new Set(Object.keys(dxfLayers));
  for (const layer of scannedLayers) {
    if (!(layer in layerMidMap)) {
      hasUnassigned = true;
      continue;
    }
    const midRaw = layerMidMap[layer];
    const hasMid =
      midRaw != null && Number.isFinite(midRaw) && midRaw !== 0;
    if (hasMid) ids.add(midRaw);
    else hasUnassigned = true;
  }

  const sorted = [...ids].sort((a, b) => a - b);

  if (!sorted.length && !hasUnassigned) {
    const p = document.createElement("p");
    p.className = "map-legend-empty";
    p.textContent = "표시할 닫힌 폴리선이 없습니다.";
    el.appendChild(p);
    return;
  }

  const list = document.createElement("div");
  list.className = "map-legend-list";

  for (const mid of sorted) {
    const rgb = resolveMidRgb(mid, templateRgbById);
    const row = document.createElement("div");
    row.className = "map-legend-row";
    const sw = document.createElement("span");
    sw.className = "map-legend-swatch";
    sw.style.background = rgbCss(rgb);
    sw.style.borderColor = rgbCss(darkenRgb(rgb, 0.55));
    const nameTxt =
      templateNameById?.get?.(String(mid))?.trim() ?? "";

    const textWrap = document.createElement("div");
    textWrap.className = "map-legend-text";

    const idSpan = document.createElement("span");
    idSpan.className = "map-legend-label";
    idSpan.textContent = `ID ${mid}`;

    const nameSpan = document.createElement("span");
    nameSpan.className = "map-legend-name";
    if (nameTxt) {
      nameSpan.textContent = nameTxt;
    } else {
      nameSpan.classList.add("map-legend-name-dim");
      nameSpan.textContent = "(템플릿에 이름 없음)";
    }

    textWrap.appendChild(idSpan);
    textWrap.appendChild(nameSpan);

    row.appendChild(sw);
    row.appendChild(textWrap);
    list.appendChild(row);
  }

  if (hasUnassigned) {
    const row = document.createElement("div");
    row.className = "map-legend-row map-legend-row-muted";
    const sw = document.createElement("span");
    sw.className = "map-legend-swatch";
    sw.style.background = "rgba(74,80,110,0.45)";
    sw.style.borderColor = "rgba(140,145,170,0.65)";
    const lab = document.createElement("span");
    lab.className = "map-legend-label";
    lab.textContent = "미입력 · 0";
    row.appendChild(sw);
    row.appendChild(lab);
    list.appendChild(row);
  }

  el.appendChild(list);
}

function sortRegionIdsInPlace(arr) {
  arr.sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
}

/**
 * Region 단위 매핑용 범례 (물성별로 적용된 R 번호 나열)
 */
export function renderMapDxfLegendRegions(
  el,
  regions,
  regionMidMap,
  templateRgbById,
  templateNameById,
) {
  if (!el) return;
  el.innerHTML = "";

  const title = document.createElement("div");
  title.className = "map-legend-title";
  title.textContent = "범례 · 물성 ID · 이름 · Region";
  el.appendChild(title);

  if (!regions || !regions.length) {
    const p = document.createElement("p");
    p.className = "map-legend-empty";
    p.textContent = "DXF 스캔 후 표시됩니다.";
    el.appendChild(p);
    return;
  }

  const midToRegIds = new Map();
  const unassignedRegIds = [];
  for (const { regId } of regions) {
    if (regId == null) continue;
    const midRaw = regionMidMap[String(regId)];
    const hasMid =
      midRaw != null && Number.isFinite(midRaw) && midRaw !== 0;
    if (hasMid) {
      const mid = Number(midRaw);
      if (!midToRegIds.has(mid)) midToRegIds.set(mid, []);
      midToRegIds.get(mid).push(regId);
    } else {
      unassignedRegIds.push(regId);
    }
  }
  for (const rids of midToRegIds.values()) sortRegionIdsInPlace(rids);
  sortRegionIdsInPlace(unassignedRegIds);

  const sorted = [...midToRegIds.keys()].sort((a, b) => a - b);
  const hasUnassigned = unassignedRegIds.length > 0;

  if (!sorted.length && !hasUnassigned) {
    const p = document.createElement("p");
    p.className = "map-legend-empty";
    p.textContent = "Region이 없습니다.";
    el.appendChild(p);
    return;
  }

  const list = document.createElement("div");
  list.className = "map-legend-list";

  for (const mid of sorted) {
    const rgb = resolveMidRgb(mid, templateRgbById);
    const row = document.createElement("div");
    row.className = "map-legend-row";
    const sw = document.createElement("span");
    sw.className = "map-legend-swatch";
    sw.style.background = rgbCss(rgb);
    sw.style.borderColor = rgbCss(darkenRgb(rgb, 0.55));
    const nameTxt =
      templateNameById?.get?.(String(mid))?.trim() ?? "";

    const textWrap = document.createElement("div");
    textWrap.className = "map-legend-text";

    const idSpan = document.createElement("span");
    idSpan.className = "map-legend-label";
    idSpan.textContent = `ID ${mid}`;

    const nameSpan = document.createElement("span");
    nameSpan.className = "map-legend-name";
    if (nameTxt) {
      nameSpan.textContent = nameTxt;
    } else {
      nameSpan.classList.add("map-legend-name-dim");
      nameSpan.textContent = "(템플릿에 이름 없음)";
    }

    const regSpan = document.createElement("span");
    regSpan.className = "map-legend-regions";
    const rids = midToRegIds.get(mid) ?? [];
    regSpan.textContent =
      rids.length > 0
        ? `Region: ${rids.map((r) => `R${r}`).join(", ")}`
        : "Region: —";

    textWrap.appendChild(idSpan);
    textWrap.appendChild(nameSpan);
    textWrap.appendChild(regSpan);

    row.appendChild(sw);
    row.appendChild(textWrap);
    list.appendChild(row);
  }

  if (hasUnassigned) {
    const row = document.createElement("div");
    row.className = "map-legend-row map-legend-row-muted";
    const sw = document.createElement("span");
    sw.className = "map-legend-swatch";
    sw.style.background = "rgba(74,80,110,0.45)";
    sw.style.borderColor = "rgba(140,145,170,0.65)";
    const wrap = document.createElement("div");
    wrap.className = "map-legend-text";
    const lab = document.createElement("span");
    lab.className = "map-legend-label";
    lab.textContent = "미입력 · 물성 0";
    const regSpan = document.createElement("span");
    regSpan.className = "map-legend-regions map-legend-regions-muted";
    regSpan.textContent = `Region: ${unassignedRegIds.map((r) => `R${r}`).join(", ")}`;
    wrap.appendChild(lab);
    wrap.appendChild(regSpan);
    row.appendChild(sw);
    row.appendChild(wrap);
    list.appendChild(row);
  }

  el.appendChild(list);
}

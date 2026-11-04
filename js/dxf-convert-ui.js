/**
 * DXF → GSZ 파일 생성 탭 UI (개선된 레이아웃)
 * 캔버스 선택 + 우측 패널 입력
 */

import { parseDxfToRegions } from "./dxf-region-builder.js";
import { generateGszFromDxf } from "./dxf-gsz-generator.js";

function $id(id) { return document.getElementById(id); }

const state = {
  dxfText: null,
  regions: null,
  waterLevel: null,
  bounds: null,
  canvas: null,
  canvasCtx: null,
  materials: [],
  selectedRegionId: null,
  view: { zoom: 1, panX: 0, panY: 0 }
};

function initDxfConvertTab() {
  const fileInput = $id("dxf-convert-file");
  const reloadBtn = $id("dxf-convert-reload");
  const modeRadios = document.querySelectorAll("input[name='dxf-convert-mode']");
  const freshInputs = $id("dxf-convert-fresh-inputs");
  const reuseInputs = $id("dxf-convert-reuse-inputs");
  const runBtn = $id("dxf-convert-run");
  const regionPanel = $id("dxf-convert-region-panel");

  state.canvas = $id("dxf-convert-canvas");
  state.canvasCtx = state.canvas?.getContext("2d");

  // DXF 파일 선택
  if (fileInput) {
    fileInput.addEventListener("change", loadDxfFile);
  }

  // 새로 로드
  if (reloadBtn) {
    reloadBtn.addEventListener("click", loadDxfFile);
  }

  // 모드 선택
  modeRadios.forEach(radio => {
    radio.addEventListener("change", (e) => {
      const mode = e.target.value;
      freshInputs.style.display = mode === "fresh" ? "grid" : "none";
      reuseInputs.style.display = mode === "reuse" ? "block" : "none";
    });
  });

  // 캔버스 이벤트
  if (state.canvas) {
    state.canvas.addEventListener("click", onCanvasClick);
    state.canvas.addEventListener("wheel", onCanvasWheel, { passive: false });
    state.canvas.addEventListener("mousedown", onCanvasMouseDown);
    state.canvas.addEventListener("mousemove", onCanvasMouseMove);
    state.canvas.addEventListener("mouseup", onCanvasMouseUp);
    state.canvas.addEventListener("mouseleave", onCanvasMouseUp);
  }

  // 저장 버튼
  $id("dxf-convert-save-region")?.addEventListener("click", saveSelectedRegion);

  // GSZ 생성
  if (runBtn) {
    runBtn.addEventListener("click", generateGsz);
  }
}

async function loadDxfFile() {
  const fileInput = $id("dxf-convert-file");
  const file = fileInput?.files?.[0];
  if (!file) {
    log("DXF 파일을 선택하세요.", true);
    return;
  }

  try {
    clearLog();
    log("DXF 파일 로드 중...");
    state.dxfText = await file.text();

    const layerFilter = $id("dxf-convert-layer")?.value || null;
    log("DXF 파싱 중...");

    const result = await parseDxfToRegions(state.dxfText, layerFilter);
    state.regions = result.regions;
    state.waterLevel = result.waterLevel;
    state.bounds = result.bounds;

    log(`완료: ${state.regions.length}개 영역 감지`);
    if (state.waterLevel !== null) {
      log(`수위 자동감지: ${state.waterLevel.toFixed(2)} m`);
    }

    // 재료 초기화
    state.materials = state.regions.map((r, i) => ({
      id: `Material-${i + 1}`,
      name: `재료${i + 1}`,
      model: "MohrCoulomb",
      uw: 18.5,
      dw: 16.0,
      c: 10,
      phi: 30,
      c_top: 0,
      c_rate: 0.2,
      c_datum: 0,
      datum_elev: 0,
      completed: false  // 입력 완료 여부
    }));

    // 진행률 표시 초기화
    $id("dxf-convert-total").textContent = state.regions.length;
    updateStatusList();

    $id("dxf-convert-file-label").textContent = file.name;
    $id("dxf-convert-water-level").placeholder =
      state.waterLevel ? state.waterLevel.toFixed(2) : "";

    drawCanvas();
    $id("dxf-convert-reload").disabled = false;
    $id("dxf-convert-run").disabled = false;

    // 패널 표시
    const panel = $id("dxf-convert-region-panel");
    if (panel) {
      panel.style.display = "flex";
      panel.style.flexDirection = "column";
    }
  } catch (err) {
    log(`오류: ${err.message}`, true);
    $id("dxf-convert-run").disabled = true;
  }
}

function drawCanvas() {
  if (!state.canvas || !state.regions) return;

  const canvas = state.canvas;
  const ctx = state.canvasCtx;
  const dpr = window.devicePixelRatio || 1;

  // 캔버스 크기 조정
  const container = canvas.parentElement;
  canvas.width = container.clientWidth * dpr;
  canvas.height = container.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  const cw = container.clientWidth;
  const ch = container.clientHeight;

  // 세계 좌표 → 캔버스 변환 (확대/축소 고려)
  const b = state.bounds;
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const baseRatio = Math.min(cw / w, ch / h) * 0.9;
  const ratio = baseRatio * state.view.zoom;
  const offsetX = (cw - w * baseRatio) / 2 + state.view.panX;
  const offsetY = (ch - h * baseRatio) / 2 + state.view.panY;

  function worldToCanvas(x, y) {
    return [
      (x - b.minX) * ratio + offsetX,
      ch - ((y - b.minY) * ratio + offsetY)
    ];
  }

  // 배경 - 밝은 색
  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(0, 0, cw, ch);

  // 영역 그리기
  const regionColors = [
    "#8B6F47", "#C9A961", "#A0826D", "#B8956A", "#9E7C7C",
    "#7A8B8C", "#8B9A9E", "#9CA0A0", "#8B8B8B", "#6B6B6B",
    "#A67C52", "#D4A574", "#C9985F", "#B4845C", "#9D7C6B"
  ];

  for (let i = 0; i < state.regions.length; i++) {
    const region = state.regions[i];
    const mat = state.materials[i];
    const isSelected = region.id === state.selectedRegionId;
    const isCompleted = mat.completed;
    const color = regionColors[i % regionColors.length];

    // 영역 채우기: 완료=진한색, 미완료=밝은색
    ctx.fillStyle = isCompleted ? color : "#e0e0e0";
    ctx.globalAlpha = isSelected ? 0.8 : (isCompleted ? 0.6 : 0.4);
    ctx.beginPath();
    for (let j = 0; j < region.vertices.length; j++) {
      const [cx, cy] = worldToCanvas(region.vertices[j].x, region.vertices[j].y);
      if (j === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.closePath();
    ctx.fill();

    // 경계선
    ctx.strokeStyle = isSelected ? "#ff9800" : "#333333";
    ctx.globalAlpha = 1.0;
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.stroke();

    // 영역 번호
    if (region.vertices.length > 0) {
      let cx = 0, cy = 0;
      for (const v of region.vertices) {
        const [pcx, pcy] = worldToCanvas(v.x, v.y);
        cx += pcx;
        cy += pcy;
      }
      cx /= region.vertices.length;
      cy /= region.vertices.length;

      ctx.globalAlpha = 1.0;
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // 배경 박스
      ctx.fillStyle = isSelected ? "rgba(255, 152, 0, 0.9)" : "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(cx - 16, cy - 14, 32, 28);

      // 텍스트
      ctx.fillStyle = "#ffffff";
      ctx.fillText(region.id.toString(), cx, cy);
    }
  }

  ctx.globalAlpha = 1.0;
}

function onCanvasClick(e) {
  if (!state.canvas || !state.regions) return;

  const rect = state.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // 캔버스 좌표 → 세계 좌표 (확대/축소 고려)
  const b = state.bounds;
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const baseRatio = Math.min(rect.width / w, rect.height / h) * 0.9;
  const ratio = baseRatio * state.view.zoom;
  const offsetX = (rect.width - w * baseRatio) / 2 + state.view.panX;
  const offsetY = (rect.height - h * baseRatio) / 2 + state.view.panY;

  const worldX = (x - offsetX) / ratio + b.minX;
  const worldY = (rect.height - y - offsetY) / ratio + b.minY;

  // 영역 판정
  for (const region of state.regions) {
    if (pointInPolygon(worldX, worldY, region.vertices)) {
      selectRegion(region.id);
      return;
    }
  }
}

function pointInPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = ((yi > y) !== (yj > y))
      && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// 캔버스 확대/축소 및 팬 이벤트
let dragStart = null;

function onCanvasWheel(e) {
  e.preventDefault();

  const rect = state.canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // 휠 방향: 위로(deltaY < 0) = 확대, 아래로(deltaY > 0) = 축소
  const delta = e.deltaY < 0 ? 1.1 : 0.9;
  const oldZoom = state.view.zoom;
  const newZoom = Math.max(0.5, Math.min(5, oldZoom * delta));

  // 마우스 위치를 중심으로 확대/축소
  // 마우스 커서가 같은 세계 좌표를 가리키도록 유지
  const zoomRatio = newZoom / oldZoom;
  state.view.panX = mouseX - (mouseX - state.view.panX) * zoomRatio;
  state.view.panY = mouseY - (mouseY - state.view.panY) * zoomRatio;
  state.view.zoom = newZoom;

  drawCanvas();
}

let isDragging = false;

function onCanvasMouseDown(e) {
  if (e.button !== 0) return; // 좌클릭만
  dragStart = { x: e.clientX, y: e.clientY, panX: state.view.panX, panY: state.view.panY };
  isDragging = false;
}

function onCanvasMouseMove(e) {
  if (!dragStart) return;

  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // 5px 이상 움직이면 팬 모드 시작
  if (distance > 5) {
    isDragging = true;
  }

  if (isDragging) {
    // X축: 마우스와 같은 방향, Y축: 마우스와 반대 방향
    state.view.panX = dragStart.panX + dx;
    state.view.panY = dragStart.panY - dy;
    drawCanvas();
  }
}

function onCanvasMouseUp(e) {
  // 드래그가 아니었으면 클릭으로 처리
  if (dragStart && !isDragging) {
    onCanvasClick(e);
  }
  dragStart = null;
  isDragging = false;
}

function selectRegion(regionId) {
  state.selectedRegionId = regionId;
  const region = state.regions.find(r => r.id === regionId);
  const mat = state.materials.find(m => m.id === `Material-${regionId}`);

  if (!region || !mat) return;

  const status = mat.completed ? "✓ 완료" : "◯ 미입력";
  $id("dxf-convert-selected-region").textContent = `영역 #${regionId} - ${mat.name} [${status}]`;
  $id("dxf-convert-input-form").style.display = "block";

  $id("dxf-convert-sel-name").value = mat.name;
  $id("dxf-convert-sel-model").value = mat.model;
  $id("dxf-convert-sel-uw").value = mat.uw;
  $id("dxf-convert-sel-dw").value = mat.dw;
  $id("dxf-convert-sel-c").value = mat.c;
  $id("dxf-convert-sel-phi").value = mat.phi;

  drawCanvas();
  updateStatusList();
}

function updateStatusList() {
  const listEl = $id("dxf-convert-status-list");
  if (!listEl || !state.materials) return;

  const completed = state.materials.filter(m => m.completed).length;
  const total = state.materials.length;

  // 진행률 업데이트
  $id("dxf-convert-progress").textContent = completed;
  const percent = total > 0 ? (completed / total) * 100 : 0;
  $id("dxf-convert-progress-bar").style.width = `${percent}%`;

  // 리스트 생성
  listEl.innerHTML = state.materials.map((mat, idx) => {
    const regionId = idx + 1;
    const status = mat.completed
      ? `<span style="color:#4CAF50">✓ ${mat.name}</span>`
      : `<span style="color:#999">◯ ${mat.name}</span>`;
    const isSelected = regionId === state.selectedRegionId ? "background:rgba(255,152,0,0.1)" : "";

    return `<div style="padding:4px;cursor:pointer;${isSelected};border-radius:2px"
                onclick="selectRegion(${regionId})">
      <strong>#${regionId}</strong> ${status}
    </div>`;
  }).join("");
}

function saveSelectedRegion() {
  if (!state.selectedRegionId) return;

  const idx = state.selectedRegionId - 1;
  state.materials[idx].name = $id("dxf-convert-sel-name").value;
  state.materials[idx].model = $id("dxf-convert-sel-model").value;
  state.materials[idx].uw = parseFloat($id("dxf-convert-sel-uw").value) || 18.5;
  state.materials[idx].dw = parseFloat($id("dxf-convert-sel-dw").value) || 16.0;
  state.materials[idx].c = parseFloat($id("dxf-convert-sel-c").value) || 10;
  state.materials[idx].phi = parseFloat($id("dxf-convert-sel-phi").value) || 30;
  state.materials[idx].completed = true;  // 완료 표시

  log(`영역 #${state.selectedRegionId} 저장됨`);

  // UI 업데이트
  drawCanvas();
  updateStatusList();
}

async function generateGsz() {
  clearLog();
  log("GSZ 파일 생성 중...");

  try {
    const mode = document.querySelector("input[name='dxf-convert-mode']:checked")?.value || "fresh";
    const params = {
      regions: state.regions,
      waterLevel: state.waterLevel,
      materials: state.materials,
      mode,
      slipEntryPreset: "auto",
      kh: parseFloat($id("dxf-convert-kh")?.value || 0),
      kv: parseFloat($id("dxf-convert-kv")?.value || 0)
    };

    if (mode === "fresh") {
      const waterInput = $id("dxf-convert-water-level")?.value;
      if (waterInput) {
        params.waterLevel = parseFloat(waterInput);
      }
    } else {
      const file = $id("dxf-convert-existing-gsz")?.files?.[0];
      if (!file) throw new Error("기존 GSZ 파일을 선택하세요");
      params.existingGszBuffer = await file.arrayBuffer();
      params.updateWaterFromDxf = $id("dxf-convert-update-water-from-dxf")?.checked || false;
    }

    const blob = await generateGszFromDxf(params);
    log("완료!");
    triggerDownload(blob, "slope-analysis.gsz");
  } catch (err) {
    log(`오류: ${err.message}`, true);
  }
}

function log(msg, isError = false) {
  const box = $id("dxf-convert-log");
  if (!box) return;
  const line = document.createElement("div");
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (isError) line.style.color = "var(--danger, #e53935)";
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = $id("dxf-convert-log");
  if (box) box.textContent = "";
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export { initDxfConvertTab };

// 전역 함수 (HTML onclick에서 호출 가능)
window.selectRegion = selectRegion;

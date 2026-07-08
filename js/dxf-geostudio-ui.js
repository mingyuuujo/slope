/**
 * DXF → GeoStudio Excel 변환 탭 UI 로직
 * panel-dxf-convert 패널의 이벤트를 처리합니다.
 */

import { parseDxfText } from "./deps.js";
import { convertDxfParsed, exportGeoStudioExcel } from "./dxf-to-geostudio.js";

function $id(id) { return document.getElementById(id); }

function log(msg, isError = false) {
  const box = $id("dxf-gs-log");
  if (!box) return;
  const line = document.createElement("div");
  line.textContent = msg;
  if (isError) line.style.color = "var(--danger, #e53935)";
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function clearLog() {
  const box = $id("dxf-gs-log");
  if (box) box.textContent = "";
}

function setStatus(msg, type = "idle") {
  const el = $id("dxf-gs-status");
  if (!el) return;
  el.textContent = msg;
  el.className = "dxf-gs-status dxf-gs-status--" + type;
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

async function runConvert() {
  const fileInput = $id("dxf-gs-file");
  const file = fileInput?.files?.[0];
  if (!file) {
    setStatus("DXF 파일을 선택하세요.", "error");
    return;
  }

  clearLog();
  setStatus("변환 중…", "running");
  $id("dxf-gs-run").disabled = true;

  try {
    // 파일 읽기
    const text = await file.text();
    log(`파일 로드: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

    // DXF 파싱
    const dxf = await parseDxfText(text);
    log(`DXF 파싱 완료 — 엔티티 ${dxf.entities?.length ?? 0}개`);

    // 옵션 수집
    const layerRaw = $id("dxf-gs-layer")?.value.trim();
    const idStart  = parseInt($id("dxf-gs-id-start")?.value ?? "1", 10);
    const tol      = parseFloat($id("dxf-gs-tol")?.value ?? "1e-5");
    const dec      = parseInt($id("dxf-gs-dec")?.value ?? "5", 10);

    const opts = {
      layerFilter:    layerRaw || null,
      pointIdStart:   Number.isFinite(idStart) && idStart >= 1 ? idStart : 1,
      coordinateTolerance:  Number.isFinite(tol) && tol > 0 ? tol : 1e-5,
      coordinateDecimals:   Number.isFinite(dec) && dec >= 0 ? dec : 5,
    };

    log(`옵션 — 레이어: ${opts.layerFilter ?? "(전체)"}, ` +
        `ID 시작: ${opts.pointIdStart}, 허용오차: ${opts.coordinateTolerance}, ` +
        `소수점: ${opts.coordinateDecimals}`);

    // 변환
    const result = convertDxfParsed(dxf, opts);

    // 경고 출력
    if (result.warnings.length) {
      for (const w of result.warnings) log(`⚠ ${w}`);
    }

    log(`변환 완료 — Points: ${result.points.length}개, Regions: ${result.regions.length}개`);

    // Excel 생성 + 다운로드
    const blob = await exportGeoStudioExcel(result);
    const stem = file.name.replace(/\.dxf$/i, "");
    triggerDownload(blob, `${stem}_geostudio.xlsx`);
    log(`Excel 저장: ${stem}_geostudio.xlsx`);

    setStatus(
      `완료 — Points ${result.points.length}개 / Regions ${result.regions.length}개`,
      "ok"
    );
  } catch (err) {
    log(`오류: ${err.message}`, true);
    setStatus("변환 실패 — 로그를 확인하세요.", "error");
  } finally {
    $id("dxf-gs-run").disabled = false;
  }
}

export function initDxfGeoStudioTab() {
  $id("dxf-gs-run")?.addEventListener("click", runConvert);

  // 파일 선택 시 파일명 표시 + 상태 초기화
  $id("dxf-gs-file")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    const label = $id("dxf-gs-file-label");
    if (label) label.textContent = f ? f.name : "";
    clearLog();
    setStatus("대기 중", "idle");
  });
}

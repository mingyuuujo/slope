/**
 * excel-report.js
 * ExcelJS 기반 구조계산서 xlsx 생성.
 * 색상: 무채색(dark gray 계열), 열 너비: 전체 3, 이미지 비율 유지
 */

import { REQUIRED_FOS } from "./analysis-classifier.js";

function getExcelJS() {
  const EJ = globalThis.ExcelJS;
  if (!EJ) throw new Error("ExcelJS가 로드되지 않았습니다.");
  return EJ;
}

// ─── 컬럼 맵 (1-based) ───────────────────────────────────────
const COL = {
  B: 2,  C: 3,  D: 4,  E: 5,  F: 6,  G: 7,  H: 8,
  I: 9,  J: 10, K: 11, L: 12, M: 13, N: 14,
  O: 15, P: 16, Q: 17, R: 18, S: 19, T: 20,
  U: 21, V: 22, W: 23, X: 24, Y: 25,
  Z: 26, AA: 27, AB: 28, AC: 29, AD: 30,
  AE: 31, AF: 32, AG: 33, AH: 34, AI: 35,
};

// 열 범위 (B..AH) = 33열 × 너비3
const COL_SPAN = COL.AH - COL.B + 1;  // 33
const COL_W    = 3;

// ─── 색상 팔레트 ─────────────────────────────────────────────
const FILL_SECTION = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
const FILL_HEADER  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
const FILL_DATA    = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
const BORDER_COLOR = { argb: "FF000000" };
const BORDER_THIN  = { style: "thin", color: BORDER_COLOR };

// ─── 폰트 ────────────────────────────────────────────────────
const FONT_NAME = "맑은 고딕";
const F_BASE    = { name: FONT_NAME, size: 11, color: { argb: "FF000000" } };
const F_BOLD    = { name: FONT_NAME, size: 11, color: { argb: "FF000000" }, bold: true };
const F_TITLE   = { name: FONT_NAME, size: 11, color: { argb: "FF000000" }, bold: true };
const F_WHITE     = { name: FONT_NAME, size: 11, color: { argb: "FF000000" }, bold: true };
const F_WHITE_T   = { name: FONT_NAME, size: 11, color: { argb: "FF000000" }, bold: true };
const F_RED       = { name: FONT_NAME, size: 11, color: { argb: "FFFF0000" } };
const F_BOLD_BLUE = { name: FONT_NAME, size: 11, color: { argb: "FF0000FF" }, bold: true };

const ALIGN_CC       = { horizontal: "center", vertical: "middle", wrapText: true };
const ALIGN_CC_SHRINK = { horizontal: "center", vertical: "middle", shrinkToFit: true };
const ALIGN_LC       = { horizontal: "left",   vertical: "middle", wrapText: true };

function thinBorder() {
  return { top: BORDER_THIN, left: BORDER_THIN, bottom: BORDER_THIN, right: BORDER_THIN };
}

// PNG IHDR에서 실제 픽셀 크기 읽기
function getPngDims(b64) {
  if (!b64) return null;
  try {
    const raw = b64.replace(/^data:image\/\w+;base64,/, "");
    const bin = atob(raw);
    const dv  = new DataView(new ArrayBuffer(24));
    for (let i = 0; i < 24; i++) dv.setUint8(i, bin.charCodeAt(i));
    const w = dv.getUint32(16), h = dv.getUint32(20);
    return (w > 0 && h > 0) ? { w, h } : null;
  } catch { return null; }
}

// 열 너비 기준 행 높이 산출 (비율 유지, 0.25pt 단위)
// colCnt: 이미지가 차지하는 컬럼 수, rowCnt: 이미지 행 수
function imgRowHt(colCnt, rowCnt, srcW, srcH) {
  const px = colCnt * COL_W * 8 * (srcH / srcW) / rowCnt;
  return Math.max(Math.round(px * 3) / 4, 10);  // px → pt (*0.75), 0.25pt 단위
}

function mc(ws, r1, c1, r2, c2, value, font, alignment, fill, border) {
  ws.mergeCells(r1, c1, r2, c2);
  const cell = ws.getCell(r1, c1);
  cell.value = value;
  if (font)            cell.font      = font;
  if (alignment)       cell.alignment = alignment;
  if (fill)            cell.fill      = fill;
  if (border !== null) cell.border    = border !== undefined ? border : thinBorder();
}

// ─── 물성치 분류 ─────────────────────────────────────────────
const GROUND_KW = ["점토", "모래", "자갈", "풍화토", "암", "퇴적", "기반암"];
function isGround(name) { return GROUND_KW.some((kw) => name.includes(kw)); }
function splitMaterials(mats) {
  const structure = [], ground = [];
  for (const m of mats) {
    (isGround(m.name) ? ground : structure).push(m);
  }
  return { structure, ground };
}

// GSX props 형식 또는 JSON 형식 모두 정규화
function normalizeMat(m) {
  if (m.props) {
    return {
      name:       m.name,
      model:      m.slopeModel ?? "MohrCoulomb",
      uw:         parseFloat(m.props.UnitWeight      ?? ""),
      dw:         parseFloat(m.props.DryWeight       ?? ""),
      c:          parseFloat(m.props.CohesionPrime   ?? ""),
      phi:        parseFloat(m.props.PhiPrime        ?? ""),
      c_top:      parseFloat(m.props.CTopOfLayer     ?? ""),
      c_rate:     parseFloat(m.props.CRateOfIncrease ?? ""),
      c_datum:    parseFloat(m.props.CDatum          ?? ""),
      datum_elev: parseFloat(m.props.DatumElev       ?? ""),
    };
  }
  return {
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
}

// ─── FOS 판정 ─────────────────────────────────────────────────
function judgeOkNg(fos, req) {
  if (!Number.isFinite(fos)) return "—";
  return fos >= req ? "O.K" : "N.G";
}

// ─── 재료 테이블 ─────────────────────────────────────────────
// 열 레이아웃 (B~AH, 33열):
//   구분:     B~G  (6열)
//   단위중량: H~S  (12열)  → γt: H~M, γsat: N~S
//   전단강도: T~AC (10열)  → Φ:  T~X, c: Y~AC
//   비고:     AD~AH (5열)
function writeMaterialTable(ws, startRow, _title, mats) {
  const hr1 = startRow;
  const hr2 = startRow + 1;
  // 구분·비고: 2행 병합
  mc(ws, hr1, COL.B,  hr2, COL.G,  "구분",     F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr1, COL.H,  hr1, COL.S,  "단위중량", F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr1, COL.T,  hr1, COL.AC, "전단강도", F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr1, COL.AD, hr2, COL.AH, "비고",     F_WHITE, ALIGN_CC, FILL_HEADER);

  mc(ws, hr2, COL.H,  hr2, COL.M,  "γt (kN/m³)",   F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr2, COL.N,  hr2, COL.S,  "γsat (kN/m³)", F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr2, COL.T,  hr2, COL.X,  "Φ (deg)",       F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr2, COL.Y,  hr2, COL.AC, "c (kN/m²)",     F_WHITE, ALIGN_CC, FILL_HEADER);

  for (let i = 0; i < mats.length; i++) {
    const dr = startRow + 2 + i;
    const m  = normalizeMat(mats[i]);

    let cDisplay;
    if (m.model === "SFnDepth") {
      cDisplay = (Number.isFinite(m.c_rate) && Number.isFinite(m.c_top))
        ? `${m.c_rate.toFixed(2)}Z+${m.c_top.toFixed(2)}` : "-";
    } else if (m.model === "SFnDatum") {
      cDisplay = (Number.isFinite(m.c_rate) && Number.isFinite(m.c_datum))
        ? `${m.c_rate.toFixed(2)}Z+${m.c_datum.toFixed(2)}` : "-";
    } else {
      cDisplay = Number.isFinite(m.c) ? m.c.toFixed(2) : "-";
    }

    // γt: dw 없으면 uw로 대체 (동일 값으로 간주)
    const gtVal  = Number.isFinite(m.dw) ? m.dw : (Number.isFinite(m.uw) ? m.uw : null);
    const gsatVal = Number.isFinite(m.uw) ? m.uw : null;

    mc(ws, dr, COL.B,  dr, COL.G,  m.name,                                   F_BASE, ALIGN_CC_SHRINK, FILL_DATA);
    mc(ws, dr, COL.H,  dr, COL.M,  gtVal  !== null ? gtVal.toFixed(2)  : "-", F_BASE, ALIGN_CC, FILL_DATA);
    mc(ws, dr, COL.N,  dr, COL.S,  gsatVal !== null ? gsatVal.toFixed(2) : "-", F_BASE, ALIGN_CC, FILL_DATA);
    mc(ws, dr, COL.T,  dr, COL.X,  Number.isFinite(m.phi) ? m.phi.toFixed(2) : "-", F_BASE, ALIGN_CC, FILL_DATA);
    mc(ws, dr, COL.Y,  dr, COL.AC, cDisplay,                                  F_BASE, ALIGN_CC, FILL_DATA);
    mc(ws, dr, COL.AD, dr, COL.AH, "-",                                   F_BASE, ALIGN_CC, FILL_DATA);
  }

  return startRow + 2 + mats.length;
}

// ─── 결과 요약 테이블 ─────────────────────────────────────────
// 열 레이아웃 (B~AH):
//   구분:     B~J  (9열)
//   검토결과: K~S  (9열)
//   기준안전율: T~AB (9열)
//   판정:     AC~AH (6열)
function writeSummaryTable(ws, startRow, cases) {
  const hr = startRow;
  mc(ws, hr, COL.B,  hr, COL.J,  "구   분",    F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr, COL.K,  hr, COL.S,  "검토결과",   F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr, COL.T,  hr, COL.AB, "기준안전율", F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hr, COL.AC, hr, COL.AH, "판   정",    F_WHITE, ALIGN_CC, FILL_HEADER);

  let dataRow = startRow + 1;
  for (const { key, label, result } of cases) {
    const req    = REQUIRED_FOS[key] ?? 1.1;
    const fos    = result?.fos;
    const judge  = judgeOkNg(fos, req);
    const fosStr = Number.isFinite(fos) ? fos.toFixed(3) : "—";

    mc(ws, dataRow, COL.B,  dataRow, COL.J,  label,  F_BASE, ALIGN_CC, FILL_DATA);
    mc(ws, dataRow, COL.K,  dataRow, COL.S,  fosStr, F_BOLD, ALIGN_CC, FILL_DATA);
    mc(ws, dataRow, COL.T,  dataRow, COL.AB, req,    F_BASE, ALIGN_CC, FILL_DATA);
    mc(ws, dataRow, COL.AC, dataRow, COL.AH, judge,  F_BOLD, ALIGN_CC, FILL_DATA);

    dataRow++;
  }
  return dataRow;
}

// ─── 케이스 상세 결과 ─────────────────────────────────────────
// 열 레이아웃 (B~AH):
//   기준안전율: B~M  (12열)
//   검토안전율: N~X  (11열)
//   판정:       Y~AH (10열)
async function writeCaseDetail(wb, ws, caseKey, label, result, imgDataUrl, startRow, canvasW, canvasH) {
  const req = REQUIRED_FOS[caseKey] ?? 1.1;
  const fos = result?.fos;
  const judge = judgeOkNg(fos, req);

  mc(ws, startRow, COL.B, startRow, COL.AH, label, F_WHITE_T, ALIGN_CC, FILL_SECTION);

  const imgRow1 = startRow + 1;
  const IMG_ROWS = 7;
  const imgRow2  = imgRow1 + IMG_ROWS - 1;

  // 이미지 행 높이: PNG 실제 크기 기준으로 열 너비 대비 정비율 산출
  // (편심 시트의 writeGszBlock과 동일한 getPngDims+imgRowHt 방식)
  {
    const rowHPt = (() => {
      if (imgDataUrl) {
        const b64  = imgDataUrl.replace(/^data:image\/\w+;base64,/, "");
        const dims = getPngDims(b64);
        if (dims) return imgRowHt(COL_SPAN, IMG_ROWS, dims.w, dims.h);
      }
      // fallback: 전달된 canvasH/canvasW 비율
      return imgRowHt(COL_SPAN, IMG_ROWS, canvasW, canvasH);
    })();
    for (let r = imgRow1; r <= imgRow2; r++) ws.getRow(r).height = rowHPt;
  }

  // 이미지 영역 외곽 테두리: 병합 없이 엣지 셀 각각에 직접 적용
  // (병합 시 ExcelJS가 앵커 셀에만 border를 저장해 왼쪽 테두리가 잘리는 문제 방지)
  for (let c = COL.B; c <= COL.AH; c++) {
    const tc = ws.getCell(imgRow1, c); tc.border = { ...(tc.border || {}), top:    BORDER_THIN };
    const bc = ws.getCell(imgRow2, c); bc.border = { ...(bc.border || {}), bottom: BORDER_THIN };
  }
  for (let r = imgRow1; r <= imgRow2; r++) {
    const lc = ws.getCell(r, COL.B);   lc.border = { ...(lc.border || {}), left:  BORDER_THIN };
    const rc = ws.getCell(r, COL.AH);  rc.border = { ...(rc.border || {}), right: BORDER_THIN };
  }

  if (imgDataUrl) {
    try {
      const base64 = imgDataUrl.replace(/^data:image\/\w+;base64,/, "");
      const imgId  = wb.addImage({ base64, extension: "png" });
      // tl을 오른쪽 3px, 아래 3px 이동 (1px = 9525 EMU)
      const OFF = 3 * 9525; // 28575 EMU
      ws.addImage(imgId, {
        tl: { nativeCol: COL.B - 1, nativeColOff: OFF, nativeRow: imgRow1 - 1, nativeRowOff: OFF },
        br: { nativeCol: COL.AH,    nativeColOff: 0,   nativeRow: imgRow2,      nativeRowOff: 0  },
      });
    } catch (_) {
      mc(ws, imgRow1, COL.B, imgRow2, COL.AH, "(단면도 없음)", F_BASE, ALIGN_CC, null, thinBorder());
    }
  } else {
    mc(ws, imgRow1, COL.B, imgRow2, COL.AH, "(단면도 없음)", F_BASE, ALIGN_CC, null, thinBorder());
  }

  const hdr = imgRow2 + 1;
  ws.getRow(hdr).height = 18;
  mc(ws, hdr, COL.B,  hdr, COL.M,  "기준안전율", F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hdr, COL.N,  hdr, COL.X,  "검토안전율", F_WHITE, ALIGN_CC, FILL_HEADER);
  mc(ws, hdr, COL.Y,  hdr, COL.AH, "판정",       F_WHITE, ALIGN_CC, FILL_HEADER);

  const dr     = hdr + 1;
  const fosStr = Number.isFinite(fos) ? fos.toFixed(3) : "—";
  ws.getRow(dr).height = 20;
  mc(ws, dr, COL.B,  dr, COL.M,  req,    F_BOLD, ALIGN_CC, FILL_DATA);
  mc(ws, dr, COL.N,  dr, COL.X,  fosStr, F_BOLD, ALIGN_CC, FILL_DATA);
  mc(ws, dr, COL.Y,  dr, COL.AH, judge,  F_BOLD, ALIGN_CC, FILL_DATA);

  return dr + 1;
}

// ─── 전체 보고서 생성 ─────────────────────────────────────────
export async function generateStructuralReport(options) {
  const EJ = getExcelJS();
  const {
    cases,             // [{ key, label, result, image }]
    materials,
    projectName, structureName, sectionName,
    canvasW = 900, canvasH = 280,
    customMaterials,   // { structure: [...], ground: [...], foundation: [...] } | null
  } = options;

  const wb = new EJ.Workbook();
  wb.creator  = "SLOPE/W 자동화 도구";
  wb.created  = new Date();
  wb.modified = new Date();

  const sheetName = `${structureName}(${sectionName}) 원호활동`.slice(0, 31);
  const ws = wb.addWorksheet(sheetName);

  // 열 너비: 전부 3
  for (let c = 1; c <= COL.AH + 2; c++) {
    ws.getColumn(c).width = COL_W;
  }

  // 기본 행 높이
  for (let r = 1; r <= 120; r++) ws.getRow(r).height = 18;

  // 페이지 설정: 페이지 나누기 미리보기 + 눈금선 숨김
  ws.views = [{ state: "pageBreakPreview", showGridLines: false }];
  // 가로 1페이지에 맞춤 (세로는 제한 없음)
  ws.pageSetup.paperSize   = 9; // A4
  ws.pageSetup.fitToPage   = true;
  ws.pageSetup.fitToWidth  = 1;
  ws.pageSetup.fitToHeight = 0;

  let cur = 1;

  // 헤더 (테두리 없음 → border: null)
  mc(ws, cur, COL.B, cur, COL.AH, `나. ${structureName} 기초지반 안정검토`, F_TITLE, ALIGN_LC, null, null);
  cur++;
  mc(ws, cur, COL.B, cur, COL.AH, `1. ${structureName}(${sectionName}) 기초지반 안정 검토`, F_TITLE, ALIGN_LC, null, null);
  cur++;
  mc(ws, cur, COL.B, cur, COL.AH, "  1.1. 원호활동 검토", F_TITLE, ALIGN_LC, null, null);
  cur++;

  mc(ws, cur, COL.B, cur, COL.AH, "1) 검토조건", F_BOLD, ALIGN_LC, null, null);
  cur++;

  mc(ws, cur, COL.B, cur, COL.AH, " 가) 사용재료 설계정수", F_BOLD, ALIGN_LC, null, null);
  cur++;

  let structure, ground, foundation;
  if (customMaterials) {
    structure  = customMaterials.structure  ?? [];
    ground     = customMaterials.ground     ?? [];
    foundation = customMaterials.foundation ?? [];
  } else {
    const normalized = materials.map(normalizeMat);
    ({ structure, ground } = splitMaterials(normalized));
    if (!structure.length) structure = normalized;
    foundation = [];
  }

  cur = writeMaterialTable(ws, cur, "사용재료 물성치", structure);
  cur++;

  if (ground.length) {
    mc(ws, cur, COL.B, cur, COL.AH, " 나) 원지반 설계정수", F_BOLD, ALIGN_LC, null, null);
    cur++;
    cur = writeMaterialTable(ws, cur, "원지반 물성치", ground);
    cur++;
  }

  if (foundation.length) {
    mc(ws, cur, COL.B, cur, COL.AH, " 다) 기초처리 설계정수", F_BOLD, ALIGN_LC, null, null);
    cur++;
    cur = writeMaterialTable(ws, cur, "기초처리 물성치", foundation);
    cur++;
  }

  mc(ws, cur, COL.B, cur, COL.AH, "2) 원호활동 검토결과 요약", F_BOLD, ALIGN_LC, null, null);
  cur++;
  cur = writeSummaryTable(ws, cur, cases);
  cur++;

  mc(ws, cur, COL.B, cur, COL.AH, "3) 원호활동 검토결과", F_BOLD, ALIGN_LC, null, null);
  cur++;

  for (const { key, label, result, image } of cases) {
    cur = await writeCaseDetail(wb, ws, key, label, result, image, cur, canvasW, canvasH);
    cur++;
  }

  // 인쇄 영역: A~AI 열, 사용된 마지막 행까지
  ws.pageSetup.printArea = `A1:AI${cur - 1}`;

  // ─── 편심하중 시트 추가 (옵션) ───────────────────────────────
  if (options.eccentric) {
    await generateEccentricSheet(wb, options.eccentric);
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ─── 템플릿 이미지 로더 (base64) ─────────────────────────────
async function loadTemplateImageBase64(filename) {
  try {
    const res = await fetch(`template/image/${filename}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf  = await res.arrayBuffer();
    const u8   = new Uint8Array(buf);
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode(...u8.subarray(i, Math.min(i + CHUNK, u8.length)));
    }
    return btoa(bin);
  } catch (e) {
    console.warn(`template image ${filename} load failed:`, e);
    return null;
  }
}


// ─── 편심하중 시트 생성 ───────────────────────────────────────
async function generateEccentricSheet(wb, opts) {
  const {
    structureName, sectionName,
    inputs,
    fos:    { eccentric_normal: fosN, eccentric_seismic: fosE },
    images: { eccentric_normal: imgN, eccentric_seismic: imgE },
  } = opts;

  const { B, D, gamma_sat, gamma_w, V_n, H_n, Mv_n, Mh_n, V_e, H_e, Mv_e, Mh_e } = inputs;
  const GAMMA_W = (Number.isFinite(gamma_w) && gamma_w > 0) ? gamma_w : 10.3;

  // 열 번호: 숨겨진 입력 영역 (수식 참조 대상)
  const COL_AM = 39, COL_AO = 41;          // AM:AO = 레이블 3열
  const COL_AP = 42, COL_AS = 45;          // AP:AS = 상시 4열
  const COL_AT = 46, COL_AW = 49;          // AT:AW = 지진시 4열

  // 수식 헬퍼
  const F = (formula) => ({ formula });

  // 템플릿 이미지 로드
  const [b64_1, b64_2, b64_3, b64_4, b64_5] = await Promise.all([
    loadTemplateImageBase64("image1.png"),
    loadTemplateImageBase64("image2.png"),
    loadTemplateImageBase64("image3.png"),
    loadTemplateImageBase64("image4.png"),
    loadTemplateImageBase64("image5.png"),
  ]);

  const sheetName = `${structureName}(${sectionName}) 편심하중`.slice(0, 31);
  const ws = wb.addWorksheet(sheetName);

  // 열 너비
  for (let c = 1; c <= COL.AI + 2; c++) ws.getColumn(c).width = COL_W;
  for (let c = COL_AM; c <= COL_AW; c++) ws.getColumn(c).width = 6.125;

  // 행 높이: 전체 18pt 통일, 19~34행은 23pt
  for (let r = 1; r <= 97; r++) ws.getRow(r).height = 18;
  for (let r = 19; r <= 34; r++) ws.getRow(r).height = 23;

  // 페이지 설정
  ws.views = [{ state: "pageBreakPreview", showGridLines: false }];
  ws.pageSetup.paperSize   = 9; // A4
  ws.pageSetup.fitToPage  = true;
  ws.pageSetup.fitToWidth = 1;
  ws.pageSetup.fitToHeight = 0;
  ws.pageSetup.printArea = "A1:AI95";

  // ── AM 검증 테이블 (rows 18-34) ─────────────────────────────
  // Row 18: γsat 입력
  mc(ws, 18, COL_AM, 18, 43, gamma_sat, F_RED, { horizontal: "left", vertical: "middle" }, null, { bottom: BORDER_THIN });
  ws.getCell(18, COL_AM).numFmt = '"• 사석 포화단위중량 = "0.0_ "kN/㎥"';

  // Row 19: 헤더
  mc(ws, 19, COL_AM, 19, COL_AO, "구  분",  F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 19, COL_AP, 19, COL_AS, "상시",    F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 19, COL_AT, 19, COL_AW, "지진시",  F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());

  // Rows 20-23: 하중 입력
  const FMT_KN = "#,##0.00_);[Red]\\(#,##0.00\\)";
  function amDataRow(r, label, valN, valE, fmt) {
    mc(ws, r, COL_AM, r, COL_AO, label, F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, r, COL_AP, r, COL_AS, valN,  F_RED,  ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, r, COL_AT, r, COL_AW, valE,  F_RED,  ALIGN_CC, FILL_DATA, thinBorder());
    if (fmt) { ws.getCell(r, COL_AP).numFmt = fmt; ws.getCell(r, COL_AT).numFmt = fmt; }
  }
  amDataRow(20, "연직력(ΣV, kN/m)",  V_n,  V_e,  FMT_KN);
  amDataRow(21, "수평력(ΣH, kN/m)",  H_n,  H_e,  FMT_KN);
  amDataRow(22, "저항모멘트(ΣMv)",   Mv_n, Mv_e, FMT_KN);
  amDataRow(23, "전도모멘트(ΣMh)",   Mh_n, Mh_e, FMT_KN);

  // Row 24: X = (Mv-Mh)/V
  mc(ws, 24, COL_AM, 24, COL_AO, "X", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 24, COL_AP, 24, COL_AS, F("ROUND((AP22-AP23)/AP20,2)"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 24, COL_AT, 24, COL_AW, F("ROUND((AT22-AT23)/AT20,2)"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());

  // Row 26: 두 번째 헤더
  mc(ws, 26, COL_AM, 26, COL_AO, "구 분",  F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 26, COL_AP, 26, COL_AS, "상시",   F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 26, COL_AT, 26, COL_AW, "지진시", F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());

  // Rows 27-29: 모멘트/연직력 재참조
  function amFmtRow(r, label, fN, fE, fmt, font) {
    mc(ws, r, COL_AM, r, COL_AO, label, F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, r, COL_AP, r, COL_AS, fN,  font ?? F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, r, COL_AT, r, COL_AW, fE,  font ?? F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
    if (fmt) { ws.getCell(r, COL_AP).numFmt = fmt; ws.getCell(r, COL_AT).numFmt = fmt; }
  }
  amFmtRow(27, "저항모멘트(ΣMv)", F("AP22"), F("AT22"), FMT_KN);
  amFmtRow(28, "전도모멘트(ΣMh)", F("AP23"), F("AT23"), FMT_KN);
  amFmtRow(29, "연직력(ΣV)",      F("AP20"), F("AT20"), FMT_KN);

  // Rows 30-32: b', 2b', q
  amFmtRow(30, "b'",   F("ROUND((AP27-AP28)/AP29,2)"), F("ROUND((AT27-AT28)/AT29,2)"), "0.00");
  amFmtRow(31, "2b'",  F("AP30*2"),                    F("AT30*2"),                    "0.00");
  amFmtRow(32, "q",    F("ROUND(AP29/AP31,2)"),         F("ROUND(AT29/AT31,2)"),        "0.00");

  // Row 33: 확인 (q at M61/X61)
  amFmtRow(33, "확인", F("M61"), F("X61"), "#,##0.00_ ");

  // Row 34: O.K / N.G 판정
  mc(ws, 34, COL_AM, 34, COL_AO, "검 증", F_BASE,      ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 34, COL_AP, 34, COL_AS, F('IF(ROUND(AP32,1)=ROUND(AP33,1),"O.K","N.G")'), F_BOLD_BLUE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 34, COL_AT, 34, COL_AW, F('IF(ROUND(AT32,1)=ROUND(AT33,1),"O.K","N.G")'), F_BOLD_BLUE, ALIGN_CC, FILL_DATA, thinBorder());

  // ── 헤더 ──────────────────────────────────────────────────
  mc(ws, 1, COL.B, 1, COL.AH, `나. ${structureName} 기초지반 안정검토`,        F_TITLE, ALIGN_LC, null, null);
  mc(ws, 2, COL.B, 2, COL.AH, `1. ${structureName}(${sectionName}) 기초지반 안정 검토`, F_TITLE, ALIGN_LC, null, null);
  mc(ws, 3, COL.B, 3, COL.AH, "  1.1. 지반 반력 산정",                         F_TITLE, ALIGN_LC, null, null);
  mc(ws, 4, COL.C, 4, COL.AH, "1) 검토개요",                                   F_BOLD,  ALIGN_LC, null, null);

  // ── 1) 검토개요 이미지 (rows 5-14) ────────────────────────
  const IMG12_ROW1 = 5, IMG12_ROW2 = 14;
  for (let c = COL.C; c <= COL.Q; c++) {
    ws.getCell(IMG12_ROW1, c).border = { ...(ws.getCell(IMG12_ROW1, c).border || {}), top:    BORDER_THIN };
    ws.getCell(IMG12_ROW2, c).border = { ...(ws.getCell(IMG12_ROW2, c).border || {}), bottom: BORDER_THIN };
  }
  for (let c = COL.R; c <= COL.AH; c++) {
    ws.getCell(IMG12_ROW1, c).border = { ...(ws.getCell(IMG12_ROW1, c).border || {}), top:    BORDER_THIN };
    ws.getCell(IMG12_ROW2, c).border = { ...(ws.getCell(IMG12_ROW2, c).border || {}), bottom: BORDER_THIN };
  }
  for (let r = IMG12_ROW1; r <= IMG12_ROW2; r++) {
    ws.getCell(r, COL.C).border  = { ...(ws.getCell(r, COL.C).border  || {}), left:  BORDER_THIN };
    ws.getCell(r, COL.Q).border  = { ...(ws.getCell(r, COL.Q).border  || {}), right: BORDER_THIN };
    ws.getCell(r, COL.R).border  = { ...(ws.getCell(r, COL.R).border  || {}), left:  BORDER_THIN };
    ws.getCell(r, COL.AH).border = { ...(ws.getCell(r, COL.AH).border || {}), right: BORDER_THIN };
  }

  function addImg(b64, ext, r1, c1, r2, c2) {
    if (!b64) return;
    const id = wb.addImage({ base64: b64, extension: ext ?? "png" });
    ws.addImage(id, {
      tl: { nativeCol: c1 - 1, nativeColOff: 0, nativeRow: r1 - 1, nativeRowOff: 0 },
      br: { nativeCol: c2,     nativeColOff: 0, nativeRow: r2,     nativeRowOff: 0 },
    });
  }

  // IMG12 행 높이: 열 너비 기준 비율 유지 (img1: 15열, img2: 17열 중 큰 값)
  {
    const rows = IMG12_ROW2 - IMG12_ROW1 + 1;
    const d1 = getPngDims(b64_1), d2 = getPngDims(b64_2);
    const ht = Math.max(
      d1 ? imgRowHt(COL.Q  - COL.C  + 1, rows, d1.w, d1.h) : 18,
      d2 ? imgRowHt(COL.AH - COL.R  + 1, rows, d2.w, d2.h) : 18
    );
    for (let r = IMG12_ROW1; r <= IMG12_ROW2; r++) ws.getRow(r).height = ht;
  }
  addImg(b64_1, "png", IMG12_ROW1, COL.C,  IMG12_ROW2, COL.Q);
  addImg(b64_2, "png", IMG12_ROW1, COL.R,  IMG12_ROW2, COL.AH);

  // ── Row 15: 스페이서 / Row 16: 2) 기초 및 하중조건 ──────
  mc(ws, 16, COL.C, 16, COL.AH, "2) 기초 및 하중조건", F_BOLD, ALIGN_LC, null, null);

  // Row 17: 기초폭, 마운드 두께
  ws.getCell(17, COL.D).value  = "• 기초폭 (B)";
  ws.getCell(17, COL.D).font   = F_BASE;
  ws.getCell(17, COL.J).value  = "=";
  ws.getCell(17, COL.J).font   = F_BASE;
  mc(ws, 17, COL.K, 17, COL.L, B, F_RED, { horizontal: "right", vertical: "middle" }, null, null);
  ws.getCell(17, COL.K).numFmt = "0.00_ ";
  ws.getCell(17, COL.M).value  = "m";
  ws.getCell(17, COL.M).font   = F_BASE;
  ws.getCell(17, COL.R).value  = "• 기초사석 마운드 두께(D)";
  ws.getCell(17, COL.R).font   = F_BASE;
  ws.getCell(17, COL.AA).value = "=";
  ws.getCell(17, COL.AA).font  = F_BASE;
  mc(ws, 17, COL.AB, 17, COL.AC, D, F_RED, { horizontal: "right", vertical: "middle" }, null, null);
  ws.getCell(17, COL.AB).numFmt = "0.00_ ";
  ws.getCell(17, COL.AD).value = "m";
  ws.getCell(17, COL.AD).font  = F_BASE;

  // Row 18: γW, γ'
  ws.getCell(18, COL.D).value  = "• 물의 단위중량(γW)";
  ws.getCell(18, COL.D).font   = F_BASE;
  ws.getCell(18, COL.J).value  = "=";
  ws.getCell(18, COL.J).font   = F_BASE;
  mc(ws, 18, COL.K, 18, COL.L, GAMMA_W, F_BASE, { horizontal: "right", vertical: "middle" }, null, { bottom: BORDER_THIN });
  ws.getCell(18, COL.K).numFmt = "0.0_ ";
  ws.getCell(18, COL.M).value  = "kN/㎥";
  ws.getCell(18, COL.M).font   = F_BASE;
  ws.getCell(18, COL.R).value  = "• 사석 수중단위중량(γ'₂)";
  ws.getCell(18, COL.R).font   = F_BASE;
  ws.getCell(18, COL.Z).value  = "=";
  ws.getCell(18, COL.Z).font   = F_BASE;
  mc(ws, 18, COL.AA, 18, COL.AB, F("AM18-K18"), F_BASE, { horizontal: "right", vertical: "middle" }, null, null);
  ws.getCell(18, COL.AA).numFmt = "0.00_ ";
  ws.getCell(18, COL.AC).value = "kN/㎥";
  ws.getCell(18, COL.AC).font  = F_BASE;

  // Rows 19-26: 하중 테이블
  function dataRow(r, labelColA, labelColB, label, valN, valE) {
    mc(ws, r, labelColA, r, labelColB, label, F_BASE,  ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, r, COL.M,     r, COL.W,    valN,  F_BASE,  ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, r, COL.X,     r, COL.AH,   valE,  F_BASE,  ALIGN_CC, FILL_DATA, thinBorder());
  }

  mc(ws, 19, COL.C, 19, COL.L, "구  분",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 19, COL.M, 19, COL.W, "상시",    F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 19, COL.X, 19, COL.AH,"지진시",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());

  dataRow(20, COL.C, COL.L, "수직력(ΣV, kN/m)", F("AP20"), F("AT20"));
  ws.getCell(20, COL.M).numFmt = FMT_KN; ws.getCell(20, COL.X).numFmt = FMT_KN;
  dataRow(21, COL.C, COL.L, "수평력(ΣH, kN/m)", F("AP21"), F("AT21"));
  ws.getCell(21, COL.M).numFmt = FMT_KN; ws.getCell(21, COL.X).numFmt = FMT_KN;

  // 편심 e (2행 병합 레이블)
  mc(ws, 22, COL.C, 23, COL.L, "기초저면에 대한 편심(e, m)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 22, COL.M, 22, COL.W, F("ROUND($K$17/2-AP24,2)"),   F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(22, COL.M).numFmt = FMT_KN;
  mc(ws, 22, COL.X, 22, COL.AH, F("ROUND($K$17/2-AT24,2)"),  F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(22, COL.X).numFmt = FMT_KN;
  mc(ws, 23, COL.M, 23, COL.W,  F('IF(M22<$K$17/6,"사다리꼴분포","삼각형분포")'), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 23, COL.X, 23, COL.AH, F('IF(X22<$K$17/6,"사다리꼴분포","삼각형분포")'), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());

  // 하중분포 p1/p2 (2행 병합 레이블)
  mc(ws, 24, COL.C, 25, COL.G, "하중분포",   F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 24, COL.H, 24, COL.L, "p1(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 25, COL.H, 25, COL.L, "p2(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 24, COL.M, 24, COL.W,
     F('ROUND(IF(M23="삼각형분포",(2/3)*M20/($K$17*0.5-M22),IF(M23="사다리꼴분포",(M20/$K$17)*(1+(6*M22/$K$17)))),2)'),
     F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(24, COL.M).numFmt = "#,##0.00_ ";
  mc(ws, 24, COL.X, 24, COL.AH,
     F('ROUND(IF(X23="삼각형분포",(2/3)*X20/($K$17*0.5-X22),IF(X23="사다리꼴분포",(X20/$K$17)*(1+(6*X22/$K$17)))),2)'),
     F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(24, COL.X).numFmt = "#,##0.00_ ";
  mc(ws, 25, COL.M, 25, COL.W,
     F('ROUND(IF(M23="삼각형분포",0,IF(M23="사다리꼴분포",(M20/$K$17)*(1-(6*M22/$K$17)))),2)'),
     F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(25, COL.M).numFmt = "#,##0.00_ ";
  mc(ws, 25, COL.X, 25, COL.AH,
     F('ROUND(IF(X23="삼각형분포",0,IF(X23="사다리꼴분포",(X20/$K$17)*(1-(6*X22/$K$17)))),2)'),
     F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(25, COL.X).numFmt = "#,##0.00_ ";

  dataRow(26, COL.C, COL.L, "하중분포폭(b)",
     F("IF(M22>($K$17/6),3*($K$17/2-M22),$K$17)"),
     F("IF(X22>($K$17/6),3*($K$17/2-X22),$K$17)"));
  ws.getCell(26, COL.M).numFmt = "0.00_ "; ws.getCell(26, COL.X).numFmt = "0.00_ ";

  // ── 3) 상부구조물에 대한 지반반력 산정 ──────────────────
  mc(ws, 28, COL.C, 28, COL.AH, "3) 상부구조물에 대한 지반반력 산정", F_BOLD, ALIGN_LC, null, null);

  mc(ws, 29, COL.C, 29, COL.L, "구  분",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 29, COL.M, 29, COL.W, "상시",    F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 29, COL.X, 29, COL.AH,"지진시",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  dataRow(30, COL.C, COL.L, "편심경사각 ( α, °)",
     F("DEGREES(ATAN(M21/M20))"),
     F("DEGREES(ATAN(X21/X20))"));
  ws.getCell(30, COL.M).numFmt = "0.00_ "; ws.getCell(30, COL.X).numFmt = "0.00_ ";
  dataRow(31, COL.C, COL.L, "합력의 분포폭( L, m)",
     F("ROUND(M26+$AB$17*(TAN(RADIANS(30+M30))+TAN(RADIANS(30-M30))),2)"),
     F("ROUND(X26+$AB$17*(TAN(RADIANS(30+X30))+TAN(RADIANS(30-X30))),2)"));
  ws.getCell(31, COL.M).numFmt = "0.00_ "; ws.getCell(31, COL.X).numFmt = "0.00_ ";

  // 지반반력 p1'/p2' (2행 병합 레이블)
  mc(ws, 32, COL.C, 33, COL.G, "지반반력",    F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 32, COL.H, 32, COL.L, "p1'(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 33, COL.H, 33, COL.L, "p2'(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 32, COL.M, 32, COL.W,  F("(M26/M31)*M24+$AA$18*$AB$17"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(32, COL.M).numFmt = "0.00_ ";
  mc(ws, 32, COL.X, 32, COL.AH, F("(X26/X31)*X24+$AA$18*$AB$17"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(32, COL.X).numFmt = "0.00_ ";
  mc(ws, 33, COL.M, 33, COL.W,  F("(M26/M31)*M25+$AA$18*$AB$17"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(33, COL.M).numFmt = "0.00_ ";
  mc(ws, 33, COL.X, 33, COL.AH, F("(X26/X31)*X25+$AA$18*$AB$17"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(33, COL.X).numFmt = "0.00_ ";

  // ── 1.2 섹션 헤더 ─────────────────────────────────────
  mc(ws, 35, COL.B, 35, COL.AH, "  1.2. 편심경사하중법(Bishop법)에 의한 지지력 검토", F_TITLE, ALIGN_LC, null, null);
  mc(ws, 36, COL.C, 36, COL.AH, "1) 검토개요", F_BOLD, ALIGN_LC, null, null);

  // ── image3: 검토 메인 다이어그램 (rows 37-43) ─────────
  const IMG3_R1 = 37, IMG3_R2 = 43;
  for (let c = COL.C; c <= COL.AH; c++) {
    ws.getCell(IMG3_R1, c).border = { ...(ws.getCell(IMG3_R1, c).border || {}), top:    BORDER_THIN };
    ws.getCell(IMG3_R2, c).border = { ...(ws.getCell(IMG3_R2, c).border || {}), bottom: BORDER_THIN };
  }
  for (let r = IMG3_R1; r <= IMG3_R2; r++) {
    ws.getCell(r, COL.C).border  = { ...(ws.getCell(r, COL.C).border  || {}), left:  BORDER_THIN };
    ws.getCell(r, COL.AH).border = { ...(ws.getCell(r, COL.AH).border || {}), right: BORDER_THIN };
  }
  // IMG3 행 높이: 열 너비 기준 비율 유지 (C:AH = 32열)
  {
    const d3 = getPngDims(b64_3);
    if (d3) {
      const ht = imgRowHt(COL.AH - COL.C + 1, IMG3_R2 - IMG3_R1 + 1, d3.w, d3.h);
      for (let r = IMG3_R1; r <= IMG3_R2; r++) ws.getRow(r).height = ht;
    }
  }
  addImg(b64_3, "png", IMG3_R1, COL.C, IMG3_R2, COL.AH);

  // ── 지반반력 분포 이미지 (rows 44-47) ────────────────
  mc(ws, 44, COL.C, 44, COL.R,  "지반반력 사다리꼴 분포", F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 44, COL.S, 44, COL.AH, "지반반력 삼각형 분포",   F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());

  const IMG45_R1 = 45, IMG45_R2 = 47;
  for (let c = COL.C; c <= COL.R; c++) {
    ws.getCell(IMG45_R1, c).border = { ...(ws.getCell(IMG45_R1, c).border || {}), top:    BORDER_THIN };
    ws.getCell(IMG45_R2, c).border = { ...(ws.getCell(IMG45_R2, c).border || {}), bottom: BORDER_THIN };
  }
  for (let c = COL.S; c <= COL.AH; c++) {
    ws.getCell(IMG45_R1, c).border = { ...(ws.getCell(IMG45_R1, c).border || {}), top:    BORDER_THIN };
    ws.getCell(IMG45_R2, c).border = { ...(ws.getCell(IMG45_R2, c).border || {}), bottom: BORDER_THIN };
  }
  for (let r = IMG45_R1; r <= IMG45_R2; r++) {
    ws.getCell(r, COL.C).border  = { ...(ws.getCell(r, COL.C).border  || {}), left:  BORDER_THIN };
    ws.getCell(r, COL.R).border  = { ...(ws.getCell(r, COL.R).border  || {}), right: BORDER_THIN };
    ws.getCell(r, COL.S).border  = { ...(ws.getCell(r, COL.S).border  || {}), left:  BORDER_THIN };
    ws.getCell(r, COL.AH).border = { ...(ws.getCell(r, COL.AH).border || {}), right: BORDER_THIN };
  }
  // IMG45 행 높이: 열 너비 기준 비율 유지 (img4: 16열, img5: 16열 중 큰 값)
  {
    const rows = IMG45_R2 - IMG45_R1 + 1;
    const d4 = getPngDims(b64_4), d5 = getPngDims(b64_5);
    const ht = Math.max(
      d4 ? imgRowHt(COL.R  - COL.C + 1, rows, d4.w, d4.h) : 18,
      d5 ? imgRowHt(COL.AH - COL.S + 1, rows, d5.w, d5.h) : 18
    );
    for (let r = IMG45_R1; r <= IMG45_R2; r++) ws.getRow(r).height = ht;
  }
  addImg(b64_4, "png", IMG45_R1, COL.C,  IMG45_R2, COL.R);
  addImg(b64_5, "png", IMG45_R1, COL.S,  IMG45_R2, COL.AH);

  // ── Row 48: 스페이서 / Row 49: 2) 환산등분포 하중 ────
  mc(ws, 49, COL.C, 49, COL.AH, "2) 환산등분포 하중", F_BOLD, ALIGN_LC, null, null);

  ws.getCell(50, COL.C).value = "•";
  ws.getCell(50, COL.D).value = "기초폭 (B) =";
  ws.getCell(50, COL.D).font  = F_BASE;
  mc(ws, 50, COL.H, 50, COL.I, F("K17"), F_BASE, { horizontal: "right", vertical: "middle" }, null, null);
  ws.getCell(50, COL.H).numFmt = "0.00_ ";
  ws.getCell(50, COL.J).value = "m";
  ws.getCell(50, COL.J).font  = F_BASE;

  ws.getCell(51, COL.C).value = "•";
  ws.getCell(51, COL.D).value = "하중조건";
  ws.getCell(51, COL.D).font  = F_BASE;

  mc(ws, 52, COL.C, 52, COL.L, "구  분",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 52, COL.M, 52, COL.W, "상시",    F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 52, COL.X, 52, COL.AH,"지진시",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());

  mc(ws, 53, COL.C, 54, COL.G, "하중분포",   F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 53, COL.H, 53, COL.L, "p1(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 54, COL.H, 54, COL.L, "p2(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 53, COL.M, 53, COL.W,  F("M24"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(53, COL.M).numFmt = "0.00_ ";
  mc(ws, 53, COL.X, 53, COL.AH, F("X24"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(53, COL.X).numFmt = "0.00_ ";
  mc(ws, 54, COL.M, 54, COL.W,  F("M25"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(54, COL.M).numFmt = "0.00_ ";
  mc(ws, 54, COL.X, 54, COL.AH, F("X25"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(54, COL.X).numFmt = "0.00_ ";

  mc(ws, 55, COL.C, 56, COL.L, "기초저면에 대한 편심(e, m)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 55, COL.M, 55, COL.W,  F("M22"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(55, COL.M).numFmt = "0.00_ ";
  mc(ws, 55, COL.X, 55, COL.AH, F("X22"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(55, COL.X).numFmt = "0.00_ ";
  mc(ws, 56, COL.M, 56, COL.W,  F('IF(M55<$H$50/6,"사다리꼴분포","삼각형분포")'), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 56, COL.X, 56, COL.AH, F('IF(X55<$H$50/6,"사다리꼴분포","삼각형분포")'), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());

  mc(ws, 57, COL.C, 57, COL.L, "하중분포폭(b)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 57, COL.M, 57, COL.W,  F("M26"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(57, COL.M).numFmt = "0.00_ ";
  mc(ws, 57, COL.X, 57, COL.AH, F("X26"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(57, COL.X).numFmt = "0.00_ ";

  ws.getCell(59, COL.C).value = "•";
  ws.getCell(59, COL.D).value = "환산등분포하중";
  ws.getCell(59, COL.D).font  = F_BASE;

  mc(ws, 60, COL.C, 60, COL.L, "구  분",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 60, COL.M, 60, COL.W, "상시",    F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
  mc(ws, 60, COL.X, 60, COL.AH,"지진시",  F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());

  mc(ws, 61, COL.C, 61, COL.L, "q(kN/㎡)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 61, COL.M, 61, COL.W,
     F("IF(M55<$H$50/6,(M53+M54)*$H$50/(4*M63),(M53*M57/(4*M63)))"),
     F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(61, COL.M).numFmt = "#,##0.00_ ";
  mc(ws, 61, COL.X, 61, COL.AH,
     F("IF(X55<$H$50/6,(X53+X54)*$H$50/(4*X63),(X53*X57/(4*X63)))"),
     F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(61, COL.X).numFmt = "#,##0.00_ ";

  mc(ws, 62, COL.C, 62, COL.L, "H(kN/m)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 62, COL.M, 62, COL.W,  F("M21"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(62, COL.M).numFmt = "#,##0.00_ ";
  mc(ws, 62, COL.X, 62, COL.AH, F("X21"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(62, COL.X).numFmt = "#,##0.00_ ";

  mc(ws, 63, COL.C, 63, COL.L, "b'(m)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 63, COL.M, 63, COL.W,  F("($H$50/2-M55)"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(63, COL.M).numFmt = "#,##0.00_ ";
  mc(ws, 63, COL.X, 63, COL.AH, F("($H$50/2-X55)"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(63, COL.X).numFmt = "#,##0.00_ ";

  mc(ws, 64, COL.C, 64, COL.L, "2b'(m)", F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  mc(ws, 64, COL.M, 64, COL.W,  F("M63*2"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(64, COL.M).numFmt = "#,##0.00_ ";
  mc(ws, 64, COL.X, 64, COL.AH, F("X63*2"), F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  ws.getCell(64, COL.X).numFmt = "#,##0.00_ ";

  // ── 3) 편심경사하중에 의한 지지력 검토결과 ──────────
  mc(ws, 66, COL.C, 66, COL.AH, "3) 편심경사하중에 의한 지지력 검토결과", F_BOLD, ALIGN_LC, null, null);

  // 상시 케이스
  mc(ws, 67, COL.C, 67, COL.AH, "상시", F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());

  // GSZ 이미지 영역 (rows 68-78, 11행)
  const GSZ_ROWS  = 11;
  const GSZ_N_R1  = 68, GSZ_N_R2 = 68 + GSZ_ROWS - 1;  // 68-78
  const GSZ_E_R1  = 83, GSZ_E_R2 = 83 + GSZ_ROWS - 1;  // 83-93

  function writeGszBlock(r1, r2, imgDataUrl, req, fos, reqRow, valRow) {
    for (let c = COL.C; c <= COL.AH; c++) {
      ws.getCell(r1, c).border = { ...(ws.getCell(r1, c).border || {}), top:    BORDER_THIN };
      ws.getCell(r2, c).border = { ...(ws.getCell(r2, c).border || {}), bottom: BORDER_THIN };
    }
    for (let r = r1; r <= r2; r++) {
      ws.getCell(r, COL.C).border  = { ...(ws.getCell(r, COL.C).border  || {}), left:  BORDER_THIN };
      ws.getCell(r, COL.AH).border = { ...(ws.getCell(r, COL.AH).border || {}), right: BORDER_THIN };
    }
    if (imgDataUrl) {
      try {
        const b64 = imgDataUrl.replace(/^data:image\/\w+;base64,/, "");
        // GSZ 행 높이: 열 너비 기준 비율 유지 (C:AH = 32열)
        const dims = getPngDims(b64);
        if (dims) {
          const ht = imgRowHt(COL.AH - COL.C + 1, r2 - r1 + 1, dims.w, dims.h);
          for (let r = r1; r <= r2; r++) ws.getRow(r).height = ht;
        }
        const id  = wb.addImage({ base64: b64, extension: "png" });
        const OFF = 3 * 9525;
        ws.addImage(id, {
          tl: { nativeCol: COL.C - 1, nativeColOff: OFF, nativeRow: r1 - 1, nativeRowOff: OFF },
          br: { nativeCol: COL.AH,    nativeColOff: 0,   nativeRow: r2,     nativeRowOff: 0  },
        });
      } catch (_) {}
    }

    mc(ws, reqRow, COL.C,  reqRow, COL.N,  "기준안전율", F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
    mc(ws, reqRow, COL.O,  reqRow, COL.Z,  "검토안전율", F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());
    mc(ws, reqRow, COL.AA, reqRow, COL.AH, "판정",       F_WHITE, ALIGN_CC, FILL_HEADER, thinBorder());

    const reqStr = Number.isFinite(req) ? req.toFixed(1) : String(req);
    const fosStr = Number.isFinite(fos) ? fos.toFixed(3) : "—";
    const judge  = judgeOkNg(fos, req);
    mc(ws, valRow, COL.C,  valRow, COL.N,  reqStr,  F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, valRow, COL.O,  valRow, COL.Z,  fosStr,  F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
    mc(ws, valRow, COL.AA, valRow, COL.AH, judge,   F_BASE, ALIGN_CC, FILL_DATA, thinBorder());
  }

  writeGszBlock(GSZ_N_R1, GSZ_N_R2, imgN, 1.2, fosN, 79, 80);

  // 지진시 케이스 (row 81: spacer, row 82: 지진시 헤더)
  mc(ws, 82, COL.C, 82, COL.AH, "지진시", F_BOLD, ALIGN_CC, FILL_HEADER, thinBorder());
  writeGszBlock(GSZ_E_R1, GSZ_E_R2, imgE, 1.0, fosE, 94, 95);
}

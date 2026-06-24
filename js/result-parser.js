/**
 * result-parser.js
 * .gsz ZIP에서 해석별 FOS + 임계 슬립 기하를 추출한다.
 *
 * 디렉토리 구조:
 *   <analysisDir>/001/lambdafos_XXXX.csv  → FOS + 임계 슬립 ID
 *   <analysisDir>/001/slip_surface.csv    → 슬립별 CenterX/Y/Radius
 *   <analysisDir>/001/slice_XXXX.csv      → 임계 슬립면 좌표 (GeoStudio 결과 그대로)
 */

/**
 * CSV 텍스트를 [{헤더:값}] 배열로 파싱 (BOM·CRLF 처리 포함).
 */
function parseCsv(text) {
  // BOM 제거 후 줄 분리
  const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = clean.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const header = lines[0]?.split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(",");
    const obj = {};
    header.forEach((h, j) => (obj[h] = cells[j]?.trim() ?? ""));
    rows.push(obj);
  }
  return rows;
}

/**
 * ZIP 내 파일명이 pattern에 매칭되는 첫 번째 항목을 반환.
 * pattern: 정규식
 */
function findZipFile(zip, pattern) {
  return Object.keys(zip.files).find(
    (name) => !zip.files[name].dir && pattern.test(name),
  );
}

/**
 * 특정 해석 디렉토리에서 lambdafos_*.csv를 읽어
 * { slipId, fos } 를 반환한다.
 *
 * @param {Object} zip - JSZip 인스턴스
 * @param {string} analysisDir - 예) "1.1 지반개량_상시(49.8)"
 * @returns {Promise<{slipId:number, fos:number}|null>}
 */
export async function parseCriticalFOS(zip, analysisDir) {
  // lambdafos_XXXX.csv 탐색 (하위 001/ 포함)
  const prefix = analysisDir.endsWith("/") ? analysisDir : analysisDir + "/";
  const lambdaPath = findZipFile(
    zip,
    new RegExp(`^${escapeRegex(prefix)}.*lambdafos_(\\d+)\\.csv$`, "i"),
  );
  if (!lambdaPath) return null;

  const slipIdMatch = lambdaPath.match(/lambdafos_(\d+)\.csv$/i);
  const slipId = slipIdMatch ? parseInt(slipIdMatch[1], 10) : NaN;

  const text = await zip.file(lambdaPath).async("string");
  const rows = parseCsv(text);
  if (!rows.length) return null;

  // FOSByMoment 최솟값 행 → 임계 FOS
  // (보통 1행뿐이지만 복수 Lambda 행이 있을 수 있음)
  let minFos = Infinity;
  for (const r of rows) {
    const v = parseFloat(r["FOSByMoment"] ?? r["FOSByForce"] ?? "");
    if (Number.isFinite(v) && v < minFos) minFos = v;
  }
  if (!Number.isFinite(minFos)) return null;

  return { slipId, fos: minFos };
}

/**
 * slip_surface.csv에서 slipId에 해당하는 행을 찾아
 * { centerX, centerY, radius } 를 반환한다.
 */
export async function parseCriticalSlipGeometry(zip, analysisDir, slipId) {
  const prefix = analysisDir.endsWith("/") ? analysisDir : analysisDir + "/";
  const slipPath = findZipFile(
    zip,
    new RegExp(`^${escapeRegex(prefix)}.*slip_surface\\.csv$`, "i"),
  );
  if (!slipPath) return null;

  const text = await zip.file(slipPath).async("string");
  const rows = parseCsv(text);
  if (!rows.length) return null;

  // slipId 행 탐색
  const target = rows.find((r) => parseInt(r["SlipNum"] ?? "", 10) === slipId);
  if (!target) return null;

  const centerX = parseFloat(target["SlipCenterX"] ?? "");
  const centerY = parseFloat(target["SlipCenterY"] ?? "");
  const radius  = parseFloat(target["SlipRadius"]  ?? "");
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(radius)) return null;

  return { centerX, centerY, radius };
}

/**
 * slice_{slipId}.csv 에서 임계 슬립면 프로파일 [{x,y}] 를 추출한다.
 * GeoStudio가 계산·저장한 좌표를 그대로 사용한다 (interslice_*.csv 는 제외).
 *
 * 지원 형식:
 *   A) SliceNum,X,Y,XLeft,XRight,YBotLeft,YBotRight,... → YBotLeft/Right 연결
 *   B) IntersliceNum,X,Y,...                          → X,Y 열 직접 사용
 */
export async function parseCriticalSlipProfile(zip, analysisDir, slipId) {
  const prefix = analysisDir.endsWith("/") ? analysisDir : analysisDir + "/";
  const suffix = `slice_${slipId}.csv`;
  const slicePath = Object.keys(zip.files).find(
    (name) =>
      !zip.files[name].dir &&
      name.startsWith(prefix) &&
      name.endsWith(suffix) &&
      !name.includes("interslice_"),
  );
  if (!slicePath) return null;

  const text = await zip.file(slicePath).async("string");
  const rows = parseCsv(text);
  if (!rows.length) return null;

  const keys = Object.keys(rows[0]);
  const hasSliceBounds =
    keys.includes("XLeft") &&
    keys.includes("YBotLeft") &&
    keys.includes("XRight") &&
    keys.includes("YBotRight");

  if (hasSliceBounds) {
    const profile = [];
    for (const r of rows) {
      const xl  = parseFloat(r["XLeft"]     ?? "");
      const ybl = parseFloat(r["YBotLeft"]  ?? "");
      const xr  = parseFloat(r["XRight"]    ?? "");
      const ybr = parseFloat(r["YBotRight"] ?? "");
      if (!Number.isFinite(xl) || !Number.isFinite(ybl)) continue;
      if (!profile.length) profile.push({ x: xl, y: ybl });
      if (Number.isFinite(xr) && Number.isFinite(ybr)) {
        profile.push({ x: xr, y: ybr });
      }
    }
    return profile.length >= 2 ? profile : null;
  }

  if (!keys.includes("X") || !keys.includes("Y")) return null;

  const profile = [];
  for (const r of rows) {
    const x = parseFloat(r["X"] ?? "");
    const y = parseFloat(r["Y"] ?? "");
    if (Number.isFinite(x) && Number.isFinite(y)) profile.push({ x, y });
  }
  return profile.length >= 2 ? profile : null;
}

/**
 * ZIP 전체를 스캔하여 해석 디렉토리 목록을 구한다.
 * lambdafos_*.csv 가 있는 최상위 디렉토리만 수집한다.
 * 반환: string[] (디렉토리 경로, 마지막 "/" 미포함)
 */
export function listAnalysisDirs(zip) {
  const dirs = new Set();
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    const m = name.match(/^(.+?)\/(?:001\/)?lambdafos_\d+\.csv$/i);
    if (m) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

/**
 * ZIP에서 루트 XML(NO.17.xml 등)을 찾아 파싱한다.
 * 루트: 해석 디렉토리 바깥의 첫 번째 XML
 */
export async function parseRootXml(zip) {
  // 슬래시 없는(루트 수준) XML 파일 우선
  const rootXml = Object.keys(zip.files).find(
    (n) => !zip.files[n].dir && /^[^/]+\.xml$/i.test(n),
  );
  if (!rootXml) return null;
  const text = await zip.file(rootXml).async("string");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) return null;
  return doc;
}

/**
 * 전체 해석 결과 일괄 파싱.
 *
 * @param {Object} zip - JSZip 인스턴스
 * @returns {Promise<Array<{
 *   dir: string,
 *   analysisName: string,
 *   fos: number,
 *   slipId: number,
 *   centerX: number,
 *   centerY: number,
 *   radius: number,
 *   profile: Array<{x:number,y:number}>|null
 * }>>}
 */
export async function parseAllResults(zip) {
  const dirs = listAnalysisDirs(zip);
  const results = [];

  for (const dir of dirs) {
    const fosData = await parseCriticalFOS(zip, dir);
    if (!fosData) continue;

    const [geoData, profile] = await Promise.all([
      parseCriticalSlipGeometry(zip, dir, fosData.slipId),
      parseCriticalSlipProfile(zip, dir, fosData.slipId),
    ]);
    const name = dir.split("/").pop() || dir; // 마지막 경로 세그먼트

    results.push({
      dir,
      analysisName: name,
      fos: fosData.fos,
      slipId: fosData.slipId,
      centerX: geoData?.centerX ?? NaN,
      centerY: geoData?.centerY ?? NaN,
      radius:  geoData?.radius  ?? NaN,
      profile: profile ?? null,
    });
  }

  return results;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

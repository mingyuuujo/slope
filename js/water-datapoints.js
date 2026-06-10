import {
  findSlopeItemsRoot,
  allChildEl,
  firstChildEl,
  removeAllChildren,
  createEl,
} from "./xml-utils.js";

/** Entry 의 첫 DataPoints — GeoStudio 에서 단면 경계(참조 정점 번호 Number/X/Y). */
function readBoundaryVerticesFromEntry(entry) {
  const dpRoot = firstChildEl(entry, "DataPoints");
  if (!dpRoot) return [];
  const raw = [];
  for (const el of allChildEl(dpRoot, "DataPoint")) {
    const n = parseInt(el.getAttribute("Number") ?? "0", 10);
    const x = parseFloat(el.getAttribute("X") ?? "");
    const y = parseFloat(el.getAttribute("Y") ?? "");
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    raw.push({ n: Number.isFinite(n) ? n : raw.length + 1, x, y });
  }
  raw.sort((a, b) => a.n - b.n);
  return raw;
}

/** PiezometricLine 안의 DataPoints — 텍스트로 경계 정점 Number 참조 (NO.17 패턴). */
function readPiezometricVertexNumbersFromEntry(entry) {
  const piezoRoot = firstChildEl(entry, "PiezometricLines");
  if (!piezoRoot) return [];
  const line = firstChildEl(piezoRoot, "PiezometricLine");
  if (!line) return [];
  const dp = firstChildEl(line, "DataPoints");
  if (!dp) return [];
  const idx = [];
  for (const el of allChildEl(dp, "DataPoint")) {
    const t = (el.textContent ?? "").trim();
    const v = parseInt(t, 10);
    if (Number.isFinite(v)) idx.push(v);
  }
  return idx;
}

function insertAfter(parent, refChild, newChild) {
  if (!refChild) {
    parent.insertBefore(newChild, parent.firstChild);
    return;
  }
  if (refChild.nextSibling) parent.insertBefore(newChild, refChild.nextSibling);
  else parent.appendChild(newChild);
}

/**
 * 첫 SlopeItem 기준 수위 꺾은선 XY (UI · 미리보기용).
 * PiezometricLines 가 있으면 경계 DataPoints 와 조합해 복원, 없으면 빈 배열.
 */
export function readWaterDataPointsFromDocument(doc) {
  const root = findSlopeItemsRoot(doc);
  if (!root) return [];
  const si = allChildEl(root, "SlopeItem")[0];
  if (!si) return [];
  const entry = firstChildEl(si, "Entry");
  if (!entry) return [];
  const boundary = readBoundaryVerticesFromEntry(entry);
  const indices = readPiezometricVertexNumbersFromEntry(entry);
  if (indices.length >= 2 && boundary.length) {
    const byNum = new Map(boundary.map((v) => [v.n, v]));
    const out = [];
    for (const i of indices) {
      const v = byNum.get(i);
      if (v) out.push({ x: v.x, y: v.y });
    }
    if (out.length >= 2) return out;
  }
  return [];
}

/** GeoStudio XML 과 비슷하게 불필요한 0 제거 */
function formatCoord(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "0";
  let s = x.toFixed(8);
  s = s.replace(/\.?0+$/, "");
  if (s === "" || s === "-") s = "0";
  return s;
}

/**
 * 수위 입력 XY를 경계와 같은 Entry/DataPoints 블록 끝에 새 정점으로 추가하고,
 * 그 Number 목록을 반환 (Piezometric 이 참조).
 * 기존 경계 정점은 유지 — SlipSurface 등 기존 참조 보존.
 */
function appendWaterVerticesToDataPoints(doc, dpRoot, cleaned) {
  let maxNum = 0;
  for (const el of allChildEl(dpRoot, "DataPoint")) {
    const hasXY =
      el.hasAttribute("X") &&
      el.hasAttribute("Y") &&
      Number.isFinite(parseFloat(el.getAttribute("X")));
    if (!hasXY) continue;
    const n = parseInt(el.getAttribute("Number") ?? "0", 10);
    if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
  }
  const nums = [];
  cleaned.forEach((p, i) => {
    const num = maxNum + 1 + i;
    const el = doc.createElement("DataPoint");
    el.setAttribute("Number", String(num));
    el.setAttribute("X", formatCoord(p.x));
    el.setAttribute("Y", formatCoord(p.y));
    dpRoot.appendChild(el);
    nums.push(num);
  });
  dpRoot.setAttribute("Len", String(allChildEl(dpRoot, "DataPoint").length));
  return nums;
}

function upsertPiezometricLines(doc, entry, vertexNumbers) {
  let piezoRoot = firstChildEl(entry, "PiezometricLines");
  if (!piezoRoot) {
    piezoRoot = doc.createElement("PiezometricLines");
    const ssl = firstChildEl(entry, "SlipSurfaceLimit");
    const dp = firstChildEl(entry, "DataPoints");
    if (ssl) insertAfter(entry, ssl, piezoRoot);
    else if (dp) insertAfter(entry, dp, piezoRoot);
    else entry.insertBefore(piezoRoot, entry.firstChild);
  }
  removeAllChildren(piezoRoot);
  piezoRoot.setAttribute("Len", "1");
  const line = doc.createElement("PiezometricLine");
  line.appendChild(createEl(doc, "ID", "1"));
  const dps = doc.createElement("DataPoints");
  dps.setAttribute("Len", String(vertexNumbers.length));
  for (const n of vertexNumbers) {
    const dp = doc.createElement("DataPoint");
    dp.textContent = String(n);
    dps.appendChild(dp);
  }
  line.appendChild(dps);
  piezoRoot.appendChild(line);
}

function upsertMaterialUsesPiezs(doc, entry, log) {
  let rum = firstChildEl(entry, "RegionUsesMaterials");
  let count = 0;
  if (rum) {
    count = parseInt(rum.getAttribute("Len") ?? "0", 10);
    if (!count) count = allChildEl(rum, "RegionUsesMaterial").length;
  }
  if (count <= 0) {
    const existing = firstChildEl(entry, "MaterialUsesPiezs");
    if (existing) {
      count = parseInt(existing.getAttribute("Len") ?? "0", 10);
      if (!count) count = allChildEl(existing, "MaterialUsesPiez").length;
    }
  }
  if (count <= 0) {
    log(`  경고: RegionUsesMaterials 없음 — MaterialUsesPiezs 생략`);
    return;
  }
  let muz = firstChildEl(entry, "MaterialUsesPiezs");
  if (!muz) {
    muz = doc.createElement("MaterialUsesPiezs");
    if (rum) entry.insertBefore(muz, rum);
    else entry.appendChild(muz);
  }
  removeAllChildren(muz);
  for (let i = 1; i <= count; i++) {
    const m = doc.createElement("MaterialUsesPiez");
    m.setAttribute("ID", String(i));
    m.setAttribute("UsesID", "1");
    muz.appendChild(m);
  }
  muz.setAttribute("Len", String(count));
}

function removePiezometricWater(entry) {
  const piezo = firstChildEl(entry, "PiezometricLines");
  if (piezo) entry.removeChild(piezo);
  const muz = firstChildEl(entry, "MaterialUsesPiezs");
  if (muz) entry.removeChild(muz);
}

/**
 * GeoStudio 구조: 수위는 PiezometricLines + MaterialUsesPiezs.
 * 웹에서 입력한 XY는 경계 정점에 스냅하지 않고 DataPoints 말미에 추가해,
 * GeoStudio 속성 창에도 동일 좌표가 보이게 합니다.
 */
export function applyWaterDataPointsToAllSlopeItems(doc, points, log = () => {}) {
  const root = findSlopeItemsRoot(doc);
  if (!root) {
    log("  경고: SlopeItems 없음 — 수위 생략");
    return;
  }
  const items = allChildEl(root, "SlopeItem");
  if (!items.length) {
    log("  경고: SlopeItem 없음 — 수위 생략");
    return;
  }
  const arr = Array.isArray(points) ? points : [];
  const cleaned = [];
  for (const p of arr) {
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    cleaned.push({ x, y });
  }

  if (cleaned.length < 2) {
    for (const si of items) {
      const entry = firstChildEl(si, "Entry");
      if (entry) removePiezometricWater(entry);
    }
    log(`  수위 점 2개 미만 — PiezometricLines·MaterialUsesPiezs 제거 (${items.length}개 해석)`);
    return;
  }

  let ok = 0;
  for (const si of items) {
    const entry = firstChildEl(si, "Entry");
    if (!entry) continue;
    let dpRoot = firstChildEl(entry, "DataPoints");
    if (!dpRoot) {
      dpRoot = doc.createElement("DataPoints");
      entry.insertBefore(dpRoot, entry.firstChild);
    }
    const boundary = readBoundaryVerticesFromEntry(entry);
    if (boundary.length < 2) {
      log(`  경고: 경계 DataPoints(X/Y 정점) 부족 — Analysis 건너뜀`);
      continue;
    }
    const nums = appendWaterVerticesToDataPoints(doc, dpRoot, cleaned);
    if (!nums.length) continue;
    upsertPiezometricLines(doc, entry, nums);
    upsertMaterialUsesPiezs(doc, entry, log);
    ok += 1;
  }
  root.setAttribute("Len", String(items.length));
  log(
    `  수위 적용: ${ok}/${items.length}개 해석 (입력 ${cleaned.length}점을 DataPoints 에 추가 후 Piezometric 연결)`,
  );
}

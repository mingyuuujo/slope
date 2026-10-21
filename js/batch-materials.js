/**
 * 일괄 물성 적용 탭
 * 여러 GSZ 의 물성을 한 표에서 고치고, 이름이 같은 재료에 모두 적용한다.
 * 물성 라이브러리(JSON)로 저장해 두면 다음 번에도 같은 값을 불러다 쓸 수 있다.
 */
import { getJSZip, zipToBlob } from "./deps.js";
import { serializeXmlDocument } from "./xml-utils.js";
import { MATERIAL_FIELDS, readMaterialValues, patchMaterialValues } from "./material-patch.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** files: [{name, zip, xmlName, doc}] / lib: Map<재료이름, {values, base, count}> */
const state = { files: [], lib: new Map() };

/** 압축 파일 이름이 UTF-8 플래그 없이 저장돼도 JSZip 이 UTF-8 로 풀도록 한다. */
async function loadGsz(file) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  // 해석 폴더 안의 결과용 XML 사본이 아니라 루트의 XML 을 쓴다.
  const xmlName = Object.keys(zip.files).find((n) => !zip.files[n].dir && !n.includes("/") && /\.xml$/i.test(n));
  if (!xmlName) throw new Error("루트 XML 이 없습니다.");
  const doc = new DOMParser().parseFromString(await zip.file(xmlName).async("string"), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML 파싱 실패");
  return { name: file.name, zip, xmlName, doc };
}

function buildLibrary() {
  const lib = new Map();
  for (const f of state.files) {
    for (const m of readMaterialValues(f.doc)) {
      if (!m.name) continue;
      const e = lib.get(m.name) ?? { values: { ...m.values }, base: { ...m.values }, count: 0, differs: false };
      e.count += 1;
      if (JSON.stringify(m.values) !== JSON.stringify(e.base)) e.differs = true; // 파일마다 값이 다름
      lib.set(m.name, e);
    }
  }
  state.lib = lib;
}

function isChanged(e, key) {
  return Number.isFinite(e.values[key]) && e.values[key] !== e.base[key];
}

function render() {
  $("bm-head").innerHTML = `<tr><th>재료</th><th>사용 파일</th>${MATERIAL_FIELDS.map((f) => `<th>${f.label}</th>`).join("")}</tr>`;
  $("bm-tbody").innerHTML = [...state.lib].map(([name, e]) => `<tr>
    <td>${esc(name)}${e.differs ? ' <span class="bm-warn" title="파일마다 값이 다릅니다. 표의 값은 첫 파일 기준입니다.">⚠ 값 상이</span>' : ""}</td>
    <td class="num">${e.count}/${state.files.length}</td>
    ${MATERIAL_FIELDS.map((f) => `<td><input type="number" step="any" data-n="${esc(name)}" data-k="${f.key}"
      class="${isChanged(e, f.key) ? "bm-changed" : ""}" value="${e.values[f.key] ?? ""}" ${f.key in e.base ? "" : "placeholder=\"-\""}></td>`).join("")}
  </tr>`).join("") || `<tr><td colspan="${MATERIAL_FIELDS.length + 2}" class="bd-empty">GSZ 파일을 선택하세요.</td></tr>`;
  const n = [...state.lib.values()].reduce((s, e) => s + MATERIAL_FIELDS.filter((f) => isChanged(e, f.key)).length, 0);
  $("bm-summary").textContent = state.files.length ? `파일 ${state.files.length}개 · 재료 ${state.lib.size}종 · 변경 ${n}건` : "";
  $("bm-apply").disabled = !n;
}

function collectChanges() {
  const ch = {};
  for (const [name, e] of state.lib) {
    for (const f of MATERIAL_FIELDS) {
      if (isChanged(e, f.key)) (ch[name] ??= {})[f.key] = e.values[f.key];
    }
  }
  return ch;
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function apply() {
  const changes = collectChanges();
  const lines = [];
  const outZip = new (await getJSZip())();
  for (const f of state.files) {
    // 같은 파일에 반복 적용해도 안전하도록 원본 doc 의 복제본을 수정한다.
    const doc = f.doc.cloneNode(true);
    const r = patchMaterialValues(doc, changes);
    lines.push(`● ${f.name}: ${r.log.length}건 변경`);
    for (const l of r.log) lines.push(`    ${l.name} · ${l.field}: ${l.from ?? "(없음)"} → ${l.to}`);
    const miss = Object.keys(changes).filter((n) => !r.matched.has(n));
    if (miss.length) lines.push(`    (이 파일에 없는 재료: ${miss.join(", ")})`);
    // 원본 ZIP 의 다른 항목은 그대로 두고 XML 만 교체
    f.zip.file(f.xmlName, serializeXmlDocument(doc));
    outZip.file(f.name, await zipToBlob(f.zip));
  }
  $("bm-log").textContent = lines.join("\n");
  if (state.files.length === 1) download(await outZip.files[state.files[0].name].async("blob"), state.files[0].name.replace(/\.gsz$/i, "") + "_물성수정.gsz");
  else download(await outZip.generateAsync({ type: "blob" }), "물성수정_gsz.zip");
}

function exportLibrary() {
  const lib = {};
  for (const [name, e] of state.lib) lib[name] = e.values;
  download(new Blob([JSON.stringify({ version: 1, materials: lib }, null, 2)], { type: "application/json" }), "material-library.json");
}

async function importLibrary(file) {
  const json = JSON.parse((await file.text()).replace(/^﻿/, ""));
  let n = 0;
  for (const [name, values] of Object.entries(json.materials ?? {})) {
    const e = state.lib.get(name);
    if (!e) continue;
    for (const f of MATERIAL_FIELDS) if (Number.isFinite(values[f.key])) e.values[f.key] = values[f.key];
    n += 1;
  }
  $("bm-log").textContent = `라이브러리 불러옴: 현재 파일의 재료 ${n}종에 값을 채웠습니다. 라이브러리에만 있는 재료는 무시했습니다.`;
  render();
}

export function initBatchMaterials() {
  if (!$("bm-tbody")) return;
  $("bm-files").addEventListener("change", async (e) => {
    state.files = [];
    const errs = [];
    for (const file of e.target.files) {
      try { state.files.push(await loadGsz(file)); } catch (err) { errs.push(`${file.name}: ${err.message}`); }
    }
    $("bm-log").textContent = errs.join("\n");
    buildLibrary();
    render();
  });
  $("bm-tbody").addEventListener("input", (e) => {
    const { n, k } = e.target.dataset;
    if (n == null) return;
    state.lib.get(n).values[k] = e.target.value === "" ? NaN : parseFloat(e.target.value);
    e.target.classList.toggle("bm-changed", isChanged(state.lib.get(n), k));
    const cnt = [...state.lib.values()].reduce((s, x) => s + MATERIAL_FIELDS.filter((f) => isChanged(x, f.key)).length, 0);
    $("bm-summary").textContent = `파일 ${state.files.length}개 · 재료 ${state.lib.size}종 · 변경 ${cnt}건`;
    $("bm-apply").disabled = !cnt;
  });
  $("bm-apply").addEventListener("click", () => apply().catch((err) => { $("bm-log").textContent = `❌ ${err.message}`; }));
  $("bm-export-lib").addEventListener("click", exportLibrary);
  $("bm-import-lib").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) importLibrary(f).catch((err) => { $("bm-log").textContent = `❌ ${err.message}`; });
    e.target.value = "";
  });
  render();
}

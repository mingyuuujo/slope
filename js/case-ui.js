/**
 * 케이스 템플릿 탭 UI
 * 템플릿(수위·kh·상재하중)을 만들어 두고, 여러 GSZ 의 해석에 골라 적용한다.
 */
import { getJSZip, zipToBlob } from "./deps.js";
import { serializeXmlDocument } from "./xml-utils.js";
import {
  applyCaseToAnalysis,
  listAnalyses,
  parseWaterText,
  parsePressureText,
} from "./case-template.js";

const STORE_KEY = "slope.case.templates";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** templates: {name, waterText, khText, pressureText}[] / files: {name, zip, xmlName, doc, analyses} */
const state = { templates: loadTemplates(), files: [], assign: new Map() };

export function loadTemplates() {
  try {
    const t = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(t)) return t;
  } catch { /* 저장소 사용 불가 */ }
  return [
    { name: "상시", waterText: "", khText: "", pressureText: "" },
    { name: "지진시 (kh 0.154)", waterText: "", khText: "0.154", pressureText: "" },
  ];
}

function saveTemplates() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state.templates)); } catch { /* ignore */ }
}

export function toTemplate(t) {
  const kh = t.khText.trim();
  if (kh && !Number.isFinite(parseFloat(kh))) throw new Error(`"${t.name}": kh 가 숫자가 아닙니다.`);
  return {
    name: t.name,
    water: parseWaterText(t.waterText),
    seismicH: kh ? parseFloat(kh) : null,
    pressureLines: parsePressureText(t.pressureText),
  };
}

async function loadGsz(file) {
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const xmlName = Object.keys(zip.files).find((n) => !zip.files[n].dir && !n.includes("/") && /\.xml$/i.test(n));
  if (!xmlName) throw new Error("루트 XML 이 없습니다.");
  const doc = new DOMParser().parseFromString(await zip.file(xmlName).async("string"), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML 파싱 실패");
  return { name: file.name, zip, xmlName, doc, analyses: listAnalyses(doc) };
}

const rowKey = (fi, id) => `${fi}\u0000${id}`;

function templateOptions(selected) {
  return `<option value="">(적용 안 함)</option>` + state.templates
    .map((t) => `<option value="${esc(t.name)}"${t.name === selected ? " selected" : ""}>${esc(t.name)}</option>`).join("");
}

function renderTemplateList() {
  const sel = $("ct-list");
  const cur = sel.value;
  sel.innerHTML = state.templates.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join("");
  if (cur && state.templates[cur]) sel.value = cur;
  fillEditor();
  $("ct-keyword-tpl").innerHTML = templateOptions("");
}

function fillEditor() {
  const t = state.templates[$("ct-list").value];
  $("ct-name").value = t?.name ?? "";
  $("ct-water").value = t?.waterText ?? "";
  $("ct-kh").value = t?.khText ?? "";
  $("ct-pressure").value = t?.pressureText ?? "";
}

function renderTargets() {
  const rows = [];
  state.files.forEach((f, fi) => f.analyses.forEach((a) => {
    const k = rowKey(fi, a.id);
    rows.push(`<tr><td>${esc(f.name)}</td><td class="num">${esc(a.id)}</td><td>${esc(a.name)}</td>
      <td><select data-k="${esc(k)}">${templateOptions(state.assign.get(k))}</select></td></tr>`);
  }));
  $("ct-tbody").innerHTML = rows.join("") || `<tr><td colspan="4" class="bd-empty">GSZ 파일을 선택하세요.</td></tr>`;
  updateSummary();
}

function updateSummary() {
  const n = [...state.assign.values()].filter(Boolean).length;
  $("ct-summary").textContent = state.files.length ? `파일 ${state.files.length}개 · 적용 대상 ${n}건` : "";
  $("ct-apply").disabled = !n;
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function apply() {
  const byName = new Map();
  for (const t of state.templates) byName.set(t.name, toTemplate(t));
  const lines = [];
  const out = new (await getJSZip())();
  for (const [fi, f] of state.files.entries()) {
    const doc = f.doc.cloneNode(true);
    let n = 0;
    lines.push(`● ${f.name}`);
    for (const a of f.analyses) {
      const name = state.assign.get(rowKey(fi, a.id));
      if (!name) continue;
      const done = applyCaseToAnalysis(doc, a.id, byName.get(name));
      lines.push(`    [${a.id}] ${a.name} ← ${name}: ${done.join(" · ") || "(바뀐 것 없음)"}`);
      if (done.length) n += 1;
    }
    if (n) f.zip.file(f.xmlName, serializeXmlDocument(doc));
    out.file(f.name, await zipToBlob(f.zip));
  }
  $("ct-log").textContent = lines.join("\n");
  if (state.files.length === 1) {
    download(await out.files[state.files[0].name].async("blob"), state.files[0].name.replace(/\.gsz$/i, "") + "_케이스.gsz");
  } else {
    download(await out.generateAsync({ type: "blob" }), "케이스적용_gsz.zip");
  }
}

function fail(err) { $("ct-log").textContent = `❌ ${err.message}`; }

export function initCaseTemplates() {
  if (!$("ct-tbody")) return;

  $("ct-files").addEventListener("change", async (e) => {
    state.files = [];
    state.assign = new Map();
    const errs = [];
    for (const file of e.target.files) {
      try { state.files.push(await loadGsz(file)); } catch (err) { errs.push(`${file.name}: ${err.message}`); }
    }
    $("ct-log").textContent = errs.join("\n");
    renderTargets();
  });

  $("ct-list").addEventListener("change", fillEditor);
  $("ct-new").addEventListener("click", () => {
    state.templates.push({ name: `새 템플릿 ${state.templates.length + 1}`, waterText: "", khText: "", pressureText: "" });
    saveTemplates(); renderTemplateList();
    $("ct-list").value = String(state.templates.length - 1); fillEditor(); renderTargets();
  });
  $("ct-del").addEventListener("click", () => {
    const i = Number($("ct-list").value);
    if (!state.templates[i]) return;
    const gone = state.templates.splice(i, 1)[0].name;
    for (const [k, v] of state.assign) if (v === gone) state.assign.delete(k);
    saveTemplates(); renderTemplateList(); renderTargets();
  });
  $("ct-save").addEventListener("click", () => {
    const i = Number($("ct-list").value);
    const t = state.templates[i];
    if (!t) return;
    const name = $("ct-name").value.trim();
    if (!name) return fail(new Error("템플릿 이름을 입력하세요."));
    if (state.templates.some((x, j) => j !== i && x.name === name)) return fail(new Error("같은 이름의 템플릿이 있습니다."));
    const next = { name, waterText: $("ct-water").value, khText: $("ct-kh").value, pressureText: $("ct-pressure").value };
    try { toTemplate(next); } catch (err) { return fail(err); } // 저장 전에 형식 검사
    for (const [k, v] of state.assign) if (v === t.name) state.assign.set(k, name);
    state.templates[i] = next;
    saveTemplates(); renderTemplateList(); $("ct-list").value = String(i); renderTargets();
    $("ct-log").textContent = `저장했습니다: ${name}`;
  });

  $("ct-export").addEventListener("click", () =>
    download(new Blob([JSON.stringify({ version: 1, templates: state.templates }, null, 2)], { type: "application/json" }), "case-templates.json"));
  $("ct-import").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const json = JSON.parse((await f.text()).replace(/^﻿/, ""));
      const incoming = (json.templates ?? []).filter((t) => t && t.name);
      for (const t of incoming) {
        const next = { name: t.name, waterText: t.waterText ?? "", khText: t.khText ?? "", pressureText: t.pressureText ?? "" };
        const i = state.templates.findIndex((x) => x.name === t.name);
        if (i >= 0) state.templates[i] = next; else state.templates.push(next);
      }
      saveTemplates(); renderTemplateList(); renderTargets();
      $("ct-log").textContent = `템플릿 ${incoming.length}개를 불러왔습니다. 이름이 같은 템플릿은 덮어썼습니다.`;
    } catch (err) { fail(err); }
  });

  $("ct-tbody").addEventListener("change", (e) => {
    const k = e.target.dataset.k;
    if (k == null) return;
    state.assign.set(k, e.target.value);
    updateSummary();
  });
  $("ct-keyword-go").addEventListener("click", () => {
    const kw = $("ct-keyword").value.trim();
    const tpl = $("ct-keyword-tpl").value;
    if (!kw) return fail(new Error("키워드를 입력하세요."));
    let n = 0;
    state.files.forEach((f, fi) => f.analyses.forEach((a) => {
      if (a.name.includes(kw)) { state.assign.set(rowKey(fi, a.id), tpl); n += 1; }
    }));
    renderTargets();
    $("ct-log").textContent = `"${kw}" 가 들어간 해석 ${n}건에 ${tpl || "(적용 안 함)"} 을 지정했습니다.`;
  });
  $("ct-apply").addEventListener("click", () => apply().catch(fail));

  renderTemplateList();
  renderTargets();
}

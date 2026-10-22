/**
 * 자동 실행 탭: 물성 라이브러리 적용 → 케이스 템플릿 적용 → 로컬 러너로 해석 → 결과 대시보드를 한 번에 잇는다.
 * 각 단계는 별도 탭(일괄 물성 적용·케이스 템플릿·배치 결과)과 같은 모듈을 쓴다.
 */
import { getJSZip, zipToBlob } from "./deps.js";
import { serializeXmlDocument } from "./xml-utils.js";
import { patchMaterialValues, MATERIAL_FIELDS } from "./material-patch.js";
import { applyCaseToAnalysis, listAnalyses } from "./case-template.js";
import { loadTemplates, toTemplate } from "./case-ui.js";
import { setBatchRun } from "./batch-dashboard.js";
import { applyDxfToGsz } from "./dxf-mapping.js";

const CONN_KEY = "slope.pipeline.conn";
const RULES_KEY = "slope.pipeline.rules";
const $ = (id) => document.getElementById(id);

const state = { files: [], library: null, dxf: null, running: false };

function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function conn() {
  return { url: $("pl-url").value.trim().replace(/\/$/, ""), token: $("pl-token").value.trim() };
}

async function api(path, init = {}) {
  const { url, token } = conn();
  let res;
  try {
    res = await fetch(url + path, { ...init, headers: { "X-Token": token, ...(init.headers ?? {}) } });
  } catch {
    throw new Error("러너에 연결할 수 없습니다. runner/run_server.bat 이 실행 중인지, 주소가 맞는지 확인하세요.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `러너 오류 ${res.status}`);
  return body;
}

async function checkConnection() {
  const el = $("pl-conn-status");
  el.textContent = "확인 중...";
  try {
    const r = await api("/health");
    writeStore(CONN_KEY, conn());
    el.textContent = `연결됨 · 출력 폴더 ${r.out}`;
    el.className = "dxf-gs-status dxf-gs-status--ok";
    return true;
  } catch (e) {
    el.textContent = e.message;
    el.className = "dxf-gs-status dxf-gs-status--error";
    return false;
  }
}

async function loadGsz(file) {
  const zip = await (await getJSZip()).loadAsync(await file.arrayBuffer());
  const xmlName = Object.keys(zip.files).find((n) => !zip.files[n].dir && !n.includes("/") && /\.xml$/i.test(n));
  if (!xmlName) throw new Error("루트 XML 이 없습니다.");
  const doc = new DOMParser().parseFromString(await zip.file(xmlName).async("string"), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("XML 파싱 실패");
  return { name: file.name, zip, xmlName, doc };
}

/** "키워드 = 템플릿이름" 줄들 → [{keyword, template}]. 키워드 * 는 모든 해석. */
function parseRules(text, templates) {
  const names = new Set(templates.map((t) => t.name));
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const i = l.lastIndexOf("=");
    if (i < 0) throw new Error(`"키워드 = 템플릿" 형식이 아닙니다: "${l}"`);
    const keyword = l.slice(0, i).trim();
    const template = l.slice(i + 1).trim();
    if (!names.has(template)) throw new Error(`없는 템플릿입니다: "${template}" (케이스 템플릿 탭에서 만드세요)`);
    return { keyword, template };
  });
}

function libraryChanges() {
  const out = {};
  for (const [name, values] of Object.entries(state.library?.materials ?? {})) {
    const ch = {};
    for (const f of MATERIAL_FIELDS) if (Number.isFinite(values[f.key])) ch[f.key] = values[f.key];
    if (Object.keys(ch).length) out[name] = ch;
  }
  return out;
}

function log(line) {
  const box = $("pl-log");
  box.textContent += line + "\n";
  box.scrollTop = box.scrollHeight;
}

async function run() {
  if (state.running) return;
  state.running = true;
  $("pl-run").disabled = true;
  $("pl-log").textContent = "";
  try {
    if (!state.files.length) throw new Error("GSZ 파일을 선택하세요.");
    const templates = loadTemplates();
    const rules = parseRules($("pl-rules").value, templates);
    const tplByName = new Map(templates.map((t) => [t.name, toTemplate(t)]));
    const changes = libraryChanges();
    if (!(await checkConnection())) throw new Error("러너 연결을 먼저 확인하세요.");
    writeStore(RULES_KEY, $("pl-rules").value);

    const saveZip = $("pl-save-zip").checked ? new (await getJSZip())() : null;
    const run = { runAt: new Date().toISOString().slice(0, 19), source: "web", files: [] };

    for (const [i, f] of state.files.entries()) {
      log(`[${i + 1}/${state.files.length}] ${f.name}`);
      let file = f;
      let touched = false;

      if (state.dxf) {
        try {
          file = await applyDxfToGsz(f, state.dxf.text);
          log(`    DXF 적용: 기하 교체 완료`);
          touched = true;
        } catch (err) {
          log(`    ⚠ DXF 적용 실패: ${err.message}`);
        }
      }

      const doc = file.doc.cloneNode(true);

      if (Object.keys(changes).length) {
        const r = patchMaterialValues(doc, changes);
        log(`    물성: ${r.log.length}건 변경`);
        touched ||= r.log.length > 0;
      }
      if (rules.length) {
        let n = 0;
        for (const a of listAnalyses(doc)) {
          const rule = rules.find((r) => r.keyword === "*" || a.name.includes(r.keyword));
          if (!rule) continue;
          if (applyCaseToAnalysis(doc, a.id, tplByName.get(rule.template)).length) n += 1;
        }
        log(`    케이스: ${n}개 해석에 적용`);
        touched ||= n > 0;
      }
      if (touched) file.zip.file(file.xmlName, serializeXmlDocument(doc));
      const blob = await zipToBlob(file.zip);
      saveZip?.file(file.name, blob);

      log("    해석 중...");
      const entry = await api(`/solve?file=${encodeURIComponent(f.name)}`, { method: "POST", body: blob });
      const noFos = entry.analyses.filter((a) => a.fos == null).length;
      log(`    완료 ${entry.seconds}s · 해석 ${entry.analyses.length}개 · FOS 없음 ${noFos}개`
        + (entry.error ? ` · ❌ ${entry.error}` : ""));
      run.files.push(entry);
    }

    const { previous } = await api("/finish", { method: "POST", body: JSON.stringify(run),
      headers: { "Content-Type": "application/json" } });
    setBatchRun(run, previous);
    log(previous ? "전회 결과와 비교할 수 있습니다." : "이전 실행이 없어 전회 비교는 없습니다.");
    log("✓ 끝났습니다. '배치 결과' 탭에서 확인하세요.");
    if (saveZip) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await saveZip.generateAsync({ type: "blob" }));
      a.download = "자동실행_입력gsz.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    document.querySelector('.tab-btn[data-tab="batch"]')?.click();
  } catch (e) {
    log(`❌ ${e.message}`);
  } finally {
    state.running = false;
    $("pl-run").disabled = false;
  }
}

export function initPipeline() {
  if (!$("pl-run")) return;
  const c = readStore(CONN_KEY, { url: "http://127.0.0.1:8770", token: "" });
  $("pl-url").value = c.url;
  $("pl-token").value = c.token;
  $("pl-rules").value = readStore(RULES_KEY, "# 해석 이름에 키워드가 들어 있으면 템플릿 적용 (위에서부터 먼저 맞는 줄)\n지진 = 지진시 (kh 0.154)\n");

  $("pl-check").addEventListener("click", checkConnection);
  $("pl-files").addEventListener("change", async (e) => {
    state.files = [];
    for (const file of e.target.files) {
      try { state.files.push(await loadGsz(file)); } catch (err) { log(`❌ ${file.name}: ${err.message}`); }
    }
    $("pl-file-info").textContent = state.files.length ? `${state.files.length}개 선택됨` : "";
  });
  $("pl-dxf").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    state.dxf = null;
    if (!f) return;
    try {
      state.dxf = { name: f.name, text: await f.text() };
      $("pl-dxf-info").textContent = `${f.name} 준비됨`;
    } catch (err) { $("pl-dxf-info").textContent = `❌ ${err.message}`; }
  });
  $("pl-lib").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    state.library = null;
    if (!f) return;
    try {
      state.library = JSON.parse((await f.text()).replace(/^﻿/, ""));
      $("pl-lib-info").textContent = `재료 ${Object.keys(state.library.materials ?? {}).length}종`;
    } catch (err) { $("pl-lib-info").textContent = `❌ ${err.message}`; }
  });
  $("pl-run").addEventListener("click", run);
}

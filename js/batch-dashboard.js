/**
 * 배치 결과 대시보드 탭
 * runner/run_slope.py 가 만든 results.json 을 불러와 전체 해석의 FOS를 기준값과 비교하고,
 * 이전 results.json 이 있으면 전회 대비 변화를 표시한다.
 */

const RULES_KEY = "slope.batch.rules";
const DEFAULT_RULES = [
  { keyword: "지진", min: 1.1 },
  { keyword: "시공", min: 1.2 },
  { keyword: "", min: 1.3 }, // 기본(위 키워드에 해당하지 않는 해석)
];

const $ = (id) => document.getElementById(id);
const state = { current: null, previous: null, rules: loadRules(), rows: [] };

function loadRules() {
  try {
    const r = JSON.parse(localStorage.getItem(RULES_KEY));
    if (Array.isArray(r) && r.length) return r;
  } catch { /* 저장소 사용 불가 */ }
  return DEFAULT_RULES.map((r) => ({ ...r }));
}

function saveRules() {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(state.rules)); } catch { /* ignore */ }
}

/** 키워드가 해석 이름에 포함된 첫 규칙. 없으면 키워드 없는 기본 규칙. */
function minFosFor(name) {
  const hit = state.rules.find((r) => r.keyword && name.includes(r.keyword))
    ?? state.rules.find((r) => !r.keyword);
  return hit ? Number(hit.min) : null;
}

function flatten(run) {
  const map = new Map();
  for (const f of run?.files ?? []) {
    for (const a of f.analyses ?? []) map.set(`${f.file}\u0000${a.analysis}`, a.fos);
  }
  return map;
}

function buildRows() {
  const prev = flatten(state.previous);
  const rows = [];
  for (const f of state.current?.files ?? []) {
    for (const a of f.analyses ?? []) {
      const min = minFosFor(a.analysis);
      const p = prev.get(`${f.file}\u0000${a.analysis}`);
      let status = "ok";
      if (a.fos == null) status = "nofos";
      else if (min != null && a.fos < min) status = "ng";
      rows.push({
        file: f.file, analysis: a.analysis, fos: a.fos, min, status,
        prev: p ?? null, diff: a.fos != null && p != null ? a.fos - p : null,
      });
    }
    for (const x of f.failures ?? []) {
      rows.push({ file: f.file, analysis: x.analysis, fos: null, min: null, status: "fail", reason: x.reason });
    }
    if (f.error && !(f.failures ?? []).length) {
      rows.push({ file: f.file, analysis: "-", fos: null, min: null, status: "fail", reason: f.error });
    }
  }
  state.rows = rows;
}

const LABEL = { ok: "적합", ng: "부적합", nofos: "FOS 없음", fail: "해석 실패" };
const fmt = (v, d = 3) => (v == null ? "-" : v.toFixed(d));

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function render() {
  buildRows();
  const only = $("bd-only-problem").checked;
  const rows = state.rows.filter((r) => !only || r.status !== "ok");
  $("bd-tbody").innerHTML = rows.map((r) => {
    const diff = r.diff == null ? "-" : (r.diff > 0 ? "+" : "") + r.diff.toFixed(3);
    const cls = r.diff == null || Math.abs(r.diff) < 0.0005 ? "" : r.diff > 0 ? "bd-up" : "bd-down";
    return `<tr class="bd-${r.status}"><td>${esc(r.file)}</td><td>${esc(r.analysis)}</td>
      <td class="num">${fmt(r.fos)}</td><td class="num">${fmt(r.min, 2)}</td>
      <td>${LABEL[r.status]}${r.reason ? `<div class="bd-reason">${esc(r.reason)}</div>` : ""}</td>
      <td class="num">${fmt(r.prev)}</td><td class="num ${cls}">${diff}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="bd-empty">표시할 결과가 없습니다. results.json 을 불러오세요.</td></tr>`;

  const n = (s) => state.rows.filter((r) => r.status === s).length;
  $("bd-summary").textContent = state.current
    ? `실행 ${state.current.runAt} · 전체 ${state.rows.length} · 적합 ${n("ok")} · 부적합 ${n("ng")} · FOS 없음 ${n("nofos")} · 실패 ${n("fail")}`
    : "results.json 을 불러오세요.";
}

function renderRules() {
  $("bd-rules").innerHTML = state.rules.map((r, i) => `<div class="file-row">
    <label>${r.keyword ? "이름에 포함" : "그 외 (기본)"}</label>
    ${r.keyword ? `<input type="text" data-i="${i}" data-k="keyword" value="${esc(r.keyword)}" style="width:120px">` : ""}
    <span>FOS ≥</span><input type="number" step="0.01" min="0" data-i="${i}" data-k="min" value="${r.min}" style="width:80px">
    ${r.keyword ? `<button type="button" class="btn" data-del="${i}">삭제</button>` : ""}</div>`).join("");
}

async function readJson(file) {
  return JSON.parse((await file.text()).replace(/^﻿/, ""));
}

function exportCsv() {
  const head = ["파일", "해석", "FOS", "기준", "판정", "전회 FOS", "변화", "사유"];
  const lines = state.rows.map((r) => [r.file, r.analysis, fmt(r.fos, 4), fmt(r.min, 2), LABEL[r.status],
    fmt(r.prev, 4), r.diff == null ? "" : r.diff.toFixed(4), r.reason ?? ""]
    .map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","));
  const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "slope_batch_result.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

export function initBatchDashboard() {
  if (!$("bd-tbody")) return;
  const load = (key) => async (e) => {
    const f = e.target.files?.[0];
    state[key] = null;
    if (f) {
      try { state[key] = await readJson(f); } catch (err) { alert(`JSON 읽기 실패: ${err.message}`); }
    }
    render();
  };
  $("bd-current").addEventListener("change", load("current"));
  $("bd-previous").addEventListener("change", load("previous"));
  $("bd-only-problem").addEventListener("change", render);
  $("bd-export").addEventListener("click", exportCsv);
  $("bd-add-rule").addEventListener("click", () => {
    // 기본 규칙(키워드 없음)은 항상 마지막에 둔다
    state.rules.splice(state.rules.length - 1, 0, { keyword: "키워드", min: 1.0 });
    saveRules(); renderRules(); render();
  });
  $("bd-rules").addEventListener("input", (e) => {
    const { i, k } = e.target.dataset;
    if (i == null) return;
    state.rules[i][k] = k === "min" ? parseFloat(e.target.value) : e.target.value;
    saveRules(); render();
  });
  $("bd-rules").addEventListener("click", (e) => {
    const i = e.target.dataset.del;
    if (i == null) return;
    state.rules.splice(Number(i), 1);
    saveRules(); renderRules(); render();
  });
  renderRules();
  render();
}

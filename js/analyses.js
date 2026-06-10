import {
  findFirstTag,
  allChildEl,
  firstChildEl,
  createEl,
  findSlopeItemsRoot,
} from "./xml-utils.js";

/**
 * GSZ XML `<Analyses>/<Analysis>` 목록 (ID · 표시 이름).
 */
export function listAnalysesFromDocument(doc) {
  const node = findFirstTag(doc, "Analyses");
  if (!node) return [];
  const out = [];
  for (const a of allChildEl(node, "Analysis")) {
    const idEl = firstChildEl(a, "ID");
    const nameEl = firstChildEl(a, "Name");
    const id = idEl?.textContent?.trim() ?? "";
    if (!id) continue;
    out.push({
      id,
      name: nameEl?.textContent?.trim() ?? "",
    });
  }
  return out;
}

function ensureAnalysesEl(doc) {
  let el = findFirstTag(doc, "Analyses");
  if (el) return el;
  const root = doc.documentElement;
  el = doc.createElement("Analyses");
  el.setAttribute("Len", "0");
  const fi = firstChildEl(root, "FileInfo");
  if (fi?.nextSibling) root.insertBefore(el, fi.nextSibling);
  else root.appendChild(el);
  return el;
}

/**
 * 템플릿에 없는 Analysis / Context / SlopeItem 을 추가하고,
 * 기존 Analysis 의 `<Name>` 을 UI 타이틀로 갱신합니다.
 */
export function ensureAnalysisExists(doc, analysisId, name, log = () => {}) {
  const aidStr = String(parseInt(analysisId, 10));
  if (!Number.isFinite(Number(aidStr)) || aidStr === "NaN") {
    throw new Error(`유효하지 않은 Analysis ID: ${analysisId}`);
  }

  const analysesEl = ensureAnalysesEl(doc);
  let analysisEl = null;
  for (const a of allChildEl(analysesEl, "Analysis")) {
    const idEl = firstChildEl(a, "ID");
    if (idEl && String(idEl.textContent ?? "").trim() === aidStr) {
      analysisEl = a;
      break;
    }
  }

  if (analysisEl) {
    let nameEl = firstChildEl(analysisEl, "Name");
    if (nameEl) nameEl.textContent = name;
    else {
      const idNode = firstChildEl(analysisEl, "ID");
      if (idNode?.nextSibling)
        analysisEl.insertBefore(createEl(doc, "Name", name), idNode.nextSibling);
      else analysisEl.appendChild(createEl(doc, "Name", name));
    }
    log(`  Analysis ${aidStr} 이름 → 「${name}」`);
  } else {
    const template = allChildEl(analysesEl, "Analysis")[0];
    if (!template) {
      throw new Error(
        "템플릿에 <Analysis> 가 없어 새 해석을 복제할 수 없습니다.",
      );
    }
    analysisEl = template.cloneNode(true);
    const idNode = firstChildEl(analysisEl, "ID");
    if (idNode) idNode.textContent = aidStr;
    let nameEl = firstChildEl(analysisEl, "Name");
    if (nameEl) nameEl.textContent = name;
    else analysisEl.appendChild(createEl(doc, "Name", name));
    analysesEl.appendChild(analysisEl);
    analysesEl.setAttribute(
      "Len",
      String(allChildEl(analysesEl, "Analysis").length),
    );
    log(`  Analysis ${aidStr} 신설 (기존 해석 복제) · 「${name}」`);
  }

  let contextsEl = findFirstTag(doc, "Contexts");
  if (!contextsEl) {
    contextsEl = doc.createElement("Contexts");
    doc.documentElement.appendChild(contextsEl);
  }
  let hasCtx = false;
  for (const ctx of allChildEl(contextsEl, "Context")) {
    const aEl = firstChildEl(ctx, "AnalysisID");
    if (aEl && String(aEl.textContent ?? "").trim() === aidStr) {
      hasCtx = true;
      break;
    }
  }
  if (!hasCtx) {
    const ctx = doc.createElement("Context");
    ctx.appendChild(createEl(doc, "AnalysisID", aidStr));
    ctx.appendChild(createEl(doc, "IsDefined", "true"));
    contextsEl.appendChild(ctx);
    contextsEl.setAttribute(
      "Len",
      String(allChildEl(contextsEl, "Context").length),
    );
    log(`  Context 신설 AnalysisID=${aidStr}`);
  }

  const slopeRoot = findSlopeItemsRoot(doc);
  if (!slopeRoot) {
    log(`  경고: SlopeItems 없음 — SlopeItem 생략`);
    return;
  }
  let hasSi = false;
  for (const si of allChildEl(slopeRoot, "SlopeItem")) {
    const aEl = firstChildEl(si, "AnalysisID");
    if (aEl && String(aEl.textContent ?? "").trim() === aidStr) {
      hasSi = true;
      break;
    }
  }
  if (!hasSi) {
    const templateSi = allChildEl(slopeRoot, "SlopeItem")[0];
    if (!templateSi) {
      log(`  경고: 복제할 SlopeItem 없음`);
      return;
    }
    const clone = templateSi.cloneNode(true);
    const aidSi = firstChildEl(clone, "AnalysisID");
    if (aidSi) aidSi.textContent = aidStr;
    const entry = firstChildEl(clone, "Entry");
    if (entry) {
      const rum = firstChildEl(entry, "RegionUsesMaterials");
      if (rum) entry.removeChild(rum);
    }
    slopeRoot.appendChild(clone);
    slopeRoot.setAttribute(
      "Len",
      String(allChildEl(slopeRoot, "SlopeItem").length),
    );
    log(`  SlopeItem 신설 AnalysisID=${aidStr}`);
  }
}

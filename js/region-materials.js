import {
  firstChildEl,
  allChildEl,
  removeAllChildren,
  createEl,
  findSlopeItemsRoot,
  findFirstTag,
} from "./xml-utils.js";

function regionUsesMaterialElem(doc, rumParent, rid, matId) {
  const item = doc.createElement("RegionUsesMaterial");
  item.appendChild(createEl(doc, "ID", String(rid)));
  item.appendChild(createEl(doc, "UsesID", String(matId)));
  rumParent.appendChild(item);
}

/**
 * slope_gui._sync_region_uses_materials 이식
 */
export function syncRegionUsesMaterials(doc, mappings, analysisId, log = () => {}) {
  const aidStr = String(parseInt(analysisId, 10));
  const root = doc.documentElement;

  let contextsEl = findFirstTag(doc, "Contexts");
  if (!contextsEl) {
    contextsEl = doc.createElement("Contexts");
    root.appendChild(contextsEl);
  }

  let ctxTarget = null;
  for (const ctx of allChildEl(contextsEl, "Context")) {
    const aEl = firstChildEl(ctx, "AnalysisID");
    if (aEl && String(aEl.textContent ?? "").trim() === aidStr) {
      ctxTarget = ctx;
      break;
    }
  }
  if (!ctxTarget) {
    ctxTarget = doc.createElement("Context");
    contextsEl.appendChild(ctxTarget);
    ctxTarget.appendChild(createEl(doc, "AnalysisID", aidStr));
    ctxTarget.appendChild(createEl(doc, "IsDefined", "true"));
    log(`  Context 신설 AnalysisID=${aidStr}`);
  }
  if (!firstChildEl(ctxTarget, "IsDefined")) {
    ctxTarget.appendChild(createEl(doc, "IsDefined", "true"));
  }
  contextsEl.setAttribute("Len", String(allChildEl(contextsEl, "Context").length));

  let rumC = firstChildEl(ctxTarget, "RegionUsesMaterials");
  if (!rumC) {
    rumC = doc.createElement("RegionUsesMaterials");
    ctxTarget.appendChild(rumC);
  } else removeAllChildren(rumC);
  for (const [rid, matId] of mappings) {
    regionUsesMaterialElem(doc, rumC, rid, matId);
  }
  rumC.setAttribute("Len", String(mappings.length));

  const slopeItemsEl = findSlopeItemsRoot(doc);
  if (!slopeItemsEl) {
    log(`  경고: SlopeItems 없음 — Entry 쪽 RegionUsesMaterials 생략`);
    log(`  RegionUsesMaterials → Context만 기록 (${mappings.length}건)`);
    return;
  }

  let siTarget = null;
  const items = allChildEl(slopeItemsEl, "SlopeItem");
  for (const si of items) {
    const aEl = firstChildEl(si, "AnalysisID");
    if (aEl && String(aEl.textContent ?? "").trim() === aidStr) {
      siTarget = si;
      break;
    }
  }
  if (!siTarget && items.length) siTarget = items[0];
  if (!siTarget) {
    log(`  경고: SlopeItem 없음 — Entry 쪽 생략`);
    return;
  }

  for (const ch of [...siTarget.children]) {
    if (ch.tagName === "RegionUsesMaterials") siTarget.removeChild(ch);
  }

  let entry = firstChildEl(siTarget, "Entry");
  if (!entry) {
    entry = doc.createElement("Entry");
    siTarget.appendChild(entry);
    log(`  경고: SlopeItem에 Entry 없음 — 새 Entry 추가`);
  }

  let rumE = firstChildEl(entry, "RegionUsesMaterials");
  if (!rumE) {
    rumE = doc.createElement("RegionUsesMaterials");
    entry.appendChild(rumE);
  } else removeAllChildren(rumE);
  for (const [rid, matId] of mappings) {
    regionUsesMaterialElem(doc, rumE, rid, matId);
  }
  rumE.setAttribute("Len", String(mappings.length));

  log(`  RegionUsesMaterials → Context + SlopeItem/Entry (${mappings.length}건)`);
}

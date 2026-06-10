/** DOM XML 헬퍼 (네임스페이스 없음 가정) */

/**
 * 문서 전역에서 태그 첫 노드 — slope_gui ElementTree.find(tag) 와 동일.
 * (루트 직계만 보는 firstChildEl 과 달리 중첩된 Materials/Contexts 도 찾음)
 */
export function findFirstTag(doc, tagName) {
  let list = doc.getElementsByTagName(tagName);
  if (list.length) return list[0];
  if (typeof doc.getElementsByTagNameNS === "function") {
    list = doc.getElementsByTagNameNS("*", tagName);
    if (list.length) return list[0];
  }
  return null;
}

export function firstChildEl(parent, tag) {
  if (!parent) return null;
  for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
    if (c.tagName === tag) return c;
  }
  return null;
}

export function allChildEl(parent, tag) {
  const out = [];
  if (!parent) return out;
  for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
    if (c.tagName === tag) out.push(c);
  }
  return out;
}

export function removeAllChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function createEl(doc, tag, text) {
  const e = doc.createElement(tag);
  if (text != null && text !== "") e.textContent = String(text);
  return e;
}

/** 재료 자식 순서 정렬 — slope_gui._reorder_material_children */
export function reorderMaterialChildren(matElem) {
  const ORDER = ["ID", "Name", "n", "Color", "SlopeModel", "StressStrain"];
  const buckets = new Map();
  const children = [];
  for (let c = matElem.firstElementChild; c; c = c.nextElementChild) {
    children.push(c);
  }
  for (const ch of children) {
    const t = ch.tagName;
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(ch);
  }
  removeAllChildren(matElem);
  for (const t of ORDER) {
    const arr = buckets.get(t);
    if (!arr) continue;
    for (const n of arr) matElem.appendChild(n);
    buckets.delete(t);
  }
  for (const [, arr] of buckets) {
    for (const n of arr) matElem.appendChild(n);
  }
}

export function setMaterialDisplayName(matElem, doc, nameTxt) {
  let names = allChildEl(matElem, "Name");
  for (let i = 1; i < names.length; i++) matElem.removeChild(names[i]);
  names = allChildEl(matElem, "Name");
  if (names.length) names[0].textContent = nameTxt;
  else matElem.appendChild(createEl(doc, "Name", nameTxt));

  let legacy = allChildEl(matElem, "n");
  for (let i = 1; i < legacy.length; i++) matElem.removeChild(legacy[i]);
  legacy = allChildEl(matElem, "n");
  if (legacy.length) legacy[0].textContent = nameTxt;
  else matElem.appendChild(createEl(doc, "n", nameTxt));
}

export function findSlopeItemsRoot(doc) {
  return findFirstTag(doc, "SlopeItems");
}

export function serializeXmlDocument(doc) {
  const ser = new XMLSerializer();
  const body = ser.serializeToString(doc.documentElement);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + body;
}

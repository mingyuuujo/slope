import { findFirstTag, allChildEl, firstChildEl } from "./xml-utils.js";

/**
 * 템플릿 GSZ XML에서 `<Materials>/<Material>` 목록 추출 (Region 매핑 시 ID 참조용).
 */
export function listMaterialsFromDocument(doc) {
  const matsNode = findFirstTag(doc, "Materials");
  if (!matsNode) return [];
  const materials = [];
  for (const mat of allChildEl(matsNode, "Material")) {
    const idEl = firstChildEl(mat, "ID");
    const id = idEl?.textContent?.trim() ?? "";
    if (!id) continue;
    let name = "";
    const nameEl = firstChildEl(mat, "Name");
    if (nameEl?.textContent?.trim()) name = nameEl.textContent.trim();
    else {
      const nEl = firstChildEl(mat, "n");
      if (nEl?.textContent?.trim()) name = nEl.textContent.trim();
    }
    const modelEl = firstChildEl(mat, "SlopeModel");
    const model = modelEl?.textContent?.trim() ?? "";
    const colorEl = firstChildEl(mat, "Color");
    const colorUl = colorEl?.textContent?.trim() ?? "";
    materials.push({ id, name, model, colorUl });
  }
  return materials;
}

/**
 * GSZ XML 의 기존 <Material> 을 이름으로 찾아 물성값만 제자리 수정한다.
 * (materials.js 의 applyMaterialsToDocument 는 <Materials> 전체를 다시 쓰므로
 *  ID·색·Region 매핑을 유지해야 하는 일괄 수정에는 쓰지 않는다.)
 */
import { findFirstTag, allChildEl, firstChildEl, createEl } from "./xml-utils.js";

/** 화면 필드 → <StressStrain> 태그 */
export const MATERIAL_FIELDS = [
  { key: "uw", tag: "UnitWeight", label: "γ (kN/m³)" },
  { key: "dw", tag: "DryWeight", label: "γd (kN/m³)" },
  { key: "c", tag: "CohesionPrime", label: "c' (kPa)" },
  { key: "phi", tag: "PhiPrime", label: "φ' (°)" },
  { key: "c_top", tag: "CTopOfLayer", label: "c 상단" },
  { key: "c_rate", tag: "CRateOfIncrease", label: "c 증가율" },
];

export function materialName(matEl) {
  return (firstChildEl(matEl, "Name")?.textContent ?? firstChildEl(matEl, "n")?.textContent ?? "").trim();
}

/** @returns {{id:string,name:string,model:string,values:Object<string,number>}[]} */
export function readMaterialValues(doc) {
  const mats = findFirstTag(doc, "Materials");
  if (!mats) return [];
  return allChildEl(mats, "Material").map((m) => {
    const ss = firstChildEl(m, "StressStrain");
    const values = {};
    for (const f of MATERIAL_FIELDS) {
      const v = parseFloat(firstChildEl(ss, f.tag)?.textContent ?? "");
      if (Number.isFinite(v)) values[f.key] = v;
    }
    return {
      id: firstChildEl(m, "ID")?.textContent?.trim() ?? "",
      name: materialName(m),
      model: firstChildEl(m, "SlopeModel")?.textContent?.trim() ?? "",
      values,
    };
  });
}

/**
 * @param {Document} doc
 * @param {Object<string,Object<string,number>>} changes  { 재료이름: { uw: 20, phi: 35 } }
 * @returns {{matched:Set<string>, log:{name:string,field:string,from:number|null,to:number}[]}}
 */
export function patchMaterialValues(doc, changes) {
  const out = { matched: new Set(), log: [] };
  const mats = findFirstTag(doc, "Materials");
  if (!mats) return out;
  for (const m of allChildEl(mats, "Material")) {
    const name = materialName(m);
    const ch = changes[name];
    if (!ch) continue;
    out.matched.add(name);
    let ss = firstChildEl(m, "StressStrain");
    if (!ss) {
      ss = doc.createElement("StressStrain");
      m.appendChild(ss);
    }
    for (const f of MATERIAL_FIELDS) {
      const to = ch[f.key];
      if (!Number.isFinite(to)) continue;
      let el = firstChildEl(ss, f.tag);
      const from = el ? parseFloat(el.textContent) : null;
      if (from === to) continue;
      if (el) el.textContent = String(to);
      else ss.appendChild(createEl(doc, f.tag, String(to)));
      out.log.push({ name, field: f.label, from: Number.isFinite(from) ? from : null, to });
    }
  }
  return out;
}

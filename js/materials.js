import {
  createEl,
  removeAllChildren,
  setMaterialDisplayName,
  allChildEl,
  findFirstTag,
} from "./xml-utils.js";
import {
  colorValueToGeostudioULong,
  rgbTripletToULong,
} from "./color.js";

/**
 * GeoStudio `<Materials>` 를 UI 목록 기준으로 통째로 재작성한다.
 * 기존 `<Material>` 노드만 부분 수정할 때 직렬화 후 자식이 사라지던 문제를 피한다.
 */
export function applyMaterialsToDocument(doc, materials, log = () => {}) {
  const root = doc.documentElement;
  let matsNode = findFirstTag(doc, "Materials");
  if (!matsNode) {
    matsNode = doc.createElement("Materials");
    root.appendChild(matsNode);
  } else {
    removeAllChildren(matsNode);
  }

  let updated = 0;
  for (const m of materials) {
    const mid = String(m.id ?? "").trim();
    const model = String(m.model ?? "MohrCoulomb").trim();
    if (!mid) continue;

    const matElem = doc.createElement("Material");
    matsNode.appendChild(matElem);
    matElem.appendChild(createEl(doc, "ID", mid));

    let nameTxt = String(m.name ?? "").trim();
    if (!nameTxt) nameTxt = `Material-${mid}`;
    setMaterialDisplayName(matElem, doc, nameTxt);

    let colorUl = colorValueToGeostudioULong(m.color);
    if (colorUl == null) colorUl = rgbTripletToULong(180, 180, 180);
    matElem.appendChild(createEl(doc, "Color", colorUl));

    matElem.appendChild(createEl(doc, "SlopeModel", model));

    const ss = doc.createElement("StressStrain");
    matElem.appendChild(ss);

    function setSs(tag, val) {
      if (val == null) return;
      const floatVal = Number(val);
      if (!Number.isFinite(floatVal)) return;
      ss.appendChild(createEl(doc, tag, String(floatVal)));
    }

    const uw = m.uw;
    const dw = m.dw;
    if (uw != null && dw != null) {
      ss.appendChild(createEl(doc, "SlopeUseUnitWeightAboveWT", "ConstantValue"));
    }
    setSs("UnitWeight", uw);

    if (model === "MohrCoulomb") {
      setSs("CohesionPrime", m.c);
      setSs("PhiPrime", m.phi);
      setSs("DryWeight", dw);
      setSs("CTopOfLayer", m.c_top);
      setSs("CRateOfIncrease", m.c_rate);
      setSs("CDatum", m.c_datum);
      setSs("DatumElev", m.datum_elev);
    } else if (model === "SFnDepth") {
      setSs("DryWeight", dw);
      setSs("CohesionPrime", m.c);
      setSs("PhiPrime", m.phi);
      setSs("CTopOfLayer", m.c_top);
      setSs("CRateOfIncrease", m.c_rate);
      setSs("CDatum", m.c_datum);
      setSs("DatumElev", m.datum_elev);
    } else if (model === "SFnDatum") {
      setSs("DryWeight", dw);
      setSs("CohesionPrime", m.c);
      setSs("PhiPrime", m.phi);
      setSs("CTopOfLayer", m.c_top);
      setSs("CRateOfIncrease", m.c_rate);
      setSs("CDatum", m.c_datum);
      setSs("DatumElev", m.datum_elev);
    }

    log(`  ID=${mid} [${model}] ${nameTxt}`);
    updated += 1;
  }

  matsNode.setAttribute("Len", String(allChildEl(matsNode, "Material").length));
  return updated;
}

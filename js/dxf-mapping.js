/**
 * DXF → GSZ 기하 교체 (자동 실행 탭용, 간단한 버전)
 * runMapping의 핵심 로직 중 필요한 부분만 분리
 */

import { parseDxfText, loadGszFromArrayBuffer } from "./deps.js";
import {
  readLayersFromDxfParsed,
  WATER_TABLE_LAYER_NAME,
} from "./dxf-read.js";
import {
  applyRegionMappingToDocument,
} from "./mapping.js";
import { serializeXmlDocument, allChildEl, firstChildEl } from "./xml-utils.js";
import { zipToBlob } from "./deps.js";

/**
 * GSZ의 기하를 DXF로 교체 (간단한 버전)
 * @param {{name:string, zip:JSZip, xmlName:string, doc:XMLDocument}} gszFile
 * @param {string} dxfText DXF 파일 내용
 * @returns {Promise<{name:string, zip:JSZip, xmlName:string, doc:XMLDocument}>} 교체된 GSZ
 */
export async function applyDxfToGsz(gszFile, dxfText) {
  const doc = gszFile.doc.cloneNode(true);
  const parsed = await parseDxfText(dxfText);
  const dxfLayers = readLayersFromDxfParsed(parsed);

  // 모든 Analysis 에 대해 (기본값 처리)
  const geometryLayers = new Set(
    Object.keys(dxfLayers).filter((l) => l !== WATER_TABLE_LAYER_NAME)
  );
  const dummyLayerMap = {};
  for (const L of geometryLayers) dummyLayerMap[L] = 1;

  // 먼저 Analysis 1개는 반드시 존재해야 함
  const slopeItemsEl = firstChildEl(doc, "SlopeItem") ? doc.querySelector("SlopeItems") : null;
  if (!slopeItemsEl) {
    // Analysis 가 없으면 생성
    const root = doc.documentElement;
    let si = doc.createElement("SlopeItems");
    let solEl = root.querySelector("SlopeOutputs");
    if (solEl) root.insertBefore(si, solEl);
    else root.appendChild(si);
  }

  // 기본적으로 Analysis ID=1 사용 (첫 번째)
  let primaryId = 1;
  const slopeItemsList = doc.querySelectorAll("SlopeItem");
  if (slopeItemsList.length > 0) {
    const aidEl = firstChildEl(slopeItemsList[0], "AnalysisID");
    if (aidEl && aidEl.textContent) primaryId = parseInt(aidEl.textContent, 10);
  }

  // 지오메트리 빌드 (Material ID는 1로 기본 설정 - 사용자가 따로 설정 가능)
  const geoResult = applyRegionMappingToDocument(
    doc,
    dxfLayers,
    dummyLayerMap,
    primaryId,
    () => {}, // log 함수 - 파이프라인에서는 출력 안 함
    { geometryLayers, deferMaterialSync: true }
  );

  if (!geoResult || !geoResult.layerRegionIds) {
    throw new Error("DXF 기하 빌드 실패");
  }

  // XML 저장
  const newZip = gszFile.zip;
  newZip.file(gszFile.xmlName, serializeXmlDocument(doc));

  return { ...gszFile, doc, zip: newZip };
}

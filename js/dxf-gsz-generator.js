/**
 * DXF → GSZ 파일 생성
 * Fresh 모드: 새로운 GSZ 생성
 * Reuse 모드: 기존 GSZ의 기하만 교체
 */

import { applyMaterialsToDocument } from "./materials.js";
import { createEl, firstChildEl } from "./xml-utils.js";

export async function generateGszFromDxf(params) {
  const {
    regions,
    waterLevel,
    materials,
    mode,
    existingGszBuffer,
    slipEntryPreset,
    kh,
    kv,
    updateWaterFromDxf
  } = params;

  let doc, zip, xmlName;

  // GSZ 로드 또는 템플릿 생성
  if (mode === "reuse" && existingGszBuffer) {
    zip = await JSZip.loadAsync(existingGszBuffer);
    const files = Object.keys(zip.files).filter(f => f.endsWith(".xml"));
    xmlName = files[0];
    if (!xmlName) throw new Error("GSZ 파일에 XML이 없습니다");

    const xmlStr = await zip.file(xmlName).async("string");
    doc = new DOMParser().parseFromString(xmlStr, "application/xml");
  } else {
    // Fresh 모드: 기본 GSZ 구조 생성
    doc = createBaseGszDocument();
    xmlName = "analysis.xml";
    zip = null;
  }

  // 기하 정보 추가
  applyRegionsToDocument(doc, regions);

  // Fresh 모드: 재료 및 분석 파라미터 추가
  if (mode === "fresh") {
    applyMaterialsToDocument(doc, materials);
    syncRegionUsesMaterials(doc, regions, materials);

    // 첫 번째 분석 찾기
    const analyses = doc.getElementsByTagName("Analysis");
    const analysisId = analyses.length > 0 ?
      analyses[0].getElementsByTagName("ID")[0]?.textContent : "1";

    // 수위 설정
    if (waterLevel !== null) {
      applyWaterLevelToAnalysis(doc, analysisId, regions, waterLevel);
    }

    // Slip entry/exit 설정
    if (slipEntryPreset === "auto") {
      applyAutoEntryExit(doc, analysisId, regions);
    }

    // 지진 계수
    applySeismicToAnalysis(doc, analysisId, kh, kv);
  } else if (mode === "reuse" && updateWaterFromDxf && waterLevel !== null) {
    // Reuse 모드이지만 수위 업데이트 선택
    const analyses = doc.getElementsByTagName("Analysis");
    const analysisId = analyses.length > 0 ?
      analyses[0].getElementsByTagName("ID")[0]?.textContent : "1";
    applyWaterLevelToAnalysis(doc, analysisId, regions, waterLevel);
  }

  // GSZ 생성 및 저장
  const newXmlStr = new XMLSerializer().serializeToString(doc);
  const newZip = new JSZip();
  newZip.file(xmlName, newXmlStr);

  const blob = await newZip.generateAsync({ type: "blob" });
  return blob;
}

function createBaseGszDocument() {
  const parser = new DOMParser();
  const xmlStr = `<?xml version="1.0" encoding="utf-8"?>
<Project>
  <FileInfo/>
  <EngCoords UnitWaterWeight="9.81"/>
  <Materials/>
  <GeometryItems>
    <Points Len="0"/>
    <Lines Len="0"/>
    <Regions Len="0"/>
  </GeometryItems>
  <Analyses>
    <Analysis>
      <ID>1</ID>
      <Name>분석 1</Name>
    </Analysis>
  </Analyses>
  <Contexts>
    <Context>
      <AnalysisID>1</AnalysisID>
      <IsDefined>true</IsDefined>
      <RegionUsesMaterials Len="0"/>
    </Context>
  </Contexts>
  <SlopeItems>
    <SlopeItem>
      <AnalysisID>1</AnalysisID>
      <Entry>
        <Seismic Horizontal="0" Vertical="0"/>
        <DataPoints Len="0"/>
        <PiezometricLines/>
        <MaterialUsesPiezs Len="0"/>
        <PressureLines/>
        <LineLoadPoints/>
        <RegionUsesMaterials Len="0"/>
        <SlipEntryExit/>
      </Entry>
    </SlopeItem>
  </SlopeItems>
</Project>`;

  return parser.parseFromString(xmlStr, "application/xml");
}

function applyRegionsToDocument(doc, regions) {
  // 점 수집 및 중복 제거 (단순화 버전)
  const pointMap = new Map();
  let pointId = 1;

  for (const region of regions) {
    const newPointIds = [];
    for (const v of region.vertices) {
      const key = `${v.x.toFixed(5)}_${v.y.toFixed(5)}`;
      if (!pointMap.has(key)) {
        pointMap.set(key, pointId);
        pointId++;
      }
      newPointIds.push(pointMap.get(key));
    }
    region.pointIds = newPointIds;
  }

  // Points 섹션 생성
  const pointsEl = firstChildEl(doc.documentElement, "GeometryItems")
    ? firstChildEl(doc.documentElement, "GeometryItems").getElementsByTagName("Points")[0]
    : null;

  if (pointsEl) {
    pointsEl.parentElement.removeChild(pointsEl);
  }

  const pointsSection = createEl(doc, "Points");
  pointsSection.setAttribute("Len", pointMap.size.toString());

  for (const [key, id] of pointMap.entries()) {
    const [x, y] = key.split("_").map(parseFloat);
    const pt = createEl(doc, "Point");
    pt.setAttribute("ID", id.toString());
    pt.setAttribute("X", x.toFixed(5));
    pt.setAttribute("Y", y.toFixed(5));
    pointsSection.appendChild(pt);
  }

  // Regions 섹션 생성
  const regionsEl = firstChildEl(doc.documentElement, "GeometryItems")
    ? firstChildEl(doc.documentElement, "GeometryItems").getElementsByTagName("Regions")[0]
    : null;

  if (regionsEl) {
    regionsEl.parentElement.removeChild(regionsEl);
  }

  const regionsSection = createEl(doc, "Regions");
  regionsSection.setAttribute("Len", regions.length.toString());

  for (const region of regions) {
    const rgn = createEl(doc, "Region");
    const idEl = createEl(doc, "ID", region.id.toString());
    const pidsEl = createEl(doc, "PointIDs", region.pointIds.join(","));
    rgn.appendChild(idEl);
    rgn.appendChild(pidsEl);
    regionsSection.appendChild(rgn);
  }

  // GeometryItems에 추가
  const geomEl = firstChildEl(doc.documentElement, "GeometryItems");
  if (geomEl) {
    geomEl.appendChild(pointsSection);
    geomEl.appendChild(regionsSection);
  }
}

function syncRegionUsesMaterials(doc, regions, materials) {
  // 각 region에 대해 재료 매핑 생성
  const mappings = regions.map((region, idx) => ({
    regionId: region.id,
    materialId: materials[idx]?.id || "Material-1"
  }));

  // Context 업데이트
  const contexts = doc.getElementsByTagName("Context");
  if (contexts.length > 0) {
    let rumEl = contexts[0].getElementsByTagName("RegionUsesMaterials")[0];
    if (!rumEl) {
      rumEl = createEl(doc, "RegionUsesMaterials");
      contexts[0].appendChild(rumEl);
    } else {
      while (rumEl.firstChild) {
        rumEl.removeChild(rumEl.firstChild);
      }
    }

    rumEl.setAttribute("Len", mappings.length.toString());
    for (const map of mappings) {
      const rum = createEl(doc, "RegionUsesMaterial");
      rum.setAttribute("ID", map.regionId.toString());
      rum.setAttribute("UsesID", map.materialId);
      rumEl.appendChild(rum);
    }
  }

  // SlopeItem Entry도 동일하게
  const slopeItems = doc.getElementsByTagName("SlopeItem");
  for (const item of slopeItems) {
    const entry = firstChildEl(item, "Entry");
    if (!entry) continue;

    let rumEl = firstChildEl(entry, "RegionUsesMaterials");
    if (!rumEl) {
      rumEl = createEl(doc, "RegionUsesMaterials");
      entry.appendChild(rumEl);
    } else {
      while (rumEl.firstChild) {
        rumEl.removeChild(rumEl.firstChild);
      }
    }

    rumEl.setAttribute("Len", mappings.length.toString());
    for (const map of mappings) {
      const rum = createEl(doc, "RegionUsesMaterial");
      rum.setAttribute("ID", map.regionId.toString());
      rum.setAttribute("UsesID", map.materialId);
      rumEl.appendChild(rum);
    }
  }
}

function applyWaterLevelToAnalysis(doc, analysisId, regions, waterLevel) {
  // 수위 선을 DataPoints로 추가
  const slopeItems = doc.getElementsByTagName("SlopeItem");
  for (const item of slopeItems) {
    const aid = firstChildEl(item, "AnalysisID");
    if (!aid || aid.textContent !== analysisId.toString()) continue;

    const entry = firstChildEl(item, "Entry");
    if (!entry) continue;

    // 단순화: 영역 경계의 상단 y좌표를 수위로 사용
    let points = [{ num: 1, x: 0, y: waterLevel }];
    const bounds = calculateRegionBounds(regions);
    points.push({ num: 2, x: bounds.maxX, y: waterLevel });

    // DataPoints 추가
    let dpEl = firstChildEl(entry, "DataPoints");
    if (!dpEl) {
      dpEl = createEl(doc, "DataPoints");
      entry.appendChild(dpEl);
    } else {
      while (dpEl.firstChild) {
        dpEl.removeChild(dpEl.firstChild);
      }
    }

    dpEl.setAttribute("Len", points.length.toString());
    for (const pt of points) {
      const dp = createEl(doc, "DataPoint");
      dp.setAttribute("Number", pt.num.toString());
      dp.setAttribute("X", pt.x.toFixed(5));
      dp.setAttribute("Y", pt.y.toFixed(5));
      dpEl.appendChild(dp);
    }

    // PiezometricLine 추가
    let plEl = firstChildEl(entry, "PiezometricLines");
    if (!plEl) {
      plEl = createEl(doc, "PiezometricLines");
      entry.appendChild(plEl);
    } else {
      while (plEl.firstChild) {
        plEl.removeChild(plEl.firstChild);
      }
    }

    const pl = createEl(doc, "PiezometricLine");
    const plId = createEl(doc, "ID", "1");
    const plDps = createEl(doc, "DataPoints");

    for (const pt of points) {
      const plDp = createEl(doc, "DataPoint", pt.num.toString());
      plDps.appendChild(plDp);
    }

    pl.appendChild(plId);
    pl.appendChild(plDps);
    plEl.appendChild(pl);

    // MaterialUsesPiezs
    let mupEl = firstChildEl(entry, "MaterialUsesPiezs");
    if (!mupEl) {
      mupEl = createEl(doc, "MaterialUsesPiezs");
      entry.appendChild(mupEl);
    } else {
      while (mupEl.firstChild) {
        mupEl.removeChild(mupEl.firstChild);
      }
    }

    // 모든 재료가 이 수위선 사용
    mupEl.setAttribute("Len", regions.length.toString());
    for (let i = 0; i < regions.length; i++) {
      const mup = createEl(doc, "MaterialUsesPiez");
      mup.setAttribute("ID", (i + 1).toString());
      mup.setAttribute("UsesID", "1");
      mupEl.appendChild(mup);
    }
  }
}

function applyAutoEntryExit(doc, analysisId, regions) {
  const bounds = calculateRegionBounds(regions);

  const slopeItems = doc.getElementsByTagName("SlopeItem");
  for (const item of slopeItems) {
    const aid = firstChildEl(item, "AnalysisID");
    if (!aid || aid.textContent !== analysisId.toString()) continue;

    const entry = firstChildEl(item, "Entry");
    if (!entry) continue;

    let seeEl = firstChildEl(entry, "SlipEntryExit");
    if (!seeEl) {
      seeEl = createEl(doc, "SlipEntryExit");
      entry.appendChild(seeEl);
    } else {
      while (seeEl.firstChild) {
        seeEl.removeChild(seeEl.firstChild);
      }
    }

    // 상단 일부를 entry 범위로 설정
    const entryStart = bounds.minX + (bounds.maxX - bounds.minX) * 0.2;
    const entryEnd = bounds.minX + (bounds.maxX - bounds.minX) * 0.8;
    const entryY = bounds.maxY - (bounds.maxY - bounds.minY) * 0.1;

    const lslp = createEl(doc, "LeftSideLeftPt");
    lslp.setAttribute("X", entryStart.toFixed(5));
    lslp.setAttribute("Y", entryY.toFixed(5));

    const lsrp = createEl(doc, "LeftSideRightPt");
    lsrp.setAttribute("X", entryEnd.toFixed(5));
    lsrp.setAttribute("Y", entryY.toFixed(5));

    const linc = createEl(doc, "LeftInc", "20");
    const rslp = createEl(doc, "RightSideLeftPt");
    rslp.setAttribute("X", entryStart.toFixed(5));
    rslp.setAttribute("Y", entryY.toFixed(5));

    const rsrp = createEl(doc, "RightSideRightPt");
    rsrp.setAttribute("X", entryEnd.toFixed(5));
    rsrp.setAttribute("Y", entryY.toFixed(5));

    const rinc = createEl(doc, "RightInc", "20");
    const radinc = createEl(doc, "RadiusInc", "20");

    seeEl.appendChild(lslp);
    seeEl.appendChild(lsrp);
    seeEl.appendChild(linc);
    seeEl.appendChild(rslp);
    seeEl.appendChild(rsrp);
    seeEl.appendChild(rinc);
    seeEl.appendChild(radinc);
  }
}

function applySeismicToAnalysis(doc, analysisId, kh, kv) {
  const slopeItems = doc.getElementsByTagName("SlopeItem");
  for (const item of slopeItems) {
    const aid = firstChildEl(item, "AnalysisID");
    if (!aid || aid.textContent !== analysisId.toString()) continue;

    const entry = firstChildEl(item, "Entry");
    if (!entry) continue;

    let seisEl = firstChildEl(entry, "Seismic");
    if (!seisEl) {
      seisEl = createEl(doc, "Seismic");
      entry.insertBefore(seisEl, entry.firstChild);
    }

    seisEl.setAttribute("Horizontal", kh.toFixed(3));
    seisEl.setAttribute("Vertical", kv.toFixed(3));
  }
}

function calculateRegionBounds(regions) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const region of regions) {
    for (const v of region.vertices) {
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
  }

  return {
    minX: isFinite(minX) ? minX : 0,
    maxX: isFinite(maxX) ? maxX : 100,
    minY: isFinite(minY) ? minY : 0,
    maxY: isFinite(maxY) ? maxY : 100
  };
}

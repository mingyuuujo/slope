/**
 * DXF → Region 데이터 변환
 * DXF 레이어를 GSZ 호환 region 구조로 변환
 */

export async function parseDxfToRegions(dxfText, layerFilter = null) {
  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(dxfText);
  } catch (e) {
    throw new Error(`DXF 파싱 실패: ${e.message}`);
  }

  if (!dxf.entities || !Array.isArray(dxf.entities)) {
    throw new Error("DXF 파일에 엔티티가 없습니다");
  }

  // 디버깅: 모든 엔티티 타입 로깅
  const entityTypes = {};
  dxf.entities.forEach(e => {
    const type = e.type || "unknown";
    entityTypes[type] = (entityTypes[type] || 0) + 1;
  });
  console.log("DXF 엔티티 타입:", entityTypes);

  // 폴리선 추출 (폐합 여부 상관없이)
  const polylines = dxf.entities.filter(e => {
    if (!e.vertices || !Array.isArray(e.vertices) || e.vertices.length < 3) {
      return false;
    }
    // LWPOLYLINE, POLYLINE 타입
    const isPolyline = e.type === "LWPOLYLINE" || e.type === "POLYLINE";
    if (isPolyline) {
      console.log(`${e.type}: isClosed=${e.isClosed}, vertices=${e.vertices.length}, layer=${e.layer}`);
    }
    return isPolyline;
  }).map(e => {
    // 폐합되지 않은 폴리선을 폐합 폴리선으로 변환
    if (!e.isClosed && e.vertices.length >= 3) {
      const first = e.vertices[0];
      const last = e.vertices[e.vertices.length - 1];
      // 첫 점과 마지막 점이 다르면 첫 점 추가해서 폐합
      if (Math.abs(first.x - last.x) > 0.001 || Math.abs(first.y - last.y) > 0.001) {
        e.vertices = [...e.vertices, { x: first.x, y: first.y }];
      }
      e.isClosed = true;
    }
    return e;
  }).filter(e => e.isClosed === true);

  console.log(`찾은 폐합 폴리선: ${polylines.length}개`);

  // 레이어 필터
  let filtered = polylines;
  if (layerFilter && layerFilter.trim()) {
    console.log(`레이어 필터 적용: "${layerFilter}"`);
    filtered = polylines.filter(p => p.layer && p.layer.includes(layerFilter));
    console.log(`필터 후: ${filtered.length}개`);
  }

  if (filtered.length === 0) {
    // 모든 폴리선 정보 출력
    console.log("모든 폴리선:");
    dxf.entities.filter(e => e.type === "LWPOLYLINE" || e.type === "POLYLINE").forEach(e => {
      console.log(`  ${e.type}: isClosed=${e.isClosed}, layer=${e.layer}, vertices=${e.vertices?.length}`);
    });
    throw new Error("조건에 맞는 폐합 폴리선이 없습니다");
  }

  // 수위 레이어 감지
  const waterPolyline = readWaterTablePolylineFromDxf(dxf);
  let waterLevel = null;
  if (waterPolyline && waterPolyline.vertices && waterPolyline.vertices.length > 0) {
    // 수위 라인의 Y 좌표 평균
    const yValues = waterPolyline.vertices.map(v => v.y);
    waterLevel = (Math.max(...yValues) + Math.min(...yValues)) / 2;
  }

  // Region 객체 생성
  const regions = filtered.map((poly, idx) => {
    const vertices = poly.vertices.map(v => ({ x: v.x, y: v.y }));
    return {
      id: idx + 1,
      vertices,
      layer: poly.layer || `region-${idx + 1}`,
      pointIds: null // 나중에 채워짐
    };
  });

  return {
    regions,
    waterLevel,
    bounds: calculateBounds(filtered)
  };
}

function readWaterTablePolylineFromDxf(dxf) {
  if (!dxf.entities) return null;

  const waterEntities = dxf.entities.filter(e =>
    e.layer && e.layer.includes("수위")
  );

  if (waterEntities.length === 0) return null;

  // 가장 긴 폴리선 선택 (수위 라인)
  let longest = null;
  let maxLen = 0;

  for (const e of waterEntities) {
    if (!e.vertices || !Array.isArray(e.vertices)) continue;
    const len = e.vertices.length;
    if (len > maxLen) {
      maxLen = len;
      longest = e;
    }
  }

  return longest;
}

function calculateBounds(polylines) {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const poly of polylines) {
    if (!poly.vertices) continue;
    for (const v of poly.vertices) {
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

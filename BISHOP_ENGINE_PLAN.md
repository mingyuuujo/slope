# 웹 기반 Bishop 자동 계산 엔진 — 설계 문서

## 1. 배경 및 목적

현재 웹 도구는 **GeoStudio가 이미 계산을 완료한 .gsz 결과**를 읽어 FOS와 임계 슬립서클을 표시하는 구조다.  
이 문서는 GeoStudio 없이 **브라우저 단독으로** Bishop 간편법 계산 엔진을 구현하기 위한 분석·설계를 정리한다.

---

## 2. 현재 .gsz 파일 구조

.gsz 파일은 ZIP 아카이브로, 내부 구조는 다음과 같다.

```
NO.17.gsz (ZIP)
├── NO.17.xml                          ← 모델 정의 전체
│   ├── <GeometryItems>                ← Points / Lines / Regions
│   ├── <Materials>                    ← 재료 물성 (c', φ', γ)
│   ├── <Analyses>                     ← 해석 목록 (Bishop, 상시/지진시 등)
│   ├── <Contexts>                     ← 해석별 Region→Material 매핑
│   └── <SlopeItems>                   ← 슬립서피스 그리드/반경 설정
│
├── 1.1 지반개량_상시(49.8)/
│   ├── NO.17.xml                      ← 결과 저장용 복사본 (FOS 미포함)
│   └── 001/
│       ├── lambdafos_2499.csv         ← 임계 FOS (FOSByMoment 최솟값)
│       ├── slip_surface.csv           ← 탐색 전체 슬립서클 결과
│       ├── slice_2499.csv             ← 임계원 슬라이스 상세값
│       └── interslice_2499.csv        ← 슬라이스간 힘
│
├── 2.1 지반개량_지진시(49.8)/
│   └── 001/ ...
└── ...
```

### lambdafos CSV 예시

```
LambdaEntryNum, Lambda, FOSByForce, FOSByMoment
1, 0, , 1.8457641
```

### slip_surface CSV 예시

```
SlipNum, SlipFOS, SlipCenterX, SlipCenterY, SlipRadius, ...
1, 3.307, -5.566, 34.396, 43.729, ...
2, 3.262, -5.679, 33.721, 43.167, ...
```

---

## 3. Bishop 간편법 알고리즘

### 3.1 계산 흐름

```
입력
 ├── 지형 폴리곤 (레이어별)
 ├── 재료 물성: c', φ', γ (포화/불포화)
 ├── 간극수압: 수위선 또는 Ru 계수
 └── 슬립서클 탐색 범위: 그리드(중심) × 반경 범위

탐색 루프  [중심 그리드 N×M] × [반경 K단계]
 └── 각 원에 대해:
      1. 원과 지표면 교점 → Entry / Exit 좌표
      2. Entry~Exit 구간을 n개 수직 슬라이스로 분할
      3. 각 슬라이스 계산
         - 무게 W  = γ × 슬라이스 면적
         - 저면 각도 α
         - 간극수압 u
         - 유효 법선응력 σ'n
         - 전단강도 τ = c' + σ'n·tan(φ')
      4. Bishop 수렴 반복 (초기값 FOS=1.0, 보통 5~15회)
         FOS_new = Σ[τ·b / cosα·(1 + tanα·tanφ'/FOS)] / Σ[W·sinα]
      5. |FOS_new - FOS_old| < ε (=0.001) 이면 수렴

출력: 최소 FOS + 해당 슬립서클 (CenterX, CenterY, Radius)
```

### 3.2 지진시 추가 항 (의사정적법)

```
ActivatingMoment += k_h × W × y_centroid    (수평 지진계수 k_h)
```

---

## 4. 구현 난이도 분석


| 구성 요소              | 난이도 | 비고                                 |
| ------------------ | --- | ---------------------------------- |
| Bishop 반복 수렴 공식    | ★☆☆ | 수식 단순, JS 구현 쉬움                    |
| 슬라이스 분할 및 무게 계산    | ★★☆ | 폴리곤 클리핑 필요                         |
| **Region 폴리곤 재구성** | ★★★ | XML Lines → 순서있는 경계 폴리곤 재조립이 핵심 난관 |
| 슬라이스-재료 매핑         | ★★☆ | point-in-polygon 판정 (각 레이어 순서 중요)  |
| 간극수압 처리            | ★★☆ | 수위선 교점 → 압력수두 계산                   |
| 그리드 탐색 최적화         | ★☆☆ | 단순 이중 루프, Web Worker로 분리 가능        |


---

## 5. XML 파싱 대상 상세

### 5.1 GeometryItems

```xml
<Points Len="68">
  <Point ID="1" X="-39.482" Y="-39.645" />
  ...
</Points>
<Lines Len="85">
  <Lines>        <!-- 각 Line 엘리먼트는 Point ID 배열 포함 -->
    ...
  </Lines>
</Lines>
<Regions Len="18">
  <Region> ... </Region>
</Regions>
```

- Point: 좌표 원점 데이터
- Line: 연결된 Point ID들로 구성된 선분 (경계선)
- Region: Line ID들로 구성된 닫힌 영역 → **폴리곤 재구성 필요**

### 5.2 Materials (Mohr-Coulomb)

```xml
<Material>
  <ID>3</ID>
  <Name>필터사석</Name>
  <SlopeModel>MohrCoulomb</SlopeModel>
  <!-- StressStrain 내부에 c', φ', γ_sat, γ_unsat 존재 -->
</Material>
```

### 5.3 Contexts (해석별 Region→Material 매핑)

```xml
<Context>
  <AnalysisID>3</AnalysisID>    <!-- 1.1 지반개량_상시(49.8) -->
  <RegionUsesMaterials Len="8">
    <RegionUsesMaterial ID="1" UsesID="7" />   <!-- Region 1 → Material 7 -->
    <RegionUsesMaterial ID="2" UsesID="16" />
    ...
  </RegionUsesMaterials>
</Context>
```

### 5.4 SlopeItems (슬립서피스 탐색 설정)

```xml
<SlopeItem>
  <AnalysisID>3</AnalysisID>
  <Entry>
    <SlipSurfaceGrid
      PointUL="7" PointLL="8" PointLR="9"
      NumXInc="10" NumYInc="10" />       <!-- 10×10 = 100개 중심점 -->
    <SlipSurfaceRadius
      PointUL="11" PointUR="14" PointLL="12" PointLR="13"
      NumInc="20" />                      <!-- 20단계 반경 -->
  </Entry>
</SlopeItem>
```

총 탐색 원 수: 100 × 20 = **2,000개**

---

## 6. 기존 코드 재사용 가능 부분


| 기존 파일                | 재사용 가능 내용                                  |
| -------------------- | ------------------------------------------ |
| `slip-entry-exit.js` | 슬립서클과 지형면 교점(Entry/Exit) 계산 — 핵심 로직 이미 구현됨 |
| `geometry.js`        | 폴리곤 면적, 교차 판정 등 유틸리티                       |
| `xml-utils.js`       | XML DOM 파싱 헬퍼                              |
| `result-parser.js`   | ZIP 내 CSV 읽기 패턴 참고                         |


---

## 7. 구현 단계 (제안)

### Phase 1 — XML 파싱 & 지오메트리 재구성

- `xml-utils.js` 확장: Points/Lines/Regions → 폴리곤 배열
- 테스트: NO.17 모델을 파싱해 캔버스에 레이어별 폴리곤 렌더링

### Phase 2 — Bishop 계산 코어

- `bishop-engine.js` 신규 작성
- 입력: 폴리곤[], 재료[], 수위선, 슬립원(cx, cy, r)
- 출력: FOS (수렴값)
- 검증: 기존 CSV 결과값(FOS=1.846)과 비교

### Phase 3 — 그리드 탐색 + 최솟값 탐색

- Web Worker로 계산 분리 (UI 블로킹 방지)
- 진행률 표시 (몇 % 완료)
- 결과: 최소 FOS 원 + 컨투어맵 (선택)

### Phase 4 — 기존 결과뷰어와 통합

- 계산 완료 시 기존 `rvState.allResults[]` 형식에 맞춰 삽입
- 임계 슬립서클 캔버스 렌더링

---

## 8. 주요 제약 사항

1. **수위선 파싱 복잡도**: GeoStudio는 Piezometric Line, Ru 계수, Seepage 결과 등 여러 방식을 지원. 초기 구현은 Piezometric Line 방식만 지원하는 것이 현실적.
2. **Region 폴리곤 위상 복잡도**: 공유 경계선, 복잡한 레이어 중첩 구조를 완전히 재현하려면 Half-Edge 자료구조 수준의 처리가 필요할 수 있음.
3. **정밀도 검증 필요**: 슬라이스 수, 수렴 기준에 따라 GeoStudio 결과와 미세한 차이 발생 가능. 허용 오차 ±0.5% 목표.
4. **계산 시간**: 2,000원 × 30슬라이스 × 10회 반복 = 약 60만 회 연산. Web Worker 사용 시 현대 브라우저에서 1~3초 수준으로 처리 가능.

---

## 9. 참고 자료

- GeoStudio SLOPE/W Engineering Methodology (v8 PDF)
- Bishop, A.W. (1955). "The use of the slip circle in the stability analysis of slopes." *Géotechnique*, 5(1), 7–17.
- 현재 결과 검증용 데이터: `NO.17(휴식부두)_extracted/1.1 지반개량_상시(49.8)/001/lambdafos_2499.csv` (FOS = 1.8457641)


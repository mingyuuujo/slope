# 결과 뷰어 탭 구현 계획

## 개요

해석이 완료(Solved)된 `.gsz` 파일을 업로드하면, 각 해석별 **최소 안전율(FOS)** 과 **임계 파괴원호(Critical Slip Circle)** 를 추출하여 리즌 캔버스 위에 오버레이하고 PNG 이미지로 내보낼 수 있는 새 탭을 추가한다.

---

## 실제 파일 구조 (NO.17(휴식부두).gsz 기준)

```
NO.17(휴식부두).gsz  (ZIP)
├── NO.17.xml                          ← 루트: 기하·재료·해석 입력 정의 (15개 해석)
├── ThumbNail.bmp
├── 1.1 지반개량_상시(49.8)/
│   ├── 001/
│   │   ├── lambdafos_2499.csv         ← 임계 슬립ID(2499) + FOS(1.8457641)
│   │   ├── slip_surface.csv           ← 전체 슬립서클 9,261행 (FOS, 중심XY, 반경)
│   │   ├── slice_2499.csv             ← 임계 슬립의 슬라이스 데이터
│   │   └── interslice_2499.csv        ← 슬라이스 간 력 데이터
│   └── NO.17.xml                      ← 해석별 XML (결과 참조 포함)
├── 2.1 지반개량_지진시(49.8)/          (동일 구조)
│   └── ...
└── ... (15개 해석 디렉토리)
```

### 핵심 파일: `lambdafos_XXXX.csv`


| 컬럼               | 내용                           |
| ---------------- | ---------------------------- |
| `LambdaEntryNum` | 항목 번호                        |
| `Lambda`         | Lambda 값                     |
| `FOSByForce`     | 힘 기반 안전율 (Spencer 등)         |
| `FOSByMoment`    | 모멘트 기반 안전율 → **이 값이 최종 FOS** |


- **파일명의 숫자** = 임계 슬립면 ID
- 예: `lambdafos_2499.csv` → 임계 슬립 ID = 2499

### 핵심 파일: `slip_surface.csv`


| 컬럼                                    | 내용              |
| ------------------------------------- | --------------- |
| `SlipNum`                             | 슬립서클 번호 (1~N)   |
| `SlipFOS`                             | 이 슬립의 안전율       |
| `SlipCenterX`                         | 원호 중심 X (세계 좌표) |
| `SlipCenterY`                         | 원호 중심 Y (세계 좌표) |
| `SlipRadius`                          | 반경 (세계 좌표 단위)   |
| `SlipVolume`, `SlipWeight`            | 부피, 무게          |
| `ResistingMoment`, `ActivatingMoment` | 저항/활동 모멘트       |


---

## 전체 해석 결과 (NO.17 기준)


| 해석명                     | 임계 SlipID | 안전율 (FOS) |
| ----------------------- | --------- | --------- |
| 0.1 무처리_상시              | 4237      | **0.378** |
| 1.1 지반개량_상시(49.8)       | 2499      | **1.846** |
| 1.2 지반개량_상시(33.2)       | 5117      | **1.576** |
| 1.3 지반개량_상시(24.9)       | 5516      | **1.356** |
| 2.1 지반개량_지진시(49.8)      | 231       | **1.279** |
| 2.2 지반개량_지진시(33.2)      | 231       | **1.279** |
| 2.3 지반개량_지진시(24.9)      | 205       | **1.232** |
| 3.1 지반개량_편심하중_상시(49.8)  | 189       | **1.435** |
| 3.2 지반개량_편심하중_상시(33.2)  | 189       | **1.435** |
| 3.3 지반개량_편심하중_상시(24.9)  | 189       | **1.435** |
| 4.1 지반개량_편심하중_지진시(49.8) | 189       | **1.253** |
| 4.2 지반개량_편심하중_지진시(33.2) | 189       | **1.253** |
| 4.3 지반개량_편심하중_지진시(24.9) | 189       | **1.253** |
| 5.1 시공시                 | 287       | **1.432** |


---

## UI 설계

### 탭 구성

```
[ 사면 안정 검토 ]  [ GSZ 파라미터 편집 ]  [ 결과 뷰어 ]  ← 새 탭
```

### 레이아웃

```
┌─────────────────────────────────────────────────────────────┐
│  GSZ 파일 업로드: [파일 선택 버튼]  NO.17(휴식부두).gsz     │
│                                                             │
│  해석 선택: [드롭다운 ▼]  1.1 지반개량_상시(49.8)           │
│                                                             │
├─────────────────────────┬───────────────────────────────────┤
│  캔버스 영역             │  결과 요약                        │
│                         │  ┌──────────────────────────────┐ │
│  [리즌 채색 + 파괴원호]  │  │  안전율 (FOS)                │ │
│                         │  │  ┌────────────────────────┐  │ │
│                         │  │  │     1.846              │  │ │
│  ← 파괴원호(붉은 선)     │  │  └────────────────────────┘  │ │
│                         │  │  임계 슬립면 ID: 2499         │ │
│                         │  │  중심: (-1.10, 31.66)         │ │
│                         │  │  반경: 43.26 m               │ │
│                         │  └──────────────────────────────┘ │
│                         │                                   │
│                         │  [PNG 다운로드]                   │
└─────────────────────────┴───────────────────────────────────┘
│  전체 해석 결과 요약 테이블                                   │
│  해석명 | FOS | 임계슬립ID | 중심X | 중심Y | 반경 | 판정      │
└─────────────────────────────────────────────────────────────┘
```

### FOS 판정 기준 (안전율 색상 표시)


| FOS             | 판정  | 색상    |
| --------------- | --- | ----- |
| ≥ 1.5           | 안전  | 초록    |
| 1.2 ≤ FOS < 1.5 | 주의  | 노랑/주황 |
| < 1.2           | 불안전 | 빨강    |


---

## 구현 단계

### Step 1. 새 탭 추가 (`index.html`)

```html
<button class="tab-btn" data-tab="result">결과 뷰어</button>
<div id="tab-result" class="tab-content" style="display:none">
  <!-- 파일 업로드 / 해석 선택 -->
  <!-- 캔버스 + 결과 패널 (2컬럼) -->
  <!-- 전체 결과 테이블 -->
</div>
```

### Step 2. 결과 파서 모듈 (`web/js/result-parser.js`)

```javascript
// 주요 함수

// 1. lambdafos_*.csv에서 임계 슬립 ID + FOS 추출
async function parseCriticalFOS(zip, analysisDir)
// 반환: { slipId, fos, fosType: 'moment'|'force' }

// 2. slip_surface.csv에서 임계 슬립 기하 추출
async function parseCriticalSlipGeometry(zip, analysisDir, slipId)
// 반환: { centerX, centerY, radius, fos, slipNum }

// 3. 전체 해석 결과 일괄 파싱
async function parseAllResults(zip)
// 반환: Map<analysisDir, { analysisName, fos, centerX, centerY, radius, slipId }>
```

### Step 3. 결과 뷰어 모듈 (`web/js/result-viewer.js`)

```javascript
// 주요 함수

// 1. 결과 뷰어 탭 초기화
function initResultViewer()

// 2. 특정 해석의 결과를 캔버스에 렌더링
// - 기존 리즌 채색 (gsz-editor.js의 drawRegionCanvas 재사용)
// - 파괴원호 오버레이 (빨간 점선 원호)
// - FOS 텍스트 표시
function renderResultCanvas(analysisResult)

// 3. 파괴원호 그리기
// - world 좌표 → canvas 좌표 변환 (기존 transform 재사용)
// - 원호 범위: 지표면 교차점 사이의 호만 표시
function drawSlipCircle(ctx, cx, cy, r, transform)

// 4. PNG 다운로드
// canvas.toDataURL('image/png') → <a> 다운로드
function downloadCanvasImage(filename)

// 5. 전체 결과 요약 테이블 렌더링
function renderResultTable(allResults)
```

### Step 4. 기존 코드 재사용 포인트


| 재사용 대상                                        | 위치              | 사용 목적        |
| --------------------------------------------- | --------------- | ------------ |
| `drawRegionCanvas()` 또는 그 내부 로직               | `gsz-editor.js` | 리즌 채색 배경 그리기 |
| 월드→캔버스 좌표 변환 (`offX`, `offY`, `scale`)        | `gsz-editor.js` | 파괴원호 좌표 변환   |
| `parseMaterials()`, `parseRegionsAndPoints()` | `gsz-editor.js` | 리즌·재료 데이터 로드 |
| JSZip                                         | 기존 의존성          | ZIP 파일 읽기    |


---

## 파괴원호 그리기 알고리즘

```
1. 임계 슬립: centerX, centerY, radius (세계 좌표)

2. 캔버스 좌표 변환:
   cx_canvas = (centerX - minX) * scale + offX
   cy_canvas = -(centerY - minY) * scale + offY   ← Y축 반전
   r_canvas  = radius * scale

3. 원호 범위 결정:
   - 원과 지표면(최상단 폴리곤 경계)의 교차점 2개를 구함
   - 교차점 사이의 하단 호(arc)만 그림
   - 교차점이 없으면 전체 원 그림 (fallback)

4. 캔버스 렌더링:
   ctx.beginPath()
   ctx.arc(cx_canvas, cy_canvas, r_canvas, startAngle, endAngle)
   ctx.strokeStyle = '#e53935'  // 빨간색
   ctx.lineWidth = 2
   ctx.setLineDash([6, 3])
   ctx.stroke()
```

---

## 데이터 흐름

```
.gsz 파일 업로드
    │
    ▼
JSZip.loadAsync(file)
    │
    ├─► NO.17.xml 파싱 (기존 gsz-editor.js 재사용)
    │     └─► 리즌, 포인트, 재료, 해석명 추출
    │
    └─► 각 해석 디렉토리 스캔
          └─► lambdafos_*.csv 읽기
                │  파일명 → 임계 슬립 ID
                │  FOSByMoment → FOS 값
                ▼
              slip_surface.csv 읽기
                │  SlipNum == 임계 ID인 행
                │  → CenterX, CenterY, Radius
                ▼
              결과 Map에 저장

해석 선택 (드롭다운)
    │
    ▼
renderResultCanvas(selectedResult)
    ├─► 리즌 채색 캔버스 그리기
    ├─► 파괴원호 오버레이
    └─► FOS 텍스트 표시

[PNG 다운로드] 클릭
    └─► canvas.toDataURL('image/png') → download
```

---

## 추가 고려사항

### 비원형 슬립면 (Non-circular)

- `slip_surface.csv`에 `SlipCenterX/Y/Radius` 외 별도 점열 컬럼이 있을 경우 대응 필요
- 우선 원형만 구현하고, 비원형은 추후 확장

### 다중 해석 일괄 내보내기

- "전체 해석 PNG 일괄 다운로드" 버튼 → ZIP으로 묶어 다운로드 (jszip 활용)

### GSZ 파라미터 편집 탭과 연동

- 편집 탭에서 파라미터 수정 후 다운로드한 .gsz를 다시 이 탭에 올려 결과 비교 가능

### 안전율 기준 설정

- 향후 사용자가 FOS 임계값을 설정할 수 있도록 입력 필드 추가 가능

---

## 구조계산서 Excel 자동 생성

### 목표

`.gsz` 파일을 업로드하면 `**구조계산(샘플).xlsx**` 와 동일한 서식의 구조계산 Excel 파일을 자동 생성·다운로드.

---

### 샘플 Excel 파일 구조 분석 (`구조계산(샘플).xlsx`)

**시트명**: `가호안(1)(I-I') 원호활동` | 범위: `B1:AI65` | 이미지 3개 포함


| 구역        | 행       | 내용                              |
| --------- | ------- | ------------------------------- |
| 헤더        | R1~R3   | 프로젝트명 / 구조물명 / 검토항목 (원호활동 검토)   |
| 사용재료 설계정수 | R6~R15  | 재료별 γt, γsat, Φ, c 테이블          |
| 원지반 설계정수  | R17~R23 | 지반층별 γt, γsat, Φ, c 테이블         |
| 결과 요약     | R25~R29 | 시공시/상시/지진시 FOS 요약 (수식 참조)       |
| 시공시 상세    | R34~R43 | 단면 이미지(R34-40) + 기준/검토 안전율 + 판정 |
| 상시 상세     | R45~R54 | 단면 이미지(R45-51) + 기준/검토 안전율 + 판정 |
| 지진시 상세    | R56~R65 | 단면 이미지(R56-62) + 기준/검토 안전율 + 판정 |


**이미지 앵커 (TwoCellAnchor)**


| 이미지      | from(col, row) | to(col, row) | 해당 케이스  |
| -------- | -------------- | ------------ | ------- |
| Image[2] | (2, 34)        | (34, 40)     | 시공시 단면도 |
| Image[0] | (2, 45)        | (34, 51)     | 상시 단면도  |
| Image[1] | (2, 56)        | (34, 62)     | 지진시 단면도 |


---

### .gsz → Excel 데이터 매핑

```
.gsz 데이터 소스                    Excel 셀
─────────────────────────────────────────────────────
XML <Materials>
  UnitWeight (γt)               → 사용재료 테이블 γt 열
  DryWeight  (γsat)             → 사용재료 테이블 γsat 열
  PhiPrime   (Φ)                → 사용재료 테이블 Φ 열
  CohesionPrime (c)             → 사용재료 테이블 c 열

XML <Materials> (원지반 레이어)
  원지반 층 (점토/모래/자갈/풍화토) → 원지반 설계정수 테이블

lambdafos_XXXX.csv
  FOSByMoment                   → 검토안전율 셀 (R43, R54, R65)

해석명 패턴 분류
  "시공시" 포함                  → 시공시 섹션 (R34-43)
  "상시" 포함 (지진시 제외)       → 상시 섹션 (R45-54)
  "지진시" 포함                  → 지진시 섹션 (R56-65)

canvas renderResultCanvas()
  toDataURL('image/png')        → 해당 섹션 이미지 (TwoCellAnchor)
```

---

### 해석 케이스 분류 로직

GSZ 내 해석명을 3가지 케이스로 분류:


| 케이스 | 해석명 키워드       | 기준 안전율 | Excel 섹션 |
| --- | ------------- | ------ | -------- |
| 시공시 | `시공시`         | 1.1    | R34~R43  |
| 상시  | `상시` (지진시 제외) | 1.3    | R45~R54  |
| 지진시 | `지진시`         | 1.1    | R56~R65  |


- 동일 케이스에 복수 해석 존재 시 → **최솟값(최소 FOS)** 채택 (보수적 판정)
- 케이스 미해당 해석은 결과 테이블에만 표시

---

### UI 추가 (결과 뷰어 탭 하단)

```
┌─────────────────────────────────────────────────────┐
│  구조계산서 Excel 생성                                 │
│                                                     │
│  프로젝트명: [___________________]                    │
│  구조물명:  [___________________]                    │
│  단면명:    [___________________]  (예: I-I')        │
│                                                     │
│  [ Excel 구조계산서 다운로드 (.xlsx) ]                │
└─────────────────────────────────────────────────────┘
```

---

### 구현 단계

#### Step E1. ExcelJS 라이브러리 추가

```html
<!-- index.html -->
<script src="https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js"></script>
```

또는 npm 패키지로 번들링:

```bash
npm install exceljs
```

#### Step E2. 해석 분류 모듈 (`web/js/analysis-classifier.js`)

```javascript
// 해석명 → 케이스(시공시/상시/지진시) 분류
function classifyAnalysis(analysisName)
// 반환: 'construction' | 'normal' | 'seismic' | 'other'

// 케이스별 최소 FOS 선택
function selectRepresentativeResults(allResults)
// 반환: { construction, normal, seismic }
//   각각: { analysisName, fos, slipId, centerX, centerY, radius, imagePng }
```

#### Step E3. Excel 생성 모듈 (`web/js/excel-report.js`)

```javascript
// 주요 함수

// 1. 전체 구조계산서 생성
async function generateStructuralReport(options)
// options: { zip, allResults, materials, projectName, structureName, sectionName }
// 반환: Blob (xlsx)

// 2. 헤더 작성
function writeHeader(ws, projectName, structureName, sectionName)

// 3. 재료 물성 테이블 작성
function writeMaterialsTable(ws, materials)
// - 사용재료 설계정수 (R6~R15)
// - 원지반 설계정수 (R17~R23)

// 4. 결과 요약 테이블 작성
function writeSummaryTable(ws, results)
// - 시공시/상시/지진시 FOS + 기준 + 판정 (R25~R29)

// 5. 케이스별 상세 결과 작성
function writeCaseDetail(ws, caseResult, startRow, requiredFOS)
// - 기준/검토 안전율 + 판정 텍스트
// - 이미지 삽입 (TwoCellAnchor: col 2~34, rows startRow~startRow+6)

// 6. 이미지 삽입
async function insertCanvasImage(wb, ws, pngDataUrl, fromRow, toRow)

// 7. Excel 다운로드
function downloadExcel(blob, filename)
```

#### Step E4. 이미지 생성 파이프라인

```
각 케이스별:
    1. renderResultCanvas(caseResult) → offscreen canvas
    2. canvas.toDataURL('image/png') → base64
    3. base64 → Uint8Array → ExcelJS imageId
    4. ws.addImage(imageId, { tl:{col:1,row:startRow-1}, br:{col:33,row:startRow+5} })
```

#### Step E5. 재료 분류 (XML → 사용재료 vs 원지반)

GSZ XML의 `<Materials>` 에서:

- **사용재료**: 색상·이름으로 구분 (무근콘크리트, 블록, 토사 등)
- **원지반**: `<SlopeModel>` 또는 이름 패턴으로 구분 (점토, 모래, 자갈, 풍화토 등)
- 분류 불가 시 → 단일 통합 테이블로 출력

---

### 데이터 흐름 (Excel 생성)

```
.gsz 파일 업로드
    │
    ├─► 기존 result-parser.js 로 전체 해석 결과 파싱
    │     └─► allResults Map
    │
    ├─► XML 파싱으로 재료 물성 추출
    │     └─► materials[]
    │
    ├─► 해석 분류 (시공시/상시/지진시)
    │     └─► { construction, normal, seismic }
    │
    ├─► 각 케이스 renderResultCanvas() → PNG
    │     └─► { constructionPng, normalPng, seismicPng }
    │
    └─► ExcelJS로 xlsx 빌드
          ├─► 헤더 셀 작성
          ├─► 재료 테이블 작성
          ├─► 결과 요약 테이블 작성
          ├─► 케이스별 상세 작성 + 이미지 삽입
          └─► Blob 다운로드
```

---

### 셀 병합 구조 (샘플 기반)


| 구역     | 병합 예시      | 내용             |
| ------ | ---------- | -------------- |
| 재료명    | `C8:H8`    | 무근콘크리트         |
| γt 값   | `I8:N8`    | 22.6           |
| γsat 값 | `O8:T8`    | 22.6           |
| Φ 값    | `U8:Y8`    | 45             |
| c 값    | `Z8:AD8`   | 1000           |
| 비고     | `AE8:AI8`  | -              |
| 검토안전율  | `O43:Y43`  | =1.848 (FOS 값) |
| 판정     | `Z43:AI43` | O.K / N.G      |


---

### 사용 라이브러리


| 라이브러리             | 용도                |
| ----------------- | ----------------- |
| ExcelJS (브라우저 번들) | xlsx 파일 생성·이미지 삽입 |
| JSZip (기존)        | .gsz 파일 읽기        |
| Canvas API (기존)   | 단면도 이미지 렌더링       |


---

### 구현 파일 목록


| 파일                              | 역할                      |
| ------------------------------- | ----------------------- |
| `web/js/result-parser.js`       | FOS + 슬립 기하 파싱 (기존 계획)  |
| `web/js/result-viewer.js`       | 결과 캔버스 렌더링 (기존 계획)      |
| `web/js/analysis-classifier.js` | 해석명 → 케이스 분류 (신규)       |
| `web/js/excel-report.js`        | Excel 구조계산서 생성 (신규)     |
| `web/index.html`                | 탭 UI + Excel 다운로드 버튼 추가 |



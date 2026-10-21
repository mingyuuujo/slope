# SLOPE/W 자동화 — 작업 인수인계 (2026-10-22 기준)

회사에서 이어서 작업할 때 이 문서부터 읽으세요. 무엇을 만들었는지, 어떻게 연결되는지, 다음에 뭘 해야 하는지가 들어 있습니다.

## 1. 목표와 지금 상태

**목표:** 매일 반복하는 "단면·물성·수위·하중 수정 → GeoStudio 해석 → 결과 확인"을 입력값만 바꾸고 버튼 한 번으로 끝내기.

**지금 가능한 것 (모두 실제 `NO.17(휴식부두).gsz` 로 시험함):**

| 바뀌는 것 | 하는 일 | 위치 |
|---|---|---|
| 단면 형상 | DXF 교체 → 이전 Region↔재료 매핑 자동 승계 | Region 매핑 탭 |
| 물성값 | 이름이 같은 재료에 일괄 적용, 라이브러리 JSON 저장 | 일괄 물성 적용 탭 |
| 수위·kh·상재하중 | 템플릿으로 해석별 적용 | 케이스 템플릿 탭 |
| 해석 실행 | GeoCmd 로 창 없이 일괄 해석 | `runner/` |
| 결과 확인 | 기준 FOS 판정 · 전회 대비 · CSV | 배치 결과 탭 |
| 위 전부를 한 번에 | 적용 → 해석 → 결과 | **자동 실행 탭** |

## 2. 전체 구조

```
[웹 브라우저]                                    [내 PC]
 자동 실행 탭  ── GSZ(수정본) ──HTTP 127.0.0.1:8770──▶ runner/server.py
   ├ 물성 라이브러리(JSON) → material-patch.js            └ GeoCmd.exe /solve
   ├ 케이스 규칙 → case-template.js                          └ solved/*.gsz, results.json
   └ 결과 ◀──────────── files[] 항목 ◀────────────────────────┘
 배치 결과 탭 (batch-dashboard.js): FOS 표 · 기준 판정 · 전회 대비
```

- 브라우저는 보안상 GeoStudio 를 직접 실행할 수 없어서 **PC에서 도는 작은 Python 서버**가 중간에서 GeoCmd 를 호출합니다.
- 서버는 `127.0.0.1` 에서만 열리고, `runner/token.txt`(git 제외)의 **토큰**을 아는 요청만 처리합니다.

## 3. 저장소 구조 (git 이 두 개)

| 저장소 | 위치 | 브랜치 | 원격 |
|---|---|---|---|
| 바깥 | `slope/` | `master` | github.com/mingyuuujo/slope |
| 안쪽 (웹) | `slope/web/` | `main` | 같은 원격 |

**커밋 순서:** `web/` 안에서 먼저 커밋·푸시(`main`) → 바깥에서 `git add web runner` 후 커밋·푸시(`master`, submodule 포인터 갱신). `._*` 파일(macOS 흔적)과 `.claude/settings.local.json` 은 커밋하지 않습니다.

### 이번에 추가·변경한 파일

**`runner/` (바깥 저장소)**

| 파일 | 역할 |
|---|---|
| `run_slope.py` | CLI 일괄 해석. `solve_file()`, `save_run()` 를 서버와 공유 |
| `run_slope.bat` | `.gsz`/폴더를 끌어다 놓아 해석 |
| `server.py`, `run_server.bat` | 웹 "자동 실행" 탭용 로컬 서버 (`/health` `/solve` `/finish` `/solved`) |
| `README.md` | 러너 사용법·주의 |

**`web/js/` (웹 저장소)**

| 파일 | 역할 |
|---|---|
| `region-carryover.js` | DXF 교체 시 Region 매칭(같은 레이어, 무게중심·면적 최근접, 1:1) |
| `material-patch.js` | GSZ XML 의 기존 `<Material>` 을 이름으로 찾아 값만 제자리 수정 |
| `batch-materials.js` | "일괄 물성 적용" 탭 UI |
| `case-template.js` | 수위·kh·상재하중을 해석 1개 단위로 XML 에 적용 |
| `case-ui.js` | "케이스 템플릿" 탭 UI (템플릿은 localStorage + JSON) |
| `batch-dashboard.js` | "배치 결과" 탭, `setBatchRun()` 으로 다른 탭이 결과를 넘김 |
| `pipeline.js` | "자동 실행" 탭: 위 모듈들을 이어 붙이고 러너 호출 |
| `water-datapoints.js` (수정) | 해석 1개에만 수위를 넣는 `applyWaterToAnalysis()` 추가 |
| `main.js` (수정) | DXF 교체 시 승계 연결, 새 탭 초기화 |
| `test/region-carryover.test.mjs` | 승계 로직 단위 테스트 (`node --test`) |

### 커밋 이력 (최신순)

| 저장소 | 커밋 | 내용 |
|---|---|---|
| web | `679f90b` | 자동 실행 탭 + **main.js 문법 오류 수정** |
| 바깥 | `4b69457` | server.py 추가, web 포인터 갱신 |
| web | `d501354` | 케이스 템플릿 탭 |
| web | `6f9e25e` | DXF 매핑 승계 (**이 커밋의 main.js 에 문법 오류가 있었고 `679f90b` 에서 수정됨**) |
| web | `17cc015` | 일괄 물성 적용 탭, 배치 결과 탭 |
| 바깥 | `e6e7cd1`, `5a82d7a` | 러너 추가, 임시 로그 정리 |

## 4. 회사 PC 에서 처음 할 일

1. 두 저장소를 최신으로 받습니다 (`git pull`, 웹은 `slope/web` 안에서도 `git pull origin main`).
2. **GeoStudio 2012 의 `GeoCmd.exe` 경로 확인.** 집 PC: `C:\Program Files (x86)\GEO-SLOPE\GeoStudio 8\Bin\GeoCmd.exe`. 다르면 `python runner/server.py --geocmd "경로"` 로 지정.
3. Python 3 이 있어야 합니다 (표준 라이브러리만 사용, 별도 설치 패키지 없음).
4. `runner/run_server.bat` 실행 → 창에 뜨는 토큰을 웹 "자동 실행" 탭에 입력 → "연결 확인".
5. 웹은 `cd web && python -m http.server 8080` 또는 Vercel 배포본을 씁니다 (아래 5번 주의).

## 5. 알아둘 함정 (실제로 겪은 것)

- **Git Bash 에서 `GeoCmd.exe x.gsz /solve` 금지.** `/solve` 가 `C:/Program Files/Git/solve` 로 바뀝니다. PowerShell 이나 러너를 쓰세요.
- **`GeoCmd.exe /clean` 금지.** 해석 파일이 삭제됩니다. 대신 러너가 "실패한 해석의 옛 결과"를 결과에서 제외합니다.
- **`python -I` 로 실행하면 스크립트 폴더가 import 경로에 빠집니다.** `server.py` 는 직접 경로를 추가해 둠.
- **`node --check` 통과 ≠ 브라우저에서 동작.** `main.js` 의 끊긴 문자열 리터럴을 Node 는 놓쳤습니다. 수정 후엔 브라우저에서 모듈을 `import()` 해서 확인하세요 (헤드리스 Edge: `msedge --headless --user-data-dir=... URL`, 결과는 페이지가 로컬 서버로 POST).
- GSZ ZIP 안 파일명은 UTF-8 플래그가 없어 Python 이 cp437 로 읽습니다. `run_slope.py` 의 `zip_name()` 이 보정.
- 해석된 GSZ 는 결과(`lambdafos_*.csv`)를 같은 파일 안에 저장합니다. 루트 XML 은 이름에 `/` 가 없는 `.xml`.
- 수위·상재하중 적용은 기존 점을 고치지 않고 `DataPoints` 에 **새 점을 추가**합니다(기존 Region 매핑 탭과 동일 방식). 같은 파일에 여러 번 덮어쓰면 쓰이지 않는 점이 쌓입니다. 해석에는 무영향.
- Windows 콘솔 인코딩(cp949) 때문에 한글 출력이 깨져 보일 수 있습니다. 파일 자체는 UTF-8 정상.

## 6. 확인되지 않은 것 (회사에서 먼저 점검)

1. **새 탭 화면 직접 조작.** "일괄 물성 적용", "케이스 템플릿" 탭은 로직만 시험했고 화면을 직접 눌러 보지 않았습니다. "자동 실행" → "배치 결과" 흐름만 실제 화면으로 검증.
2. **지진시 해석의 FOS 가 비어 있음.** `NO.17` 의 `0.2 무처리_지진시`, `2.x 지반개량_지진시` 4건은 변경 전부터 FOS 가 없습니다. 원래 비어 있는지, 수렴 실패인지, 설정 문제인지 GeoStudio 에서 확인 필요.
3. **`output_mapped (12).gsz` 가 해석 불가.** 웹 "Region 매핑" 출력 파일이 "Piezometric Line missing when analysis setting PWP condition requires one" 로 검증 단계에서 실패합니다. 매핑 탭 출력 경로에서 수위선이 빠지는 경우가 있다는 뜻 → 원인 조사.
4. **기준 FOS 기본값**(지진 1.1 / 시공 1.2 / 그 외 1.3)은 제가 임의로 둔 값. 업무 기준으로 수정.
5. **https 배포본 → `http://127.0.0.1` 호출.** 서버는 Private Network Access 헤더를 보내지만 실제 Vercel(https)에서는 시험하지 못했습니다. 안 되면 로컬 `http.server` 로 웹을 띄워 사용.
6. **DXF 승계 정확도.** `새블럭.dxf`(55 Region)에서 51개 매칭 중 2개 오매칭, `test.dxf` 19/20 정답. `3구간.dxf` 는 결과를 못 봤음. 노랑/빨강 표시는 반드시 확인.

## 7. 다음에 할 일 (우선순위 순)

### A. 바로 효과가 큰 것
1. **DXF → GSZ 까지 자동 실행에 연결.** 지금 단면 변경은 "Region 매핑" 탭에서 따로 처리하고 GSZ 를 만든 뒤 자동 실행에 넣어야 합니다. 매핑 승계 + GSZ 생성을 파이프라인에 넣으면 "DXF 교체 → 버튼 한 번"이 완성됩니다. (`main.js` 의 `runMapping` 이 인라인이라 모듈로 분리 필요)
2. **프로젝트 파일(JSON) 하나로 묶기.** 물성 라이브러리 + 케이스 템플릿 + 케이스 규칙 + 기준 FOS + 단면 목록을 한 파일로 저장/불러오기. 지금은 각각 따로 저장(localStorage/JSON).
3. **6번 항목 점검 결과 반영** (특히 지진시 FOS 비어 있음, 매핑 출력 수위선 누락).

### B. 기능 보강
4. 상재하중을 **지표면 기준 상대 좌표**로 지정(단면이 바뀌어도 자동으로 따라가게). 지금은 절대 좌표.
5. 선하중(`LineLoadPoints`) 템플릿 지원 (NO.17 에는 있음).
6. 수위·상재하중 재적용 시 **고아 DataPoints 정리**.
7. 결과 화면: 임계 슬립서클 보기(기존 "결과 뷰어" 탭 연결), 이력 추이(`solved/history/`), 보고서 Excel 연동(`excel-report.js`).
8. 해석 이름이 아니라 **해석 종류별** 기준 FOS (상시/지진시/시공시 …) 를 프로젝트 파일에 저장.

### C. 정리·품질
9. **상재하중 XML 쓰기 코드 중복** (`main.js` 인라인 vs `case-template.js`) 한 곳으로 통합.
10. 단위 테스트 추가: `material-patch`, `case-template`, `pipeline` 규칙 파싱 (지금은 `result-parser`, `region-carryover` 만).
11. `main.js`(3600줄)에서 매핑·수위 로직 모듈 분리.
12. 러너: 큰 파일 타임아웃, 중간 취소, 진행률 표시 (지금은 파일 단위 순차).

## 8. 개발·검증 레시피

```bash
# 단위 테스트
cd web && node --test

# 러너 CLI 로 해석 (PowerShell 또는 cmd)
python runner/run_slope.py 입력폴더_또는.gsz --out solved

# 로컬 서버 + 웹
python runner/server.py            # 토큰이 출력됨
cd web && python -m http.server 8080
```

브라우저 검증 패턴(이번에 사용): 임시 HTML 에서 모듈을 `import()` 하거나 `index.html` 을 `document.write` 로 불러온 뒤, `DataTransfer` 로 `<input type=file>` 에 파일을 넣고 버튼을 눌러 결과를 로컬 서버로 POST → 파일로 읽기. 끝나면 임시 파일(`_t*.html`, `_drive.js` 등)은 반드시 삭제.

## 9. 데이터 형식 메모

- `results.json`: `{runAt, geocmd, files:[{file, seconds, exitCode, analyses:[{analysis, fos}], failures:[{analysis, reason}], error}]}`
- 물성 라이브러리 JSON: `{version:1, materials:{"재료이름":{uw, dw, c, phi, c_top, c_rate}}}` (이름이 키)
- 케이스 템플릿(localStorage `slope.case.templates`, JSON 내보내기 가능): `{name, waterText, khText, pressureText}`
  - 수위: 숫자 하나 = 표고 수평선 / 여러 줄 `x,y` = 좌표
  - 상재하중: 한 줄에 `x,y x,y | kPa`
- 케이스 규칙(자동 실행 탭): 줄마다 `키워드 = 템플릿이름`, `*` 는 모든 해석, 위에서부터 먼저 맞는 줄 적용
- 해석 폴더 이름: GeoStudio 는 `:` 를 `&4` 로 저장 (`result-parser.js` 참고)

## 10. 관련 기존 문서

- `README.md` — 웹 도구 배포·실행
- `BISHOP_ENGINE_PLAN.md` — 브라우저 단독 Bishop 계산 엔진 설계 (GeoStudio 없이 계산하는 장기 아이디어)
- `RESULT_VIEWER_PLAN.md` — 결과 뷰어 설계
- `web/design.md`, `web/design/*.md` — UI 디자인 규칙 (새 탭들은 아직 이 규칙 정리 대상 아님)

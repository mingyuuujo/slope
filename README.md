# SLOPE/W 웹 도구 (정적 배포)

GeoStudio **GSZ** 물성치 입력·**DXF** 기반 Region 매핑을 **브라우저만**으로 처리합니다.  
실행 코드는 모두 `web/` 폴더 안의 HTML/CSS/JavaScript 입니다.

## 폴더 구조

| 경로 | 설명 |
|------|------|
| **`web/`** | **배포할 정적 사이트 전체** (Vercel Root Directory 로 지정) |
| `web/index.html` | 메인 페이지 |
| `web/js/*.js` | GSZ/ZIP·XML·DXF·지오메트리 로직 |
| `web/vendor/` | 브라우저용 JSZip·dxf-parser UMD 번들 (배포 시 포함) |

데스크톱용 **`slope_gui.py`(PyQt)** 와는 별개입니다. 웹 버전은 Python 서버가 없습니다.

---

## Vercel 배포

1. 저장소를 Vercel에 연결합니다.
2. 프로젝트 설정에서 **Root Directory**를 `slope/web` 로 지정합니다.
3. Build Command는 비워 두고, Output Directory도 기본(`.` 또는 `./`)으로 두면 됩니다. (`web` 폴더 자체가 루트가 되도록 설정하는 편이 단순합니다.)

JSZip·dxf-parser는 **`web/vendor/`**에 번들되어 있으므로 별도 CDN이나 빌드 단계 없이 정적 배포만으로 동작합니다.

---

## 로컬에서 호스팅해서 사용하기

`file://` 로 `index.html` 만 더블클릭해서 열면, ES 모듈·보안 정책 때문에 동작하지 않을 수 있습니다.  
반드시 **로컬 HTTP 서버**로 `web` 폴더를 띄우세요.

### 방법 A — `serve` (Node 권장)

```bash
cd slope/web
npx --yes serve .
```

터미널에 나온 주소(예: `http://localhost:3000`)로 브라우저에서 접속합니다.

### 방법 B — Python 내장 서버

Python 3:

```bash
cd slope/web
python -m http.server 8080
```

브라우저에서 `http://127.0.0.1:8080` 으로 접속합니다.

### 방법 C — VS Code / Cursor

“Live Server” 등 확장으로 **`web` 폴더**를 웹 루트로 열어도 됩니다.

---

## 주의사항

- **기밀 GSZ/DXF**는 사용자 브라우저 메모리에서만 처리되고, 별도 서버로 업로드되지는 않습니다. 라이브러리는 **`vendor/`** 로컬 파일로 제공되어 폐쇄망에서도(정적 호스팅만 가능하면) 동작합니다.
- 복잡한 DXF·템플릿은 **데스크톱 `slope_gui.py`** 결과와 차이가 날 수 있으니, 중요한 파일은 GeoStudio에서 한 번 검증하는 것을 권장합니다.

### 물성치 Name/색이 비어 보일 때 (수정됨)

GSZ 안의 `<Materials>` 가 루트 바로 아래가 아니라 **중첩**되어 있는 경우, 예전 코드는 새 `<Materials>` 를 잘못 붙일 수 있었습니다. 지금은 문서 전역 검색으로 해당 블록을 찾습니다.

추가로, 기존 `<Material>` 노드를 **부분 수정**한 뒤 `XMLSerializer`로 저장하면 브라우저에 따라 **`<ID>`만 남고 나머지 자식이 사라지는** 현상이 있었습니다. 이제 `<Materials>` 안을 비운 뒤 **재료 목록 전체를 새 노드로 다시 조립**합니다. 변경 후에는 브라우저 **강력 새로고침(Ctrl+F5)** 또는 Vercel 재배포로 최신 `materials.js`를 받아야 합니다.

### 로컬 서버 404 한 줄

`favicon.ico` 요청 등으로 터미널에 `404` 가 한 번 찍힐 수 있으며, 기능에는 영향 없습니다.

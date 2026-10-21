# runner — GeoStudio 일괄 해석

GeoStudio 2012의 `GeoCmd.exe /solve` 를 이용해 창 없이 해석합니다. (GeoStudio 8, `C:\Program Files (x86)\GEO-SLOPE\GeoStudio 8\Bin`)

## 1. 웹 "자동 실행" 탭과 함께 쓰기 (권장)

1. `run_server.bat` 을 실행합니다. 창에 **토큰**이 표시됩니다. (`token.txt` 에도 저장, git 제외)
2. 웹의 "자동 실행" 탭에 토큰을 한 번 입력하고 "연결 확인"을 누릅니다.
3. GSZ·물성 라이브러리·케이스 규칙을 고르고 실행하면, 적용 → 해석 → 결과 비교가 한 번에 됩니다.

서버는 `127.0.0.1` 에서만 열리고 토큰이 없는 요청은 거부합니다. 결과는 `solved/` 에 저장됩니다.

## 2. 명령줄로 쓰기

`run_slope.bat` 위로 `.gsz` 파일이나 폴더를 끌어다 놓거나, `python run_slope.py 입력 --out solved` 로 실행합니다.
결과는 `solved/results.json` (이전 실행은 `solved/history/`) 입니다. 웹 "배치 결과" 탭에서 불러옵니다.

## 주의

- Git Bash 에서 `GeoCmd.exe ... /solve` 를 직접 치면 `/solve` 가 경로로 바뀝니다. PowerShell 이나 이 스크립트를 쓰세요.
- `GeoCmd.exe /clean` 은 해석 파일을 지워 버리므로 쓰지 않습니다.

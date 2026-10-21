@echo off
chcp 65001 >nul
rem 웹 "자동 실행" 탭이 쓰는 로컬 해석 서버. 창을 닫으면 종료됩니다.
python "%~dp0server.py" %*
pause

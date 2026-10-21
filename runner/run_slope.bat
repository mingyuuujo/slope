@echo off
chcp 65001 >nul
rem 사용: .gsz 파일이나 폴더를 이 bat 위로 끌어다 놓으면 해석합니다.
if "%~1"=="" (echo .gsz 파일 또는 폴더를 끌어다 놓으세요. & pause & exit /b 1)
python "%~dp0run_slope.py" %* --out "%~dp0..\solved"
pause

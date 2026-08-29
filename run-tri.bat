@echo off
setlocal enabledelayedexpansion
REM Chay tri-script.jsx trong Photoshop khong can click dialog - danh cho AI agent / CLI.
REM
REM   run-tri.bat                     dung .\tri-config.json
REM   run-tri.bat my-config.json      dung config khac
REM
REM Photoshop.exe -r khong truyen duoc tham so, nen duong dan config duoc ghi vao
REM tri-config-path.txt de script .jsx doc. Photoshop van mo sau khi chay xong,
REM nen batch cho bang cach poll file tri-run.done.

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "JSX=%SCRIPT_DIR%\tri-script.jsx"
set "LOG=%SCRIPT_DIR%\tri-run.log"
set "DONE=%SCRIPT_DIR%\tri-run.done"
set "POINTER=%SCRIPT_DIR%\tri-config-path.txt"

REM Timeout mac dinh 60 phut (612 anh chay rat lau). Doi qua bang bien TRI_TIMEOUT_SEC.
if "%TRI_TIMEOUT_SEC%"=="" set "TRI_TIMEOUT_SEC=3600"

if "%~1"=="" (
  set "CONFIG=%SCRIPT_DIR%\tri-config.json"
) else (
  REM Duong dan tuong doi thi noi vao thu muc script
  echo %~1| findstr /r "^[A-Za-z]:\\ ^\\\\" >nul
  if errorlevel 1 ( set "CONFIG=%SCRIPT_DIR%\%~1" ) else ( set "CONFIG=%~1" )
)

if not exist "%CONFIG%" (
  echo Khong tim thay config: %CONFIG% 1>&2
  echo Copy tri-config.example.json thanh tri-config.json roi sua lai. 1>&2
  exit /b 1
)

REM --- NAS placeholder ------------------------------------------------------
REM Config dung "[NAS]/..." thay cho duong dan tuyet doi, vi goc duong dan khac nhau
REM tuy tuyen vao NAS (SMB LAN / SMB tailscale / WebDAV map o dia). Ket noi xong moi
REM thay [NAS] bang goc that -> cung mot config chay duoc tren moi may.
findstr /c:"[NAS]" "%CONFIG%" >nul
if not errorlevel 1 (
  echo Config co [NAS] - ket noi NAS...
  set "NAS_BASE="
  for /f "delims=" %%B in ('"%SCRIPT_DIR%\nas-mount.bat"') do set "NAS_BASE=%%B"
  if not defined NAS_BASE (
    echo Khong ket noi duoc NAS - xem log phia tren. 1>&2
    exit /b 1
  )
  set "RESOLVED=%SCRIPT_DIR%\.tri-config-resolved.json"
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$cfg = Get-Content -Raw -Encoding UTF8 '%CONFIG%' | ConvertFrom-Json;" ^
    "foreach ($k in 'templateFolder','outputFolder') {" ^
    "  $v = $cfg.$k;" ^
    "  if ($v -is [string] -and $v.Contains('[NAS]')) {" ^
    "    $p = $v.Replace('[NAS]', $env:NAS_BASE.TrimEnd('\/'));" ^
    "    if ($p.StartsWith('\\')) { $p = $p.Replace('/', '\') }" ^
    "    $cfg.$k = $p } };" ^
    "$cfg | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 '!RESOLVED!'"
  if errorlevel 1 (
    echo Khong resolve duoc [NAS] trong config. 1>&2
    exit /b 1
  )
  set "CONFIG=!RESOLVED!"
  echo Config da resolve: !CONFIG!
)

REM Tim Photoshop.exe - ban moi nhat truoc
set "PS_EXE="
for /f "delims=" %%D in ('dir /b /ad /o-n "%ProgramFiles%\Adobe\Adobe Photoshop*" 2^>nul') do (
  if not defined PS_EXE if exist "%ProgramFiles%\Adobe\%%D\Photoshop.exe" set "PS_EXE=%ProgramFiles%\Adobe\%%D\Photoshop.exe"
)
if not defined PS_EXE (
  for /f "delims=" %%D in ('dir /b /ad /o-n "%ProgramFiles(x86)%\Adobe\Adobe Photoshop*" 2^>nul') do (
    if not defined PS_EXE if exist "%ProgramFiles(x86)%\Adobe\%%D\Photoshop.exe" set "PS_EXE=%ProgramFiles(x86)%\Adobe\%%D\Photoshop.exe"
  )
)
if not defined PS_EXE (
  echo Khong tim thay Photoshop.exe trong Program Files. 1>&2
  echo Neu cai o cho khac, dat bien TRI_PS_EXE tro toi Photoshop.exe. 1>&2
  if defined TRI_PS_EXE set "PS_EXE=%TRI_PS_EXE%"
)
if defined TRI_PS_EXE set "PS_EXE=%TRI_PS_EXE%"
if not defined PS_EXE exit /b 1

echo Photoshop: %PS_EXE%
echo Config:    %CONFIG%

REM Tu dong thu lai loi Photoshop/timeout. TRI_MAX_RETRIES=2 = tong 3 lan thu.
if "%TRI_MAX_RETRIES%"=="" set "TRI_MAX_RETRIES=2"
set /a MAX_ATTEMPTS=TRI_MAX_RETRIES+1
set /a ATTEMPT=0
set "FINAL_EXIT=3"

:retry
set /a ATTEMPT+=1
echo --- Photoshop attempt !ATTEMPT!/!MAX_ATTEMPTS! ---

REM Don dep dau vet lan chay truoc
if exist "%DONE%" del /q "%DONE%"
> "%POINTER%" echo %CONFIG%

start "" "%PS_EXE%" -r "%JSX%"

REM Poll file bao hieu - Photoshop khong thoat sau khi script xong
set /a WAITED=0
:wait
if exist "%DONE%" goto finished
if !WAITED! geq %TRI_TIMEOUT_SEC% (
  echo Qua thoi gian cho %TRI_TIMEOUT_SEC% giay ma script chua bao xong. 1>&2
  echo Kiem tra Photoshop co dang hien hop thoai nao khong. 1>&2
  set "FINAL_EXIT=2"
  goto retry_or_finish
)
REM timeout /t 2 khong chay duoc khi stdin bi redirect nen dung ping lam dong ho
ping -n 3 127.0.0.1 >nul
set /a WAITED+=2
goto wait

:finished
set "STATUS="
set /p STATUS=<"%DONE%"
if exist "%POINTER%" del /q "%POINTER%"

echo --- tri-run.log ---
if exist "%LOG%" type "%LOG%"

if /i "%STATUS%"=="OK" (
  set "FINAL_EXIT=0"
) else (
  echo Script ket thuc voi loi - xem log o tren. 1>&2
  set "FINAL_EXIT=3"
)

:retry_or_finish
if "%FINAL_EXIT%"=="0" exit /b 0
if !ATTEMPT! lss !MAX_ATTEMPTS! (
  echo Photoshop loi/timeout - se dong va tu chay lai sau 5 giay (lan !ATTEMPT!/!MAX_ATTEMPTS!). 1>&2
  taskkill /IM Photoshop.exe /F >nul 2>&1
  ping -n 6 127.0.0.1 >nul
  goto retry
)

if exist "%POINTER%" del /q "%POINTER%"
if "%FINAL_EXIT%"=="2" exit /b 2
exit /b 3

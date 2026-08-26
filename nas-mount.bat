@echo off
setlocal enabledelayedexpansion
REM Ket noi NAS tren Windows. In ra dung 1 dong: goc duong dan de thay cho [NAS].
REM   - SMB/UNC (uu tien): in ra \\192.168.x.x
REM   - WebDAV (fallback): map o dia roi in ra Z:
REM
REM Exit: 0 = ket noi duoc | 1 = thieu .env | 2 = khong tuyen nao vao duoc
REM
REM Log ghi ra stderr de stdout chi con duong dan, script goi capture duoc.

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "ENV_FILE=%SCRIPT_DIR%\.env"

if not exist "%ENV_FILE%" (
  echo [nas-mount] LOI: khong thay %ENV_FILE% - copy .env.example roi dien credentials. 1>&2
  exit /b 1
)

REM Doc .env: bo dong trong va dong bat dau bang #
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  if not "%%~A"=="" set "%%A=%%B"
)

if not defined WEBDAV_USERNAME (
  echo [nas-mount] LOI: thieu WEBDAV_USERNAME trong .env 1>&2
  exit /b 1
)

REM --- 1. Thu SMB/UNC theo thu tu -------------------------------------------
REM IPC$ la share dieu khien, luon co - dung de kiem tra dang nhap duoc khong.
for %%H in ("%NAS_SMB_1%" "%NAS_SMB_2%") do (
  set "HOST=%%~H"
  if not "!HOST!"=="" (
    echo [nas-mount] thu SMB \\!HOST! ... 1>&2
    REM Xoa ket noi cu neu co, tranh loi "da ket noi bang tai khoan khac"
    net use "\\!HOST!\IPC$" /delete /y >nul 2>&1
    net use "\\!HOST!\IPC$" "%WEBDAV_PASSWORD%" /user:"%WEBDAV_USERNAME%" >nul 2>&1
    if not errorlevel 1 (
      echo [nas-mount]   ^> SMB OK 1>&2
      echo \\!HOST!
      exit /b 0
    )
    echo [nas-mount]   ^> khong voi toi duoc, bo qua 1>&2
  )
)

REM --- 2. Fallback: map o dia WebDAV ----------------------------------------
if not defined NAS_URL_3 (
  echo [nas-mount] LOI: khong tuyen SMB nao duoc va .env khong co NAS_URL_3 1>&2
  exit /b 2
)

REM Tim chu o con trong, do nguoc tu Z de tranh dung o he thong
for %%L in (Z Y X W V U T) do (
  if not defined PICKED (
    if not exist "%%L:\" set "PICKED=%%L"
  )
)
if not defined PICKED (
  echo [nas-mount] LOI: khong con chu o dia trong de map WebDAV 1>&2
  exit /b 2
)

echo [nas-mount] thu WebDAV %NAS_URL_3% -^> %PICKED%: ... 1>&2
net use %PICKED%: "%NAS_URL_3%" "%WEBDAV_PASSWORD%" /user:"%WEBDAV_USERNAME%" >nul 2>&1
if errorlevel 1 (
  echo [nas-mount] LOI: khong map duoc WebDAV. 1>&2
  echo [nas-mount] Kiem tra dich vu WebClient da bat chua: sc start WebClient 1>&2
  exit /b 2
)
echo [nas-mount]   ^> WebDAV OK: %PICKED%: 1>&2
echo %PICKED%:
exit /b 0

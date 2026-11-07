# Agente del checador: lee las checadas del checador Hikvision (ISAPI, red local) y las sube a la
# plataforma (POST /api/admin/attendance/ingest). Lo corre una tarea programada de Windows a las
# 09:00, 15:30 y 22:30 (ver instalar.ps1). Si no hay internet no se pierde nada: el aparato guarda las
# checadas y en la siguiente vuelta se suben desde la ultima que tiene la plataforma.
# Tambien corrige el reloj del aparato si se desvia mas de 1 minuto (hora de Sonora, UTC-7).
#
# Necesita:
#   - <DataDir>\checador.xml  credencial del aparato (cifrada con DPAPI, solo la puede leer el
#     usuario de Windows que corrio instalar.ps1); DataDir default %LOCALAPPDATA%\SonoraChecador
#   - variable de entorno de usuario SPCLI_TOKEN  token spat_... de un admin (Mi cuenta -> Tokens)
#   - curl.exe (viene con Windows 10/11)

param(
  [string]$DeviceIp = '192.168.100.243',
  [string]$Company = 'sp',
  [string]$BaseDomain = 'alfredorivera.dev',
  [int]$FirstRunDays = 30,
  # Carpeta con checador.xml, el log y la marca de vida.
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'SonoraChecador')
)

$ErrorActionPreference = 'Stop'
# Lo que se manda a curl por stdin va sin BOM (con BOM curl no entiende su config).
$OutputEncoding = New-Object Text.UTF8Encoding($false)
$dir = $DataDir
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$logFile = Join-Path $dir 'agente.log'
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item $logFile "$logFile.1" -Force }
function Log([string]$msg) { Add-Content -Path $logFile -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding utf8 }

try {
  # ---------- credenciales ----------
  $credFile = Join-Path $dir 'checador.xml'
  if (-not (Test-Path $credFile)) { throw "Falta $credFile; corre instalar.ps1" }
  $cred = Import-Clixml $credFile
  $plain = $cred.UserName.TrimStart('\') + ':' + $cred.GetNetworkCredential().Password
  $curlCfg = 'user = "' + $plain.Replace('\', '\\').Replace('"', '\"') + '"'
  $token = [Environment]::GetEnvironmentVariable('SPCLI_TOKEN', 'User')
  if (-not $token) { $token = $env:SPCLI_TOKEN }
  if (-not $token) { throw 'Falta la variable de entorno SPCLI_TOKEN' }
  $api = "https://$Company.$BaseDomain"

  function Invoke-Device([string]$method, [string]$path, [string]$body, [string]$ctype = 'application/json') {
    $out = [IO.Path]::GetTempFileName()
    $cargs = @('-s', '--digest', '-K', '-', '-X', $method, '-o', $out, '-w', '%{http_code}', '--max-time', '20')
    $bodyFile = $null
    if ($body) {
      $bodyFile = [IO.Path]::GetTempFileName()
      [IO.File]::WriteAllText($bodyFile, $body, (New-Object Text.UTF8Encoding($false)))
      $cargs += @('-H', "Content-Type: $ctype", '--data-binary', "@$bodyFile")
    }
    $cargs += "http://$DeviceIp$path"
    $code = $curlCfg | & curl.exe @cargs
    $txt = [IO.File]::ReadAllText($out)
    Remove-Item $out -ErrorAction SilentlyContinue
    if ($bodyFile) { Remove-Item $bodyFile -ErrorAction SilentlyContinue }
    return @{ code = [int]$code; text = $txt }
  }

  function Invoke-Platform([string]$method, [string]$path, $body) {
    $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
    if ($null -ne $body) {
      $json = $body | ConvertTo-Json -Depth 6 -Compress
      return Invoke-RestMethod -Method $method -Uri "$api$path" -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
    }
    return Invoke-RestMethod -Method $method -Uri "$api$path" -Headers $headers -TimeoutSec 60
  }

  # ---------- aparato ----------
  $info = Invoke-Device 'GET' '/ISAPI/System/deviceInfo' $null
  if ($info.code -eq 401) { throw 'El checador rechazo la contrasena (corre instalar.ps1 otra vez)' }
  if ($info.code -ne 200) { throw "El checador no respondio ($($info.code))" }
  $serial = [regex]::Match($info.text, '<serialNumber>([^<]+)</serialNumber>').Groups[1].Value.Trim()
  if (-not $serial) { throw 'No se pudo leer el numero de serie del checador' }

  # Reloj: si se desvio mas de 1 minuto, se pone en hora de Sonora (se manda dos veces: algunos
  # equipos cambian primero la zona y solo despues aceptan la hora).
  $t = Invoke-Device 'GET' '/ISAPI/System/time' $null
  $local = [regex]::Match($t.text, '<localTime>([^<]+)</localTime>').Groups[1].Value
  $tz = [regex]::Match($t.text, '<timeZone>([^<]+)</timeZone>').Groups[1].Value
  $drift = if ($local) { [math]::Abs(([DateTimeOffset]::Parse($local) - [DateTimeOffset]::UtcNow).TotalSeconds) } else { 9999 }
  if ($drift -gt 60 -or $tz -ne 'CST+7:00:00') {
    for ($i = 0; $i -lt 2; $i++) {
      $sonora = [DateTimeOffset]::UtcNow.AddHours(-7).ToString('yyyy-MM-ddTHH:mm:ss') + '-07:00'
      $xml = "<?xml version=`"1.0`" encoding=`"UTF-8`"?><Time version=`"2.0`" xmlns=`"http://www.isapi.org/ver20/XMLSchema`"><timeMode>manual</timeMode><localTime>$sonora</localTime><timeZone>CST+7:00:00</timeZone></Time>"
      [void](Invoke-Device 'PUT' '/ISAPI/System/time' $xml 'application/xml')
      Start-Sleep -Seconds 2
    }
    Log ("Reloj corregido (iba {0:N0} s desviado, zona {1})" -f $drift, $tz)
  }

  # ---------- desde donde leer ----------
  $last = Invoke-Platform 'GET' "/api/admin/attendance/last?device=$([uri]::EscapeDataString($serial))" $null
  if ($last.last_at) { $since = [DateTimeOffset]::Parse($last.last_at).AddMinutes(-10) } else { $since = [DateTimeOffset]::UtcNow.AddDays(-$FirstRunDays) }
  $fmt = { param($d) $d.ToOffset([TimeSpan]::FromHours(-7)).ToString('yyyy-MM-ddTHH:mm:ss') + '-07:00' }
  $start = & $fmt $since
  $end = & $fmt ([DateTimeOffset]::UtcNow.AddDays(1))

  # ---------- leer eventos de acceso (major 5) ----------
  # minor: 1 tarjeta, 38 huella, 75 rostro; los rechazados no traen numero de empleado.
  # Este firmware rechaza (badParameters) major=5 y searchID largos: se piden todos los eventos
  # (major 0) con un searchID corto y se filtran aqui los de acceso.
  $methods = @{ 1 = 'tarjeta'; 38 = 'huella'; 75 = 'rostro'; 6 = 'pin'; 7 = 'pin' }
  $events = New-Object System.Collections.Generic.List[object]
  $pos = 0
  $searchId = 'ag' + (Get-Random -Maximum 99999)
  do {
    $cond = @{ AcsEventCond = @{ searchID = $searchId; searchResultPosition = $pos; maxResults = 30; major = 0; minor = 0; startTime = $start; endTime = $end } } | ConvertTo-Json -Depth 4 -Compress
    $r = Invoke-Device 'POST' '/ISAPI/AccessControl/AcsEvent?format=json' $cond
    if ($r.code -ne 200) { throw "Error leyendo eventos ($($r.code)): $($r.text)" }
    $j = $r.text | ConvertFrom-Json
    $batch = @($j.AcsEvent.InfoList | Where-Object { $_ })
    foreach ($e in $batch) {
      if ([int]$e.major -ne 5 -or -not $e.employeeNoString) { continue }
      $m = $methods[[int]$e.minor]
      $events.Add(@{ serial_no = [long]$e.serialNo; employee_no = [string]$e.employeeNoString; time = [string]$e.time; method = $(if ($m) { $m } else { 'otro' }) })
    }
    $pos += $batch.Count
  } while ($j.AcsEvent.responseStatusStrg -eq 'MORE' -and $batch.Count -gt 0 -and $pos -lt 20000)

  # ---------- subir ----------
  $inserted = 0
  for ($i = 0; $i -lt $events.Count; $i += 500) {
    $chunk = $events.GetRange($i, [math]::Min(500, $events.Count - $i))
    $res = Invoke-Platform 'POST' '/api/admin/attendance/ingest' @{ device = $serial; events = $chunk.ToArray() }
    $inserted += [int]$res.inserted
  }
  if ($inserted -gt 0) { Log "OK: $($events.Count) leidas desde $start, $inserted nuevas" }
  # Marca de vida para saber que el agente sigue corriendo aunque no haya checadas.
  Set-Content -Path (Join-Path $dir 'ultima-vuelta.txt') -Value ("{0}  leidas {1}, nuevas {2}" -f (Get-Date -Format o), $events.Count, $inserted) -Encoding utf8
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}

# Instala el agente del checador en esta PC:
#   1. Pide la contrasena del checador (ventana de Windows), la prueba y la guarda cifrada (DPAPI)
#      en %LOCALAPPDATA%\SonoraChecador\checador.xml; solo este usuario de Windows la puede leer.
#   2. Copia agente.ps1 a esa carpeta y crea la tarea programada "Sonora - Checador" que lo corre
#      3 veces al dia (09:00, 15:30, 22:30), oculta, mientras este usuario tenga la sesion abierta.
#   3. Corre una primera vuelta y muestra el resultado.
# Volver a correrlo actualiza la contrasena y el agente. Para quitarlo:
#   Unregister-ScheduledTask -TaskName 'Sonora - Checador' -Confirm:$false

param(
  [string]$DeviceIp = '192.168.100.243',
  # Donde quedan agente, credencial y log. Debe ser una carpeta real (no virtualizada).
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'SonoraChecador')
)

$ErrorActionPreference = 'Stop'
# Lo que se manda a curl por stdin va sin BOM (con BOM curl no entiende su config).
$OutputEncoding = New-Object Text.UTF8Encoding($false)
$dir = $DataDir
New-Item -ItemType Directory -Force -Path $dir | Out-Null

if (-not ([Environment]::GetEnvironmentVariable('SPCLI_TOKEN', 'User'))) {
  Write-Host 'Falta el token de la plataforma (variable de entorno SPCLI_TOKEN).' -ForegroundColor Red
  Read-Host 'Enter para salir'; exit 1
}

$cred = Get-Credential -UserName 'admin' -Message 'Contrasena del checador Hikvision (se guarda cifrada en esta PC)'
if (-not $cred) { Write-Host 'Cancelado.'; Read-Host 'Enter para salir'; exit 1 }

# Probar la contrasena antes de guardarla
$plain = $cred.UserName.TrimStart('\') + ':' + $cred.GetNetworkCredential().Password
$cfg = 'user = "' + $plain.Replace('\', '\\').Replace('"', '\"') + '"'
$code = $cfg | & curl.exe -s --digest -K - -o NUL -w '%{http_code}' --max-time 15 "http://$DeviceIp/ISAPI/System/deviceInfo"
if ($code -eq '401') { Write-Host 'Contrasena incorrecta. No lo intentes mas de 2 veces seguidas.' -ForegroundColor Red; Read-Host 'Enter para salir'; exit 1 }
if ($code -ne '200') { Write-Host "El checador no respondio ($code). Revisa que este prendido y conectado." -ForegroundColor Red; Read-Host 'Enter para salir'; exit 1 }

$cred | Export-Clixml -Path (Join-Path $dir 'checador.xml')
Copy-Item -Path (Join-Path $PSScriptRoot 'agente.ps1') -Destination (Join-Path $dir 'agente.ps1') -Force
Write-Host 'Contrasena guardada (cifrada).' -ForegroundColor Green

$agent = Join-Path $dir 'agente.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$agent`" -DeviceIp $DeviceIp -DataDir `"$dir`""
# 3 veces al dia, despues de cada entrada/salida de turno (Daniel, 2026-11-07). Si la PC estaba
# apagada a esa hora, corre en cuanto se prenda (StartWhenAvailable).
$trigger = @('09:00', '15:30', '22:30') | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Sonora - Checador' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Sube las checadas del checador Hikvision a la plataforma 3 veces al dia (09:00, 15:30, 22:30)' -Force | Out-Null
Write-Host 'Tarea programada "Sonora - Checador" creada (corre a las 09:00, 15:30 y 22:30).' -ForegroundColor Green

Write-Host 'Primera vuelta...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agent -DeviceIp $DeviceIp -DataDir $dir
$vuelta = Join-Path $dir 'ultima-vuelta.txt'
if ($LASTEXITCODE -eq 0 -and (Test-Path $vuelta)) {
  Write-Host ("Listo: " + (Get-Content $vuelta)) -ForegroundColor Green
} else {
  Write-Host 'La primera vuelta fallo. Detalle:' -ForegroundColor Red
  Get-Content (Join-Path $dir 'agente.log') -Tail 5
}
Read-Host 'Enter para salir'

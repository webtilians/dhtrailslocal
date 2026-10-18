# Sets up the daily copy of the DH Trails backups on this PC (run once, as yourself, not as administrator):
#   1. creates an SSH key only for the copies (if there is none),
#   2. copies descargar-copia.ps1 next to the copies, so it does not depend on the repository's branch,
#   3. creates the Windows task «DH Trails - copia de seguridad»: every day at 21:00 and when you log in,
#      and as soon as the PC is on if it was off at that time.
# Then allow the key on the server: dhtrails-copias-pc "<the public key printed at the end>"
param(
  [string]$Folder = "$HOME\DHTrails-copias",
  [string]$Key = "$HOME\.ssh\dhtrails_copias"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Folder, (Split-Path $Key) | Out-Null
if (-not (Test-Path $Key)) {
  # No passphrase: the task runs unattended, and the server lets this key do nothing but send the copy.
  & ssh-keygen.exe -q -t ed25519 -N '""' -C "dhtrails-copias-$env:COMPUTERNAME" -f $Key
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear la clave' }
}
$script = Join-Path $Folder 'descargar-copia.ps1'
Copy-Item -Force (Join-Path $PSScriptRoot 'descargar-copia.ps1') $script
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Folder `"$Folder`" -Key `"$Key`""
$triggers = @((New-ScheduledTaskTrigger -Daily -At '21:00'), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -Force -TaskName 'DH Trails - copia de seguridad' -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Baja cada día la última copia de DH Trails (base de datos y GPS) del servidor a esta carpeta.' | Out-Null
Write-Output "Tarea creada. Copias en: $Folder"
Write-Output "Clave pública para el servidor (dhtrails-copias-pc):"
Get-Content "$Key.pub"

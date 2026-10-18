# Downloads the latest DH Trails backup (database and GPS files) from the server to this PC and keeps
# the last 30 days. The Windows task «DH Trails - copia de seguridad» runs it; it can also be run by hand.
param(
  [string]$Server = 'dhbackup@178.105.103.4',
  [string]$Key = "$HOME\.ssh\dhtrails_copias",
  [string]$Folder = "$HOME\DHTrails-copias",
  [int]$KeepDays = 30
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Folder | Out-Null
$log = Join-Path $Folder 'registro.txt'
function Say($text) { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm') + '  ' + $text) -Encoding UTF8 }
$target = Join-Path $Folder ('dhtrails-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.tar')
$part = "$target.part"
try {
  # cmd.exe writes ssh's output byte for byte (PowerShell 5 would re-encode it as text).
  & cmd.exe /c "ssh.exe -i `"$Key`" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30 $Server > `"$part`""
  if ($LASTEXITCODE -ne 0) { throw "ssh terminó con el código $LASTEXITCODE" }
  $inside = & tar.exe -tf $part
  if ($LASTEXITCODE -ne 0 -or -not ($inside -match '^dhtrails-.*\.dump$') -or -not ($inside -match '^gps-.*\.tar\.gz$')) {
    throw 'la copia recibida está incompleta'
  }
  Move-Item -Force $part $target
  $kb = [math]::Round((Get-Item $target).Length / 1KB)
  Say "copia descargada: $(Split-Path $target -Leaf) ($kb KB: $($inside -join ', '))"
  Get-ChildItem $Folder -Filter 'dhtrails-*.tar' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } | Remove-Item
} catch {
  Remove-Item -ErrorAction SilentlyContinue $part
  Say "ERROR: $($_.Exception.Message)"
  exit 1
}

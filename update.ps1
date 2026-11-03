#requires -Version 5.1
# Обновление opencode Sidebar из GitHub Releases.
# Использование: .\update.ps1 [-Version 0.9.25] [-Force]
[CmdletBinding()]
param(
	[Parameter(Position = 0)][string]$Version = '',
	[switch]$Force,
	[string]$Code = 'code'
)

$ErrorActionPreference = 'Stop'
try {
	[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
	$OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Repo = 'mvkorolenko90-wq/opencode-sidebar'
$ExtId = 'myai.opencode-sidebar'
$ReleasesUrl = "https://github.com/$Repo/releases"

$CodeCmd = Get-Command $Code -ErrorAction SilentlyContinue
if (-not $CodeCmd -and $Code -eq 'code') {
	$CodeCmd = Get-Command 'code-insiders' -ErrorAction SilentlyContinue
}
if (-not $CodeCmd) {
	Write-Host "Не найден CLI редактора «$Code»." -ForegroundColor Red
	Write-Host "Скачайте VSIX и установите вручную: $ReleasesUrl"
	exit 1
}
$CodePath = $CodeCmd.Source

$Version = $Version.Trim()
if ($Version -match '^[vV]') { $Version = $Version.Substring(1) }

$Api = if ($Version) {
	"https://api.github.com/repos/$Repo/releases/tags/v$Version"
} else {
	"https://api.github.com/repos/$Repo/releases/latest"
}
$Headers = @{
	'User-Agent' = 'opencode-sidebar-updater'
	'Accept'     = 'application/vnd.github+json'
}

Write-Host 'Запрашиваю GitHub Releases…'
try {
	$Release = Invoke-RestMethod -Uri $Api -Headers $Headers
} catch {
	Write-Host "Не удалось получить данные релиза: $($_.Exception.Message)" -ForegroundColor Red
	Write-Host "Проверьте сеть и версию: $ReleasesUrl"
	exit 1
}

$Tag = $Release.tag_name.TrimStart('v', 'V')
$Asset = $Release.assets | Where-Object { $_.name -like '*.vsix' } | Select-Object -First 1
if (-not $Asset) {
	Write-Host "В релизе $($Release.tag_name) нет VSIX-файла: $ReleasesUrl" -ForegroundColor Red
	exit 1
}

$InstalledLine = & $CodePath --list-extensions --show-versions 2>$null |
	Where-Object { $_ -like "$ExtId@*" } |
	Select-Object -First 1
$Installed = if ($InstalledLine) { ($InstalledLine -split '@')[1] } else { '' }

if ($Installed -eq $Tag -and -not $Force) {
	Write-Host "Уже установлена последняя версия: $Tag"
	Write-Host 'Переустановить: .\update.ps1 -Force'
	exit 0
}

if ($Installed) {
	Write-Host "Установлено: $Installed → ставим: $Tag"
} else {
	Write-Host "Расширение не найдено, ставим версию $Tag"
}

$Vsix = Join-Path $env:TEMP $Asset.name
Write-Host "Скачиваю $($Asset.name)…"
Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $Vsix -UseBasicParsing

& $CodePath --install-extension $Vsix --force

Write-Host ''
Write-Host "Установлено: opencode Sidebar $Tag" -ForegroundColor Green
Write-Host 'Перезагрузите окно VS Code: Ctrl+Shift+P → Developer: Reload Window'

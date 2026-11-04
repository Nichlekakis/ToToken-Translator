# ToToken Translator: instalação em um comando (Windows PowerShell).
#   irm https://raw.githubusercontent.com/Nichlekakis/ToToken-Translator/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/Nichlekakis/ToToken-Translator.git'
$branch = if ($env:TOTOKEN_BRANCH) { $env:TOTOKEN_BRANCH } else { 'main' }
$home_ = if ($env:TOTOKEN_HOME) { $env:TOTOKEN_HOME } else { Join-Path $HOME '.totoken' }
$dir = Join-Path $home_ 'app'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Instale o Node.js 18+ primeiro: https://nodejs.org'; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host 'Instale o git primeiro: https://git-scm.com'; exit 1 }

if (Test-Path (Join-Path $dir '.git')) {
  git -C $dir fetch -q origin $branch; git -C $dir checkout -q $branch; git -C $dir reset -q --hard "origin/$branch"
} else {
  New-Item -ItemType Directory -Force -Path $home_ | Out-Null
  git clone -q -b $branch $repo $dir
}
node (Join-Path $dir 'bin/totoken.js') setup

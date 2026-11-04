# ToToken Translator: instalação em um comando (Windows PowerShell).
#   irm https://raw.githubusercontent.com/Nichlekakis/ToToken-Translator/main/install.ps1 | iex
# Roda dentro da janela do usuário via iex: nunca use `exit` aqui, porque fecharia a janela.

function Install-ToToken {
  $branch = if ($env:TOTOKEN_BRANCH) { $env:TOTOKEN_BRANCH } else { 'main' }
  $root = if ($env:TOTOKEN_HOME) { $env:TOTOKEN_HOME } else { Join-Path $HOME '.totoken' }
  $dir = Join-Path $root 'app'

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Write-Host 'Node.js não encontrado. Instalando com o winget...'
      winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
      $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Host 'Instale o Node.js 18 ou mais novo (https://nodejs.org), feche e abra o PowerShell, e rode o comando de novo.' -ForegroundColor Yellow
      return
    }
  }

  # Baixa o projeto como .zip: não precisa de git.
  Write-Host 'Baixando o ToToken...'
  $zip = Join-Path $env:TEMP 'totoken.zip'
  $tmp = Join-Path $env:TEMP 'totoken-extract'
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/Nichlekakis/ToToken-Translator/archive/refs/heads/$branch.zip" -OutFile $zip
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  if (Test-Path $dir) {
    & node (Join-Path $dir 'bin/totoken.js') stop | Out-Null
    Remove-Item -Recurse -Force $dir
  }
  Move-Item $src.FullName $dir
  Remove-Item -Force $zip
  Remove-Item -Recurse -Force $tmp

  & node (Join-Path $dir 'bin/totoken.js') setup
}

try {
  Install-ToToken
} catch {
  Write-Host "A instalação falhou: $($_.Exception.Message)" -ForegroundColor Red
}

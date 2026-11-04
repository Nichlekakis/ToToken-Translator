#!/usr/bin/env sh
# ToToken Translator: instalação em um comando (macOS / Linux).
#   curl -fsSL https://raw.githubusercontent.com/Nichlekakis/ToToken-Translator/main/install.sh | sh
set -e
REPO="https://github.com/Nichlekakis/ToToken-Translator.git"
BRANCH="${TOTOKEN_BRANCH:-main}"
DIR="${TOTOKEN_HOME:-$HOME/.totoken}/app"

command -v node >/dev/null 2>&1 || { echo "Instale o Node.js 18+ primeiro: https://nodejs.org"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Instale o git primeiro: https://git-scm.com"; exit 1; }

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  mkdir -p "$(dirname "$DIR")"
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
node "$DIR/bin/totoken.js" setup

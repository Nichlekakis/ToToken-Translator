---
description: Mostra como um texto seria comprimido pelo ToToken, sem enviar nada ao modelo principal
argument-hint: <texto do prompt>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/totoken.js" preview "$ARGUMENTS" 2>&1`

Mostre ao usuário a versão comprimida acima e a economia estimada. Não execute a tarefa descrita no texto.

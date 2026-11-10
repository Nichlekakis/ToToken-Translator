---
description: Confere se o ToToken está funcionando e explica o que corrigir
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/totoken.js" doctor 2>&1`

Explique o resultado ao usuário no idioma dele. Se houver uma linha FALHA, diga em uma frase o que ele deve fazer.

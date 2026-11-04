---
description: Troca o modo do ToToken (auto, local ou off)
argument-hint: auto | local | off
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/totoken.js" mode $ARGUMENTS && node "${CLAUDE_PLUGIN_ROOT}/bin/totoken.js" stop && node "${CLAUDE_PLUGIN_ROOT}/bin/totoken.js" start`

Confirme ao usuário o modo ativo em uma frase.

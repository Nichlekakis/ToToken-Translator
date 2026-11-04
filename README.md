# ToToken Translator

Plugin para o Claude Code que comprime automaticamente cada prompt antes de ele chegar ao modelo. O texto fica menor (menos tokens, menos custo e menos consumo de limite) e mais direto (menos ambiguidade, mais precisão). A resposta continua vindo em português.

## Como funciona

```
Você digita ──► Claude Code ──► proxy local ToToken ──► API da Anthropic
                                   │
                                   ├─ 1. protege código, caminhos, URLs, nomes e "citações"
                                   ├─ 2. regras locais: corta cortesias, enrolação e repetição (custo zero)
                                   ├─ 3. reescrita com Claude Haiku 5.5: inglês técnico conciso e estruturado
                                   ├─ 4. valida: nada protegido se perdeu e o texto ficou menor
                                   └─ 5. guarda no cache: o histórico fica idêntico e o prompt caching continua funcionando
```

**Por que inglês?** O mesmo pedido em português costuma gastar mais tokens que em inglês, e o modelo é tão preciso ou mais quando a instrução é inglês técnico curto. O ToToken traduz só o que você escreve e acrescenta `Reply in Brazilian Portuguese.` para a resposta continuar em português.

**Precisão:** a reescrita organiza pedidos com várias partes em `Goal:`, `Context:`, `Constraints:` e `Output:`, e mantém toda negação, número, nome e restrição. Código, caminhos, URLs, identificadores (`parse_config`, `getUser()`), flags (`--force`) e trechos entre aspas passam byte a byte, porque são trocados por marcadores antes de qualquer etapa e devolvidos no fim. Se a reescrita perder um marcador, ficar maior ou falhar, o ToToken usa só a etapa local. Nenhuma requisição é bloqueada por causa dele.

**O que não é tocado:** respostas de ferramentas, o histórico (que só recebe a versão já enviada antes), o prompt de sistema e as respostas do modelo.

## Instalação

Precisa de Node.js 18+ e Claude Code (no Mac/Linux, também git). Não há dependências. Um comando instala tudo:

**macOS / Linux**
```
curl -fsSL https://raw.githubusercontent.com/Nichlekakis/ToToken-Translator/main/install.sh | sh
```

**Windows (PowerShell)**
```
irm https://raw.githubusercontent.com/Nichlekakis/ToToken-Translator/main/install.ps1 | iex
```
No Windows o instalador não precisa de git, e instala o Node.js pelo winget se ele faltar. Se der erro, a mensagem aparece na própria janela.

O instalador baixa o projeto em `~/.totoken/app`, liga o proxy, registra o plugin no Claude Code e aponta o Claude Code para o proxy. Depois é só abrir o Claude Code normalmente. Rodar o mesmo comando de novo atualiza.

Para desfazer tudo: `node ~/.totoken/app/bin/totoken.js remove`.

O Claude Code só é apontado para o proxy se o plugin for registrado, porque é o hook do plugin que religa o proxy em cada sessão (por exemplo, depois de reiniciar o computador). Se o registro falhar, use `node ~/.totoken/app/bin/totoken.js run` para abrir o Claude Code pelo proxy.

Funciona com chave de API e com login de assinatura do Claude Code: a reescrita usa as mesmas credenciais da requisição original.

## Uso

Depois de instalado, não há nada a fazer: todo prompt é comprimido sozinho.

| Comando | O que faz |
| --- | --- |
| `/totoken:stats` | Economia acumulada |
| `/totoken:preview <texto>` | Mostra como um texto seria comprimido |
| `/totoken:mode auto\|local\|off` | `auto`: regras + Haiku. `local`: só regras, custo zero. `off`: desliga |
| `!raw <prompt>` | Envia aquele prompt sem compressão |
| skill `totoken` | Comprime um texto sob pedido ("comprima este prompt") ou liga o modo econômico ("modo totoken") |

### Skill (também no app do Claude)

`skills/totoken/SKILL.md` vem junto com o plugin e também pode ser usada sozinha no claude.ai, onde o proxy não roda. Ela faz duas coisas: comprime um texto que você mandar, seguindo as mesmas etapas do proxy (proteger, cortar, traduzir, estruturar, conferir), e liga um modo econômico em que o Claude trabalha a partir de uma especificação curta do pedido, pergunta antes de adivinhar e responde sem rodeios. A skill não consegue encolher o texto antes do envio; isso é trabalho do proxy.

No terminal: `totoken status`, `totoken start`, `totoken stop`, `totoken stats`, `totoken preview "texto"`, `totoken bench bench/prompts-pt.txt [--api] [--show]`.

Configuração em `~/.totoken/config.json` (ou variáveis `TOTOKEN_*`):

| Chave | Padrão | Significado |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `local` ou `off` |
| `port` | `8787` | Porta do proxy |
| `upstream` | `https://api.anthropic.com` | Para onde o proxy envia |
| `rewriterModel` | `claude-haiku-5-5` | Modelo da reescrita |
| `minCharsForLLM` | `160` | Abaixo disso, só a etapa local roda |
| `translate` | `true` | `false` mantém o idioma original na reescrita |

Logs em `~/.totoken/proxy.log`, cache em `~/.totoken/cache.json`, estatísticas em `~/.totoken/stats.jsonl`.

## Quanto economiza

Com `bench/prompts-pt.txt` (8 prompts reais de programação), só a etapa local corta **cerca de 20%** dos tokens do texto digitado (estimativa offline). A reescrita com Haiku soma a tradução e a reestruturação; meça com a sua chave: `ANTHROPIC_API_KEY=... node bin/totoken.js bench bench/prompts-pt.txt --api --show` (contagem exata via `count_tokens`).

Custo da reescrita: o Haiku 5.5 custa 1/40 do Opus 5.5 por token de entrada, então a reescrita se paga quase sempre. Por isso ela só roda em prompts com 160 caracteres ou mais, onde há o que cortar.

**Limite honesto:** em sessões longas de código, a maior parte dos tokens vem do contexto (arquivos lidos, saídas de ferramentas, histórico), não do que você digita. O ToToken reduz a parte que você escreve e deixa a instrução mais clara, o que tende a evitar idas e voltas. Ele não comprime arquivos nem saídas de ferramentas, porque isso arriscaria a precisão.

## Desenvolvimento

```
npm test          # 20 testes, incluindo proxy de ponta a ponta com API simulada
npm run bench     # benchmark offline
```

Estrutura: `src/protect.js` (marcadores), `src/deterministic.js` (regras locais), `src/rewriter.js` (Haiku), `src/compressor.js` (orquestra e cacheia), `src/transform.js` (corpo da requisição), `src/proxy.js` (servidor), `bin/totoken.js` (CLI), `hooks/`, `commands/` e `skills/` (plugin).

A reescrita usa HTTP direto em vez do SDK de propósito: o proxy reaproveita as credenciais exatas da requisição interceptada e o plugin roda sem `npm install`.

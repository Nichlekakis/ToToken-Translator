# ToToken Translator

Plugin para o Claude Code que comprime automaticamente cada prompt antes de ele chegar ao modelo. O texto fica menor (menos tokens, menos custo e menos consumo de limite) e mais direto (menos ambiguidade, mais precisão). A resposta continua vindo em português.

## Como funciona

```
Você digita ──► Claude Code ──► proxy local ToToken ──► API da Anthropic
                                   │
                                   ├─ 1. protege código, caminhos, URLs, nomes e "citações"
                                   ├─ 2. regras locais: corta cortesias, enrolação e repetição (custo zero)
                                   ├─ 3. reescrita com Claude Haiku 5.5: inglês técnico conciso e estruturado
                                   ├─ 4. valida: nada protegido se perdeu, nenhum número mudou e o texto ficou menor
                                   └─ 5. guarda o que foi enviado: o histórico fica idêntico e o prompt caching continua funcionando
```

**Por que inglês?** O mesmo pedido em português costuma gastar mais tokens que em inglês, e o modelo é tão preciso ou mais quando a instrução é inglês técnico curto. O ToToken traduz só o que você escreve e acrescenta `Reply in Brazilian Portuguese.` para a resposta continuar em português.

**Precisão:** a reescrita organiza pedidos com várias partes em `Goal:`, `Context:`, `Constraints:` e `Output:`, e mantém toda negação, número, nome e restrição. Código, caminhos, URLs, identificadores (`parse_config`, `getUser()`), flags (`--force`) e trechos entre aspas passam byte a byte, porque são trocados por marcadores antes de qualquer etapa e devolvidos no fim. Se a reescrita perder um marcador, trocar ou sumir com um número, ficar maior ou falhar, o ToToken usa só a etapa local. Nenhuma requisição é bloqueada por causa dele.

**Regras locais conservadoras:** elas trabalham linha por linha e só mexem em prosa. Uma linha que nenhuma regra alcança sai idêntica, byte a byte, e linhas com cara de código, log ou dados (indentadas, ou com `{ } = ; < > | $`) nunca são tocadas. As regras só cortam o que é cortesia com certeza: "Você pode me explicar X?" vira "Explicar X?", mas "Você pode usar qualquer lib." (uma permissão), "Pode ser que..." e "Se possível, adicione um teste" ficam como estão.

**Quando a reescrita com Haiku roda:** só em prompts em português (ou outro idioma que não o inglês) com 160 a 6.000 caracteres de texto livre, e só quando a requisição não é para um modelo Haiku. Texto em inglês recebe apenas as regras locais, porque não há ganho de tradução e quase todo texto em inglês que o Claude Code envia foi escrito por ele mesmo (subagentes, resumos, títulos). Para reescrever inglês também, use `"rewriteEnglish": true`.

**Prompt caching protegido:** uma mensagem que já foi enviada é sempre reenviada exatamente igual, mesmo que você troque de modo, desligue o ToToken, atualize a versão ou reinicie o proxy. Mudar um byte do histórico faria a conversa inteira ser cobrada de novo sem cache, o que custaria muito mais do que o ToToken economiza.

**Só o que você digita:** o plugin avisa o proxy de cada prompt que você envia, e o proxy comprime apenas esse texto. O que o próprio Claude Code escreve (tarefas de subagentes, resumos de conversa, títulos, corpo de comandos e skills) passa intacto, assim como respostas de ferramentas, o histórico (que só recebe a versão já enviada antes), o prompt de sistema e as respostas do modelo.

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

Para conferir se está tudo funcionando: `node ~/.totoken/app/bin/totoken.js doctor` (no PowerShell, troque `~` por `$HOME`). Para desfazer tudo: `node ~/.totoken/app/bin/totoken.js remove`.

O Claude Code só é apontado para o proxy se o plugin for registrado, porque são os hooks do plugin que mantêm o proxy ligado: eles conferem o proxy no início de cada sessão e a cada prompt, e o religam se ele tiver caído ou se for de uma versão antiga. Se o registro falhar, use `node ~/.totoken/app/bin/totoken.js run` para abrir o Claude Code pelo proxy.

As regras locais funcionam com qualquer tipo de login. A reescrita com Haiku usa as mesmas credenciais da requisição original; se a API recusar essa chamada (pode acontecer com login de assinatura), o ToToken pausa a reescrita por 5 minutos depois de 3 falhas seguidas, para não atrasar seus prompts, e continua só com as regras locais. O `doctor` mostra quando isso acontece. Para dar à reescrita uma chave de API própria, defina `TOTOKEN_API_KEY` (ou `rewriterApiKey` na configuração).

## Uso

Depois de instalado, não há nada a fazer: todo prompt é comprimido sozinho.

| Comando | O que faz |
| --- | --- |
| `/totoken:stats` | Economia acumulada e quanto a reescrita gastou |
| `/totoken:last` | O que foi enviado de fato nos seus últimos prompts |
| `/totoken:doctor` | Confere cada etapa e diz o que corrigir |
| `/totoken:auto`, `/totoken:local`, `/totoken:off` | `auto`: regras + Haiku. `local`: só regras, custo zero. `off`: não comprime nada novo. Vale na hora, sem reiniciar |
| `raw: <prompt>` | Envia aquele prompt sem compressão |
| skill `totoken` | Comprime um texto sob pedido ("comprima este prompt") ou liga o modo econômico ("modo totoken") |

### Skill (também no app do Claude)

`skills/totoken/SKILL.md` vem junto com o plugin e também pode ser usada sozinha no claude.ai, onde o proxy não roda. Ela faz duas coisas: comprime um texto que você mandar, seguindo as mesmas etapas do proxy (proteger, cortar, traduzir, estruturar, conferir), e liga um modo econômico em que o Claude trabalha a partir de uma especificação curta do pedido, pergunta antes de adivinhar e responde sem rodeios. A skill não consegue encolher o texto antes do envio; isso é trabalho do proxy.

Para testar rápido, sem conversar à mão: `node ~/.totoken/app/bin/totoken.js simulate` manda uma conversa de 4 mensagens ao Claude pelo proxy (usando o seu login do Claude Code) e mostra, para cada mensagem, o que você escreveu, o que foi enviado, a economia e o custo. Com `--compare`, repete a mesma conversa sem compressão e compara custo e tokens de entrada. Com `--file prompts.txt`, usa os seus prompts (separados por linhas `---`). A simulação roda numa pasta própria em `~/.totoken/sim` e não usa ferramentas.

No terminal (`node ~/.totoken/app/bin/totoken.js <comando>`): `doctor`, `status`, `stats`, `last [n]`, `mode auto|local|off`, `preview "texto"`, `bench bench/prompts-pt.txt [--api] [--show]`, `start`, `stop`, `restart`, `cache-clear`.

Configuração em `~/.totoken/config.json` (ou variáveis `TOTOKEN_*`):

| Chave | Padrão | Significado |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `local` ou `off` |
| `port` | `8787` | Porta do proxy |
| `upstream` | `https://api.anthropic.com` | Para onde o proxy envia |
| `rewriterModel` | `claude-haiku-5-5` | Modelo da reescrita |
| `rewriterApiKey` | vazio | Chave de API só para a reescrita (`TOTOKEN_API_KEY`) |
| `minCharsForLLM` / `maxCharsForLLM` | `160` / `6000` | Faixa de tamanho em que a reescrita roda |
| `maxChars` | `20000` | Prompts maiores que isso passam intactos |
| `translate` | `true` | `false` mantém o idioma original na reescrita |
| `rewriteEnglish` | `false` | `true` também reescreve prompts em inglês |
| `logSamples` | `true` | `false` não grava trechos dos prompts nas estatísticas |

`mode` e as opções de reescrita valem na hora; `port` e `upstream` pedem `totoken restart`. Logs em `~/.totoken/proxy.log`, cache em `~/.totoken/cache.json`, estatísticas em `~/.totoken/stats.jsonl`. As estatísticas guardam os primeiros caracteres de cada prompt (é o que o `last` mostra); os arquivos são legíveis só pelo seu usuário.

## Quanto economiza

Com `bench/prompts-pt.txt` (8 prompts reais de programação), só a etapa local corta **cerca de 16%** dos tokens do texto digitado (estimativa offline). A reescrita com Haiku soma a tradução e a reestruturação; meça com a sua chave: `ANTHROPIC_API_KEY=... node bin/totoken.js bench bench/prompts-pt.txt --api --show` (contagem exata via `count_tokens`).

Custo da reescrita: o Haiku 5.5 custa 1/40 do Opus 5.5 por token de entrada, então a reescrita se paga quase sempre. Ela só roda em prompts com 160 caracteres ou mais, onde há o que cortar, e nunca em requisições para um modelo Haiku, onde custaria o mesmo que economiza. O `stats` mostra quantos tokens a reescrita gastou.

**Limite honesto:** em sessões longas de código, a maior parte dos tokens vem do contexto (arquivos lidos, saídas de ferramentas, histórico), não do que você digita. O ToToken reduz a parte que você escreve e deixa a instrução mais clara, o que tende a evitar idas e voltas. Ele não comprime arquivos nem saídas de ferramentas, porque isso arriscaria a precisão. Para encurtar as respostas, que custam cinco vezes mais por token que a entrada, use o modo econômico da skill ou uma instrução no seu `CLAUDE.md`.

## Desenvolvimento

```
npm test          # 45 testes, incluindo proxy de ponta a ponta com API simulada
npm run bench     # benchmark offline
```

Estrutura: `src/protect.js` (marcadores), `src/deterministic.js` (regras locais), `src/rewriter.js` (Haiku), `src/compressor.js` (orquestra e cacheia), `src/transform.js` (corpo da requisição), `src/typed.js` (prompts digitados, informados pelo hook), `src/proxy.js` (servidor), `src/cli/` (processo em segundo plano, `settings.json` do Claude Code, relatórios e simulação), `bin/totoken.js` (entrada da CLI), `hooks/`, `commands/` e `skills/` (plugin). `test/fidelity.test.js` reúne os casos que não podem regredir: frases que só parecem enrolação, código colado e histórico estável.

A reescrita usa HTTP direto em vez do SDK de propósito: o proxy reaproveita as credenciais exatas da requisição interceptada e o plugin roda sem `npm install`.

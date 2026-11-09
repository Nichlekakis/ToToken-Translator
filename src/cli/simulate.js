import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RAW_PREFIX } from '../compressor.js';
import { ensureHome } from '../config.js';
import { readStats } from '../store.js';
import { baseUrl } from './daemon.js';
import { pct, splitPrompts } from './report.js';

const SHELL = process.platform === 'win32';

const SIM_PROMPTS = [
  'Olá Claude, tudo bem? Eu queria que você me explicasse, de um jeito simples, qual é a diferença entre uma Promise e async/await em JavaScript. Por favor, dê um exemplo curto de cada um, porque estou começando agora e fico meio confuso, sabe?',
  'Valeu! Agora, você poderia por favor me mostrar como eu trataria um erro nesse mesmo exemplo com async/await? Basicamente eu quero saber onde colocar o try/catch e o que acontece se eu esquecer dele.',
  'Entendi. E se eu tiver três requisições que não dependem uma da outra, você consegue me explicar como rodar todas ao mesmo tempo em vez de uma depois da outra? Se possível, compare o tempo total das duas formas.',
  'Por último, por favor, resuma tudo o que conversamos em no máximo cinco tópicos curtos, para eu salvar nas minhas anotações. Obrigado desde já!',
];

const NO_TOOLS = 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,Task,Agent';

export function hasClaudeCli() {
  return spawnSync('claude', ['--version'], { stdio: 'ignore', shell: SHELL }).status === 0;
}

export function claudeCli(args) {
  return spawnSync('claude', args, { stdio: 'inherit', shell: SHELL }).status === 0;
}

// Runs one scripted conversation through `claude -p`, so it uses the user's own
// Claude Code login. Prompts go through stdin to survive Windows shell quoting.
function runConversation(prompts, cwd, env) {
  const turns = [];
  for (const [i, prompt] of prompts.entries()) {
    const args = ['-p', '--output-format', 'json', '--disallowedTools', NO_TOOLS];
    if (i > 0) args.push('--continue');
    const r = spawnSync('claude', args, { cwd, env, input: prompt, encoding: 'utf8', shell: SHELL, maxBuffer: 32 * 1024 * 1024 });
    let data = null;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      // not JSON: report raw output below
    }
    if (!data || data.is_error) {
      throw new Error(`o Claude Code falhou no turno ${i + 1}: ${(data && data.result) || r.stderr || r.stdout || 'sem saída'}`.slice(0, 600));
    }
    turns.push({ prompt, reply: String(data.result || ''), cost: Number(data.total_cost_usd || 0), usage: data.usage || {} });
  }
  return turns;
}

const inputTokens = (u) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
const sum = (turns, f) => turns.reduce((s, t) => s + f(t), 0);

export async function simulate(cfg, args) {
  if (!hasClaudeCli()) throw new Error('não encontrei o comando "claude". Instale o Claude Code primeiro.');
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0 && !args[fileIdx + 1]) throw new Error('uso: totoken simulate --file <arquivo>');
  const prompts = fileIdx >= 0 ? splitPrompts(args[fileIdx + 1]) : SIM_PROMPTS;
  const base = path.join(ensureHome(), 'sim');
  fs.rmSync(base, { recursive: true, force: true }); // leftovers of earlier runs
  const viaDir = path.join(base, 'via');
  fs.mkdirSync(viaDir, { recursive: true });
  const env = { ...process.env, ANTHROPIC_BASE_URL: baseUrl(cfg) };
  const statsBefore = readStats().length;

  console.log(`Simulando ${prompts.length} mensagens pelo ToToken (modo ${cfg.mode})...\n`);
  const via = runConversation(prompts, viaDir, env);
  // Claude Code also sends side requests, so match each turn by its own text.
  const newStats = readStats().slice(statsBefore);
  const statFor = (prompt) => newStats.find((s) => s.orig === prompt.slice(0, 80));

  let before = 0;
  let after = 0;
  for (const [i, t] of via.entries()) {
    const st = statFor(t.prompt);
    console.log(`── Mensagem ${i + 1} ─────────────────────────────`);
    console.log(`Você:     ${t.prompt}`);
    if (st) {
      console.log(`Enviado:  ${String(st.sample || '').replace(/\n/g, '\n          ')}`);
      console.log(`Tokens:   ~${st.before} → ~${st.after} (${pct(st.before, st.after)} a menos, ${st.method}${st.failure ? `, reescrita não entrou: ${st.failure}` : ''})`);
      before += st.before;
      after += st.after;
    } else {
      console.log('Enviado:  (sem registro: esta mensagem seguiu como você escreveu)');
    }
    const reply = t.reply.replace(/\s+/g, ' ').trim();
    console.log(`Claude:   ${reply.slice(0, 220)}${reply.length > 220 ? '…' : ''}`);
    console.log(`Custo:    US$ ${t.cost.toFixed(4)}\n`);
  }
  const viaCost = sum(via, (t) => t.cost);
  const viaIn = sum(via, (t) => inputTokens(t.usage));
  console.log(`Seu texto: ~${before} → ~${after} tokens (${pct(before, after)} a menos)`);
  console.log(`Conversa com ToToken: US$ ${viaCost.toFixed(4)} · ${viaIn} tokens de entrada no total`);

  if (args.includes('--compare')) {
    console.log('\nRepetindo a mesma conversa sem o ToToken para comparar...');
    const directDir = path.join(base, 'direct');
    fs.mkdirSync(directDir, { recursive: true });
    // "!raw" makes the proxy pass each prompt untouched; this works even when
    // settings.json pins Claude Code to the proxy.
    const direct = runConversation(prompts.map((p) => `${RAW_PREFIX} ${p}`), directDir, env);
    const dCost = sum(direct, (t) => t.cost);
    const dIn = sum(direct, (t) => inputTokens(t.usage));
    console.log(`Conversa sem ToToken: US$ ${dCost.toFixed(4)} · ${dIn} tokens de entrada no total`);
    console.log(`Diferença: ${pct(dCost, viaCost)} no custo, ${pct(dIn, viaIn)} nos tokens de entrada`);
    console.log('Obs.: o custo inclui as respostas, que variam entre execuções; rode algumas vezes antes de concluir.');
  }
}

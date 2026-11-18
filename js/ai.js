// Resumo, tópicos, tarefas e perguntas sobre a transcrição.
// Com chave da API da Anthropic usa o Claude; sem chave usa um resumo extrativo local.
import { getSettings } from './settings.js';
import { fmtShort } from './export.js';

const MODEL = 'claude-opus-5-5';
let clientPromise = null;
let clientKey = '';

async function getClient() {
  const { apiKey } = getSettings();
  if (!apiKey) return null;
  if (!clientPromise || clientKey !== apiKey) {
    clientKey = apiKey;
    clientPromise = import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.4.0/+esm').then(
      ({ default: Anthropic }) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
    );
  }
  return clientPromise;
}

export function hasAI() {
  return !!getSettings().apiKey;
}

function transcriptText(t) {
  return t.segments.map((s) => {
    const sp = s.speaker && t.speakers?.[s.speaker];
    return `[${fmtShort(s.start)}]${sp ? ' ' + sp + ':' : ''} ${s.text}`;
  }).join('\n');
}

const SYSTEM = `Você é um assistente que analisa transcrições de aulas, reuniões, entrevistas e palestras.
Responda sempre em português do Brasil, com linguagem clara, fluida e natural.
Baseie-se exclusivamente no conteúdo da transcrição fornecida. Quando algo não estiver na transcrição, diga isso em vez de inventar.
Quando citar um trecho, indique o minuto entre colchetes, como [12:34].`;

async function ask(messages, maxTokens = 16000) {
  const client = await getClient();
  if (!client) throw new Error('Configure sua chave da API da Anthropic em Configurações para usar a IA.');
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    system: SYSTEM,
    output_config: { effort: 'medium' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages,
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error('O modelo recusou esta solicitação. Tente reformular a pergunta.');
  }
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

export async function summarize(t) {
  if (!hasAI()) return { text: localSummary(t), generatedBy: 'local' };
  const prompt = `Abaixo está a transcrição "${t.title}". Produza, em Markdown simples, as seções:

### Resumo
Um ou dois parágrafos corridos que expliquem o conteúdo principal.

### Tópicos principais
Lista com os temas tratados, cada um com o minuto em que aparece.

### Pontos de ação e encaminhamentos
Lista de tarefas, decisões ou prazos mencionados (escreva "Nenhum identificado" se não houver).

### Palavras-chave
Uma linha com até oito termos separados por vírgula.

<transcricao>
${transcriptText(t)}
</transcricao>`;
  const text = await ask([{ role: 'user', content: prompt }]);
  return { text, generatedBy: MODEL };
}

export async function askQuestion(t, history, question) {
  const messages = [
    { role: 'user', content: `Esta é a transcrição "${t.title}" que vamos discutir.\n\n<transcricao>\n${transcriptText(t)}\n</transcricao>` },
    { role: 'assistant', content: 'Li a transcrição. Pode perguntar.' },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: question },
  ];
  return ask(messages, 8000);
}

// ---------- Resumo extrativo local (sem internet nem chave) ----------
const STOP = new Set(`a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra pro com sem sob
sobre entre e ou mas que se como quando onde porque porquê já não sim muito muita muitos muitas mais menos também só então
isso isto aquilo esse essa esses essas este esta estes estas aquele aquela eu tu ele ela nós vós eles elas você vocês me te
lhe nos vos lhes meu minha meus minhas seu sua seus suas nosso nossa é ser foi era são estar está estão estava tem ter tinha
há vai vou vamos fazer faz fez aí lá aqui ali bem tipo né daí assim coisa gente ao aos à às num numa até depois antes
the of and to in is it that for on with as was are be this you i`.split(/\s+/));

function tokenize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) || [];
}

export function keywords(t, n = 8) {
  const freq = new Map();
  for (const seg of t.segments) {
    for (const w of tokenize(seg.text)) if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

export function localSummary(t) {
  const sentences = [];
  for (const seg of t.segments) {
    for (const s of seg.text.split(/(?<=[.!?])\s+/)) {
      if (s.trim().split(/\s+/).length >= 6) sentences.push({ text: s.trim(), start: seg.start });
    }
  }
  if (!sentences.length) return 'A transcrição é curta demais para gerar um resumo automático.';
  const freq = new Map();
  for (const s of sentences) for (const w of tokenize(s.text)) if (!STOP.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  const scored = sentences.map((s, i) => {
    const words = tokenize(s.text).filter((w) => !STOP.has(w));
    const score = words.reduce((a, w) => a + (freq.get(w) || 0), 0) / Math.max(4, words.length);
    return { ...s, i, score };
  });
  const k = Math.min(6, Math.max(2, Math.round(sentences.length * 0.15)));
  const top = scored.sort((a, b) => b.score - a.score).slice(0, k).sort((a, b) => a.i - b.i);
  const kw = keywords(t);
  return `### Resumo (gerado localmente)
${top.map((s) => `- [${fmtShort(s.start)}] ${s.text}`).join('\n')}

### Palavras-chave
${kw.join(', ')}

_Para um resumo mais completo, com tópicos e pontos de ação, adicione sua chave da API da Anthropic em Configurações._`;
}

// Converte o Markdown simples retornado em HTML seguro.
export function mdToHTML(md) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<button class="time-link" data-time="$1">[$1]</button>');
  let html = '';
  let inList = false;
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) html += `<h4>${inline(h[1])}</h4>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

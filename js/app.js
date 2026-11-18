import * as db from './db.js';
import { transcribeBlob } from './transcribe.js';
import { startRecording, speechRecognitionAvailable, tabCaptureAvailable } from './recorder.js';
import { exportAs, fmtShort, toTXT } from './export.js';
import { summarize, askQuestion, hasAI, mdToHTML, keywords } from './ai.js';
import { getSettings, saveSettings, applyTheme, MODELS, LANGUAGES, SPEECH_LANG } from './settings.js';

const view = document.getElementById('view');
const SPEAKER_COLORS = ['#116466', '#e8875b', '#6c5ce7', '#2d9c5a', '#c2417b', '#3577c4', '#b8860b', '#7a5c45'];

// Trabalhos de transcrição em andamento (continuam mesmo trocando de página)
const jobs = new Map();
let activeRecording = null;
let cleanup = [];

applyTheme();

// ---------------- utilidades ----------------
const $ = (sel, root = view) => root.querySelector(sel);
const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sourceLabel(src) {
  return { upload: 'Arquivo', mic: 'Microfone', tab: 'Reunião / aba' }[src] || src;
}

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function highlight(text, query) {
  if (!query) return esc(text);
  const nText = normalize(text);
  const nQ = normalize(query);
  let out = '';
  let i = 0;
  let idx;
  while ((idx = nText.indexOf(nQ, i)) !== -1) {
    out += esc(text.slice(i, idx)) + '<mark>' + esc(text.slice(idx, idx + nQ.length)) + '</mark>';
    i = idx + nQ.length;
  }
  return out + esc(text.slice(i));
}

function parseTime(str) {
  return str.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
}

function defaultTitle(source) {
  const d = new Date();
  const label = { upload: 'Arquivo', mic: 'Gravação', tab: 'Reunião' }[source] || 'Transcrição';
  return `${label} de ${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function setActiveNav(route) {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  document.getElementById('sidebar').classList.remove('open');
}

document.getElementById('menuBtn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

// ---------------- roteador ----------------
async function router() {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  const hash = location.hash || '#/';
  const [, route, id] = hash.split('/');
  if (route === 'novo') { setActiveNav('novo'); renderNew(); }
  else if (route === 't' && id) { setActiveNav(''); await renderEditor(id); }
  else if (route === 'config') { setActiveNav('config'); renderSettings(); }
  else { setActiveNav('biblioteca'); await renderLibrary(); }
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

// ---------------- biblioteca ----------------
async function renderLibrary() {
  const items = await db.listAll();
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Minhas transcrições</h1>
        <p class="muted">${items.length ? `${items.length} ${items.length === 1 ? 'arquivo salvo' : 'arquivos salvos'} neste navegador` : 'Comece gravando ou enviando um áudio.'}</p>
      </div>
      <div class="spacer"></div>
      <a class="btn primary" href="#/novo"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Nova transcrição</a>
    </div>
    ${items.length ? `<input type="search" id="libSearch" placeholder="Buscar por título ou por qualquer palavra dita..." style="margin-bottom:18px">` : ''}
    <div id="libList"></div>`;

  const list = $('#libList');
  const draw = (q = '') => {
    const nq = normalize(q);
    const filtered = items.filter((t) => !nq || normalize(t.title).includes(nq) || t.segments.some((s) => normalize(s.text).includes(nq)));
    if (!items.length) {
      list.innerHTML = `<div class="card empty">
        <svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg>
        <h2>Nada por aqui ainda</h2>
        <p class="muted">Grave uma aula, uma reunião ou envie um arquivo de áudio ou vídeo para transformar em texto.</p>
        <a class="btn primary" href="#/novo">Criar a primeira transcrição</a></div>`;
      return;
    }
    if (!filtered.length) { list.innerHTML = '<p class="muted">Nenhum resultado para essa busca.</p>'; return; }
    list.innerHTML = `<div class="lib-grid">${filtered.map((t) => {
      const match = nq && t.segments.find((s) => normalize(s.text).includes(nq));
      const snippet = match ? highlight(match.text, q) : esc(t.segments.slice(0, 4).map((s) => s.text).join(' ') || (jobs.has(t.id) ? 'Transcrevendo...' : 'Sem texto'));
      const status = jobs.has(t.id) ? '<span class="tag accent">Transcrevendo</span>' : (t.status === 'error' ? '<span class="tag accent">Erro</span>' : '');
      return `<a class="card lib-card" href="#/t/${t.id}">
        <div class="row"><span class="tag brand">${sourceLabel(t.source)}</span><span class="tag">${fmtShort(t.duration)}</span>${status}${t.summary ? '<span class="tag">Resumo</span>' : ''}</div>
        <h3>${esc(t.title)}</h3>
        <p class="snippet">${snippet}</p>
        <span class="muted small">${fmtDate(t.createdAt)}</span>
      </a>`;
    }).join('')}</div>`;
  };
  draw();
  $('#libSearch')?.addEventListener('input', (e) => draw(e.target.value));
}

// ---------------- nova transcrição ----------------
function renderNew() {
  const s = getSettings();
  const srOk = speechRecognitionAvailable();
  view.innerHTML = `
    <div class="page-head"><div><h1>Nova transcrição</h1><p class="muted">Escolha de onde vem o áudio.</p></div></div>
    <div class="new-grid">
      <button class="card option selected" data-mode="upload">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg></span>
        <h3>Enviar arquivo</h3><p>MP3, WAV, M4A, OGG, WEBM, MP4 e outros formatos de áudio ou vídeo.</p>
      </button>
      <button class="card option" data-mode="mic">
        <span class="ico alt"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg></span>
        <h3>Gravar pelo microfone</h3><p>Aulas presenciais, entrevistas e anotações de voz, com legenda ao vivo.</p>
      </button>
      <button class="card option" data-mode="tab">
        <span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></span>
        <h3>Gravar reunião online</h3><p>Captura o som de uma aba do navegador (Meet, Teams, Zoom web) junto com o seu microfone.</p>
      </button>
    </div>
    <div id="modePanel"></div>
    <p class="muted small" style="margin-top:18px">Idioma: <strong>${esc(LANGUAGES.find((l) => l[0] === s.language)?.[1] || s.language)}</strong> · Modelo: <strong>${esc(MODELS.find((m) => m.id === s.model)?.label || s.model)}</strong> · <a href="#/config">alterar</a></p>`;

  const panel = $('#modePanel');
  const show = (mode) => {
    $$('.option').forEach((o) => o.classList.toggle('selected', o.dataset.mode === mode));
    if (mode === 'upload') panelUpload(panel);
    else panelRecord(panel, mode, srOk);
  };
  $$('.option').forEach((o) => o.addEventListener('click', () => { if (!activeRecording) show(o.dataset.mode); }));
  show('upload');
}

function panelUpload(panel) {
  panel.innerHTML = `
    <label class="dropzone" id="drop">
      <svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>
      <h2 style="margin-top:8px">Arraste o arquivo aqui ou clique para escolher</h2>
      <p class="muted">Você pode selecionar vários arquivos de uma vez. O processamento acontece no seu computador.</p>
      <input type="file" id="fileInput" accept="audio/*,video/*" multiple hidden>
    </label>
    <div class="notice info" style="margin-top:14px">Na primeira vez o modelo de reconhecimento de fala é baixado (entre 40 e 250 MB, conforme a opção escolhida) e fica guardado no navegador para as próximas transcrições.</div>`;
  const drop = $('#drop', panel);
  const input = $('#fileInput', panel);
  const handle = async (files) => {
    const list = [...files].filter((f) => /^(audio|video)\//.test(f.type) || /\.(mp3|wav|m4a|ogg|opus|webm|mp4|mov|aac|flac|mkv)$/i.test(f.name));
    if (!list.length) { toast('Escolha um arquivo de áudio ou vídeo.'); return; }
    let firstId = null;
    for (const file of list) {
      const item = {
        id: db.newId(),
        title: file.name.replace(/\.[^.]+$/, ''),
        createdAt: Date.now(),
        source: 'upload',
        duration: 0,
        audioBlob: file,
        segments: [],
        speakers: { S1: 'Falante 1', S2: 'Falante 2' },
        status: 'processing',
        notes: '',
      };
      await db.save(item);
      startJob(item.id);
      firstId = firstId || item.id;
    }
    location.hash = `#/t/${firstId}`;
  };
  input.addEventListener('change', () => handle(input.files));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => handle(e.dataTransfer.files));
}

function panelRecord(panel, mode, srOk) {
  const isTab = mode === 'tab';
  if (isTab && !tabCaptureAvailable()) {
    panel.innerHTML = '<div class="notice">Este navegador não permite capturar o áudio de abas. Use o Google Chrome ou o Microsoft Edge no computador.</div>';
    return;
  }
  panel.innerHTML = `
    <div class="card recorder">
      ${isTab ? '<div class="notice info" style="text-align:left;margin-bottom:14px">Ao clicar em gravar, escolha a <strong>aba</strong> da reunião e marque <strong>"Compartilhar áudio da guia"</strong>. O vídeo não é gravado, apenas o som.</div>' : ''}
      <button class="rec-btn" id="recBtn" aria-label="Iniciar gravação"><svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/></svg></button>
      <div class="rec-time" id="recTime">00:00</div>
      <div class="row" style="justify-content:center">
        <button class="btn" id="pauseBtn" hidden>Pausar</button>
        <button class="btn primary" id="stopBtn" hidden>Finalizar e salvar</button>
      </div>
      <canvas class="wave" id="wave" width="900" height="70"></canvas>
      <div class="stack" style="text-align:left;max-width:560px;margin:0 auto">
        <label class="check"><input type="checkbox" id="liveChk" ${srOk ? 'checked' : 'disabled'}>
          <span>Legenda ao vivo enquanto grava ${srOk ? (isTab ? '<span class="muted small">(capta apenas a sua voz pelo microfone)</span>' : '') : '<span class="muted small">(indisponível neste navegador, use o Chrome ou o Edge)</span>'}</span></label>
        <label class="check"><input type="checkbox" id="whisperChk" ${isTab || !srOk ? 'checked' : ''}>
          <span>Ao terminar, refazer a transcrição completa com o Whisper <span class="muted small">(mais precisa e inclui todas as vozes)</span></span></label>
      </div>
      <div class="live-box" id="liveBox" hidden></div>
    </div>`;

  const recBtn = $('#recBtn', panel);
  const pauseBtn = $('#pauseBtn', panel);
  const stopBtn = $('#stopBtn', panel);
  const timeEl = $('#recTime', panel);
  const canvas = $('#wave', panel);
  const liveBox = $('#liveBox', panel);
  const g = canvas.getContext('2d');
  let timer = 0;

  const drawWave = (data) => {
    const w = canvas.width; const h = canvas.height;
    g.clearRect(0, 0, w, h);
    g.lineWidth = 2;
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#116466';
    g.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / data.length) * w;
      const y = (data[i] / 255) * h;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  };

  recBtn.addEventListener('click', async () => {
    if (activeRecording) return;
    try {
      const lang = SPEECH_LANG[getSettings().language] || 'pt-BR';
      activeRecording = await startRecording({
        mode,
        lang,
        live: $('#liveChk', panel).checked,
        onLevel: drawWave,
        onLive: ({ segments, interim }) => {
          liveBox.hidden = false;
          liveBox.innerHTML = segments.map((s) => `<p><span class="muted small">${fmtShort(s.start)}</span> ${esc(s.text)}</p>`).join('') + (interim ? `<p class="interim">${esc(interim)}</p>` : '');
          liveBox.scrollTop = liveBox.scrollHeight;
        },
      });
    } catch (err) {
      activeRecording = null;
      toast(err.name === 'NotAllowedError' ? 'Permissão negada para usar o microfone ou a aba.' : (err.message || 'Não foi possível iniciar a gravação.'), 4500);
      return;
    }
    recBtn.classList.add('recording');
    recBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    pauseBtn.hidden = false; stopBtn.hidden = false;
    timer = setInterval(() => { timeEl.textContent = fmtShort(activeRecording.elapsed()); }, 250);
    recBtn.onclick = () => stopBtn.click();
  });

  pauseBtn.addEventListener('click', () => {
    if (!activeRecording) return;
    if (activeRecording.paused) { activeRecording.resume(); pauseBtn.textContent = 'Pausar'; recBtn.classList.add('recording'); }
    else { activeRecording.pause(); pauseBtn.textContent = 'Continuar'; recBtn.classList.remove('recording'); }
  });

  stopBtn.addEventListener('click', async () => {
    if (!activeRecording) return;
    stopBtn.disabled = true;
    clearInterval(timer);
    const rec = activeRecording;
    activeRecording = null;
    const { blob, duration, liveSegments } = await rec.stop();
    const useWhisper = $('#whisperChk', panel).checked || !liveSegments.length;
    const item = {
      id: db.newId(),
      title: defaultTitle(mode),
      createdAt: Date.now(),
      source: mode,
      duration,
      audioBlob: blob,
      segments: liveSegments.map((s) => ({ ...s, id: db.newId(), speaker: 'S1' })),
      speakers: { S1: 'Falante 1', S2: 'Falante 2' },
      status: useWhisper ? 'processing' : 'done',
      notes: '',
    };
    await db.save(item);
    if (useWhisper) startJob(item.id);
    location.hash = `#/t/${item.id}`;
  });

  cleanup.push(() => {
    clearInterval(timer);
    if (activeRecording) {
      const rec = activeRecording;
      activeRecording = null;
      rec.stop();
      toast('A gravação foi interrompida porque você saiu da página.');
    }
  });
}

// ---------------- trabalhos de transcrição ----------------
function startJob(id) {
  if (jobs.has(id)) return;
  const job = { status: 'Preparando...', progress: 0, load: null, listeners: new Set() };
  jobs.set(id, job);
  const emit = () => job.listeners.forEach((fn) => fn(job));
  // Fila simples: um arquivo por vez para não sobrecarregar o computador
  startJob.queue = (startJob.queue || Promise.resolve()).then(async () => {
    const item = await db.get(id);
    if (!item) { jobs.delete(id); return; }
    const fresh = [];
    try {
      const { segments, duration } = await transcribeBlob(item.audioBlob, {
        onStatus: (s) => { job.status = s; emit(); },
        onLoad: (p) => { job.load = p; job.status = `Baixando o modelo (${Math.round(p.pct * 100)}%)...`; emit(); },
        onPartial: async ({ segments: segs, progress }) => {
          fresh.push(...segs.map((s) => ({ ...s, id: db.newId(), speaker: 'S1' })));
          job.progress = progress;
          job.status = `Transcrevendo... ${Math.round(progress * 100)}%`;
          job.partial = fresh;
          emit();
        },
      });
      const latest = (await db.get(id)) || item;
      latest.segments = segments.map((s, i) => ({ ...s, id: fresh[i]?.id || db.newId(), speaker: 'S1' }));
      latest.duration = duration || latest.duration;
      latest.status = 'done';
      await db.save(latest);
      jobs.delete(id);
      job.done = true;
      emit();
      toast(`Transcrição pronta: ${latest.title}`);
    } catch (err) {
      console.error(err);
      const latest = (await db.get(id)) || item;
      latest.status = latest.segments.length ? 'done' : 'error';
      latest.error = String(err.message || err);
      await db.save(latest);
      jobs.delete(id);
      job.error = latest.error;
      emit();
      toast('Falha na transcrição. Veja os detalhes na página do arquivo.', 4500);
    }
  });
}

// ---------------- editor ----------------
async function renderEditor(id) {
  const t = await db.get(id);
  if (!t) { view.innerHTML = '<div class="card empty"><h2>Transcrição não encontrada</h2><a class="btn" href="#/">Voltar</a></div>'; return; }
  t.speakers = t.speakers || { S1: 'Falante 1' };
  let query = '';
  const audioURL = t.audioBlob ? URL.createObjectURL(t.audioBlob) : '';
  cleanup.push(() => audioURL && URL.revokeObjectURL(audioURL));
  const chatHistory = t.chat || [];
  let saveTimer = 0;
  const persist = (immediate) => {
    clearTimeout(saveTimer);
    const run = () => (t.deleted ? undefined : db.save(t));
    if (immediate) return run();
    saveTimer = setTimeout(run, 500);
    return undefined;
  };
  cleanup.push(() => { clearTimeout(saveTimer); if (!t.deleted) db.save(t); });

  view.innerHTML = `
    <div class="editor">
      <section>
        <div class="card">
          <input class="title-input" id="title" type="text" value="${esc(t.title)}" aria-label="Título">
          <div class="row muted small" style="margin-top:6px">
            <span>${fmtDate(t.createdAt)}</span><span>·</span><span id="durLabel">${fmtShort(t.duration)}</span><span>·</span><span>${sourceLabel(t.source)}</span>
            <span>·</span><span id="wordCount"></span>
          </div>
          <div class="toolbar">
            <input type="search" id="search" placeholder="Buscar na transcrição">
            <span class="muted small" id="searchCount"></span>
            <div class="spacer"></div>
            <button class="btn sm" id="copyBtn" title="Copiar texto">Copiar</button>
            <div class="menu" id="exportMenu">
              <button class="btn sm primary" id="exportBtn">Exportar ▾</button>
              <div class="menu-list">
                <button data-exp="doc">Word (.doc)</button>
                <button data-exp="pdf">PDF (imprimir)</button>
                <button data-exp="txt">Texto com tempos (.txt)</button>
                <button data-exp="txt-plain">Texto corrido (.txt)</button>
                <button data-exp="md">Markdown (.md)</button>
                <button data-exp="srt">Legenda SRT (.srt)</button>
                <button data-exp="vtt">Legenda WebVTT (.vtt)</button>
                <button data-exp="json">Dados completos (.json)</button>
                <button data-exp="audio">Áudio original</button>
              </div>
            </div>
            <div class="menu" id="moreMenu">
              <button class="btn sm ghost" id="moreBtn" aria-label="Mais opções">•••</button>
              <div class="menu-list">
                <button id="retryBtn">Transcrever novamente com o Whisper</button>
                <button id="alternateBtn">Alternar falantes a cada pausa longa</button>
                <button id="deleteBtn" style="color:var(--danger)">Excluir transcrição</button>
              </div>
            </div>
          </div>
          <div id="jobBox"></div>
          <div class="transcript" id="transcript"></div>
        </div>
        ${audioURL ? `<div class="card player">
          <button class="icon-btn" id="back5" title="Voltar 5 segundos">−5s</button>
          <audio id="audio" controls preload="metadata" src="${audioURL}"></audio>
          <button class="icon-btn" id="fwd5" title="Avançar 5 segundos">+5s</button>
          <select id="rate" style="width:auto" aria-label="Velocidade">
            ${[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => `<option value="${r}" ${r === 1 ? 'selected' : ''}>${r}×</option>`).join('')}
          </select>
          <label class="check small"><input type="checkbox" id="follow" checked> Acompanhar texto</label>
        </div>` : ''}
      </section>
      <aside class="side">
        <div class="card">
          <div class="tabs">
            <button data-tab="resumo" class="active">Resumo</button>
            <button data-tab="chat">Perguntar</button>
            <button data-tab="falantes">Falantes</button>
            <button data-tab="notas">Notas</button>
          </div>
          <div id="tabBody"></div>
        </div>
      </aside>
    </div>`;

  const audio = $('#audio');
  const transcriptEl = $('#transcript');

  // ----- título -----
  $('#title').addEventListener('input', (e) => { t.title = e.target.value || 'Sem título'; persist(); });

  // ----- trabalhos em andamento -----
  const jobBox = $('#jobBox');
  const drawJob = (job) => {
    if (!job || job.done) { jobBox.innerHTML = ''; return; }
    if (job.error) { jobBox.innerHTML = `<div class="notice">Não foi possível transcrever. ${esc(job.error)}</div>`; return; }
    const pct = job.load && job.load.pct < 1 && !job.progress ? job.load.pct : job.progress;
    jobBox.innerHTML = `<div class="stack" style="margin:8px 0 16px"><div class="row"><strong>${esc(job.status)}</strong></div>
      <div class="progress ${pct ? '' : 'indeterminate'}"><div style="width:${pct ? Math.round(pct * 100) : 35}%"></div></div>
      <span class="muted small">Você pode navegar por outras páginas enquanto isso, o processamento continua.</span></div>`;
  };
  const job = jobs.get(t.id);
  if (job) {
    const listener = async (j) => {
      drawJob(j);
      if (j.partial && !j.done) { t.segments = j.partial; drawTranscript(); }
      if (j.done || j.error) {
        const fresh = await db.get(t.id);
        if (fresh) { Object.assign(t, { segments: fresh.segments, duration: fresh.duration, status: fresh.status, error: fresh.error }); }
        $('#durLabel').textContent = fmtShort(t.duration);
        drawTranscript();
        if (j.done) jobBox.innerHTML = '';
      }
    };
    job.listeners.add(listener);
    cleanup.push(() => job.listeners.delete(listener));
    drawJob(job);
  } else if (t.status === 'error') {
    jobBox.innerHTML = `<div class="notice">A transcrição falhou: ${esc(t.error || 'erro desconhecido')}. Tente outro modelo em Configurações e use "Transcrever novamente".</div>`;
  }

  // ----- transcrição -----
  function speakerOptions(sel) {
    const opts = Object.entries(t.speakers).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
    return `<option value="" ${!sel ? 'selected' : ''}>Sem falante</option>${opts}<option value="__new">+ Novo falante</option>`;
  }
  function speakerColor(k) {
    const keys = Object.keys(t.speakers);
    return SPEAKER_COLORS[Math.max(0, keys.indexOf(k)) % SPEAKER_COLORS.length];
  }

  function drawTranscript() {
    const words = t.segments.reduce((a, s) => a + (s.text.trim() ? s.text.trim().split(/\s+/).length : 0), 0);
    $('#wordCount').textContent = `${words.toLocaleString('pt-BR')} palavras`;
    if (!t.segments.length) {
      transcriptEl.innerHTML = jobs.has(t.id) ? '<p class="muted">O texto vai aparecendo aqui conforme o áudio é processado.</p>' : '<p class="muted">Sem texto transcrito.</p>';
      $('#searchCount').textContent = '';
      return;
    }
    let matches = 0;
    transcriptEl.innerHTML = t.segments.map((s, i) => {
      if (query && normalize(s.text).includes(normalize(query))) matches++;
      return `<div class="seg" data-i="${i}">
        <div class="meta">
          <button class="time" data-t="${s.start}">${fmtShort(s.start)}</button>
          <select class="speaker" data-i="${i}" style="border-left:4px solid ${s.speaker ? speakerColor(s.speaker) : 'transparent'}">${speakerOptions(s.speaker)}</select>
        </div>
        <div class="text" contenteditable="true" spellcheck="true" data-i="${i}">${highlight(s.text, query)}</div>
      </div>`;
    }).join('');
    $('#searchCount').textContent = query ? `${matches} ${matches === 1 ? 'trecho' : 'trechos'}` : '';
  }
  drawTranscript();

  transcriptEl.addEventListener('click', (e) => {
    const tb = e.target.closest('.time');
    if (tb && audio) { audio.currentTime = Number(tb.dataset.t); audio.play(); }
  });
  transcriptEl.addEventListener('focusin', (e) => {
    const el = e.target.closest('.text');
    if (el && query) el.textContent = t.segments[el.dataset.i].text;
  });
  transcriptEl.addEventListener('focusout', (e) => {
    const el = e.target.closest('.text');
    if (!el) return;
    const i = Number(el.dataset.i);
    const txt = el.innerText.replace(/\n+/g, ' ').trim();
    if (!txt) {
      t.segments.splice(i, 1);
      persist();
      drawTranscript();
      return;
    }
    if (txt !== t.segments[i].text) { t.segments[i].text = txt; persist(); }
    if (query) el.innerHTML = highlight(txt, query);
  });
  transcriptEl.addEventListener('keydown', (e) => {
    const el = e.target.closest('.text');
    if (!el) return;
    // Enter divide o trecho na posição do cursor
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const i = Number(el.dataset.i);
      const sel = window.getSelection();
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.startContainer, range.startOffset);
      const full = el.innerText;
      const pos = pre.toString().length;
      const a = full.slice(0, pos).trim();
      const b = full.slice(pos).trim();
      if (!a || !b) return;
      const seg = t.segments[i];
      const mid = seg.start + (seg.end - seg.start) * (a.length / full.length);
      t.segments.splice(i, 1, { ...seg, text: a, end: mid }, { ...seg, id: db.newId(), text: b, start: mid });
      persist();
      drawTranscript();
      $(`.text[data-i="${i + 1}"]`)?.focus();
    }
    // Backspace no início junta com o trecho anterior
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      const i = Number(el.dataset.i);
      if (i > 0 && sel.isCollapsed) {
        const pre = sel.getRangeAt(0).cloneRange();
        pre.selectNodeContents(el);
        pre.setEnd(sel.anchorNode, sel.anchorOffset);
        if (pre.toString().length === 0) {
          e.preventDefault();
          const prev = t.segments[i - 1];
          const cur = t.segments[i];
          prev.text = `${prev.text} ${el.innerText.trim()}`.trim();
          prev.end = cur.end;
          t.segments.splice(i, 1);
          persist();
          drawTranscript();
          $(`.text[data-i="${i - 1}"]`)?.focus();
        }
      }
    }
  });
  transcriptEl.addEventListener('change', (e) => {
    const sel = e.target.closest('select.speaker');
    if (!sel) return;
    const i = Number(sel.dataset.i);
    let val = sel.value;
    if (val === '__new') {
      const name = prompt('Nome do novo falante:', `Falante ${Object.keys(t.speakers).length + 1}`);
      if (!name) { drawTranscript(); return; }
      val = 'S' + (Math.max(0, ...Object.keys(t.speakers).map((k) => Number(k.slice(1)) || 0)) + 1);
      t.speakers[val] = name;
    }
    t.segments[i].speaker = val;
    persist();
    drawTranscript();
    if (currentTab === 'falantes') drawTab();
  });

  // ----- busca -----
  $('#search').addEventListener('input', (e) => {
    query = e.target.value.trim();
    drawTranscript();
    if (query) transcriptEl.querySelector('mark')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  // ----- player sincronizado -----
  if (audio) {
    let lastIdx = -1;
    audio.addEventListener('timeupdate', () => {
      const ct = audio.currentTime;
      const idx = t.segments.findIndex((s, i) => ct >= s.start && ct < (t.segments[i + 1]?.start ?? Infinity));
      if (idx === lastIdx) return;
      lastIdx = idx;
      $$('.seg.current').forEach((el) => el.classList.remove('current'));
      const el = $(`.seg[data-i="${idx}"]`);
      if (el) {
        el.classList.add('current');
        const editing = document.activeElement?.closest?.('.seg');
        if ($('#follow').checked && !editing) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && (!t.duration || Math.abs(audio.duration - t.duration) > 2)) {
        t.duration = audio.duration;
        $('#durLabel').textContent = fmtShort(t.duration);
        persist();
      }
    });
    $('#rate').addEventListener('change', (e) => { audio.playbackRate = Number(e.target.value); });
    $('#back5').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); });
    $('#fwd5').addEventListener('click', () => { audio.currentTime += 5; });
  }
  const seekTo = (sec) => {
    if (!audio) return;
    audio.currentTime = sec;
    audio.play();
  };

  // ----- menus -----
  const closeMenus = (e) => $$('.menu.open').forEach((m) => { if (!m.contains(e.target)) m.classList.remove('open'); });
  document.addEventListener('click', closeMenus);
  cleanup.push(() => document.removeEventListener('click', closeMenus));
  $('#exportBtn').addEventListener('click', () => $('#exportMenu').classList.toggle('open'));
  $('#moreBtn').addEventListener('click', () => $('#moreMenu').classList.toggle('open'));
  $$('[data-exp]').forEach((b) => b.addEventListener('click', () => {
    $('#exportMenu').classList.remove('open');
    if (b.dataset.exp === 'audio' && !t.audioBlob) { toast('Esta transcrição não tem áudio salvo.'); return; }
    exportAs(t, b.dataset.exp);
  }));
  $('#copyBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toTXT(t)); toast('Texto copiado.'); } catch { toast('Não foi possível copiar.'); }
  });
  $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('Excluir esta transcrição e o áudio? Essa ação não pode ser desfeita.')) return;
    t.deleted = true;
    clearTimeout(saveTimer);
    await db.remove(t.id);
    location.hash = '#/';
  });
  $('#retryBtn').addEventListener('click', async () => {
    $('#moreMenu').classList.remove('open');
    if (!t.audioBlob) { toast('Não há áudio salvo para transcrever.'); return; }
    if (jobs.has(t.id)) { toast('A transcrição já está em andamento.'); return; }
    if (t.segments.length && !confirm('O texto atual, incluindo suas edições, será substituído. Continuar?')) return;
    t.status = 'processing';
    t.segments = [];
    await db.save(t);
    startJob(t.id);
    router();
  });
  $('#alternateBtn').addEventListener('click', () => {
    $('#moreMenu').classList.remove('open');
    const gap = Number(prompt('Trocar de falante quando houver uma pausa maior que quantos segundos?', '1.5'));
    if (!gap) return;
    if (!t.speakers.S2) t.speakers.S2 = 'Falante 2';
    let cur = 'S1';
    t.segments.forEach((s, i) => {
      if (i > 0 && s.start - t.segments[i - 1].end >= gap) cur = cur === 'S1' ? 'S2' : 'S1';
      s.speaker = cur;
    });
    persist();
    drawTranscript();
    toast('Falantes alternados. Revise e corrija onde for preciso.');
  });

  // ----- painel lateral -----
  let currentTab = 'resumo';
  const tabBody = $('#tabBody');
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    drawTab();
  }));
  tabBody.addEventListener('click', (e) => {
    const tl = e.target.closest('.time-link');
    if (tl) seekTo(parseTime(tl.dataset.time));
  });

  function drawTab() {
    if (currentTab === 'resumo') {
      const kw = t.segments.length ? keywords(t, 6) : [];
      tabBody.innerHTML = `
        ${t.summary?.text ? `<div class="summary-body">${mdToHTML(t.summary.text)}</div>
          <p class="muted small">Gerado ${t.summary.generatedBy === 'local' ? 'localmente' : 'pelo Claude'} em ${fmtDate(t.summary.at || Date.now())}</p>`
          : `<p class="muted">Gere um resumo com os tópicos principais, pontos de ação e palavras-chave.</p>
             ${kw.length ? `<div class="row" style="margin-bottom:12px">${kw.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : ''}`}
        <div class="row">
          <button class="btn primary sm" id="sumBtn" ${t.segments.length ? '' : 'disabled'}>${t.summary ? 'Gerar novamente' : 'Gerar resumo'}</button>
          ${t.summary ? '<button class="btn sm" id="copySum">Copiar</button>' : ''}
        </div>
        ${hasAI() ? '' : '<p class="muted small" style="margin-top:10px">Sem chave da API, o resumo é extrativo e feito no próprio navegador. <a href="#/config">Configurar IA</a></p>'}`;
      $('#sumBtn', tabBody)?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Gerando...';
        try {
          t.summary = { ...(await summarize(t)), at: Date.now() };
          await persist(true);
        } catch (err) {
          toast(err.message || 'Falha ao gerar o resumo.', 5000);
        }
        drawTab();
      });
      $('#copySum', tabBody)?.addEventListener('click', () => navigator.clipboard.writeText(t.summary.text).then(() => toast('Resumo copiado.')));
    } else if (currentTab === 'chat') {
      tabBody.innerHTML = hasAI() ? `
        <div class="chat" id="chat">${chatHistory.length ? chatHistory.map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : 'ai'}">${m.role === 'user' ? esc(m.content) : mdToHTML(m.content)}</div>`).join('') : '<p class="muted small">Pergunte qualquer coisa sobre o conteúdo, por exemplo "Quais foram os conceitos explicados?" ou "O que foi dito sobre a avaliação?".</p>'}</div>
        <form id="chatForm" class="row"><input type="text" id="chatInput" placeholder="Sua pergunta" required style="flex:1"><button class="btn primary sm">Enviar</button></form>
        ${chatHistory.length ? '<button class="btn ghost sm" id="clearChat" style="margin-top:8px">Limpar conversa</button>' : ''}`
        : '<p class="muted">Para fazer perguntas sobre a transcrição é preciso configurar uma chave da API da Anthropic.</p><a class="btn sm" href="#/config">Abrir Configurações</a>';
      const chat = $('#chat', tabBody);
      if (chat) chat.scrollTop = chat.scrollHeight;
      $('#clearChat', tabBody)?.addEventListener('click', () => { chatHistory.length = 0; t.chat = chatHistory; persist(); drawTab(); });
      $('#chatForm', tabBody)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = $('#chatInput', tabBody);
        const q = input.value.trim();
        if (!q) return;
        const prior = [...chatHistory];
        chatHistory.push({ role: 'user', content: q });
        drawTab();
        const thinking = document.createElement('div');
        thinking.className = 'bubble ai muted';
        thinking.textContent = 'Pensando...';
        $('#chat', tabBody).appendChild(thinking);
        try {
          const answer = await askQuestion(t, prior, q);
          chatHistory.push({ role: 'assistant', content: answer });
        } catch (err) {
          chatHistory.pop();
          toast(err.message || 'Falha ao consultar a IA.', 5000);
        }
        t.chat = chatHistory;
        persist();
        if (currentTab === 'chat') drawTab();
      });
    } else if (currentTab === 'falantes') {
      const counts = {};
      t.segments.forEach((s) => { if (s.speaker) counts[s.speaker] = (counts[s.speaker] || 0) + (s.end - s.start); });
      tabBody.innerHTML = `
        <p class="muted small">Renomeie os falantes e escolha quem fala em cada trecho pelo seletor ao lado do horário.</p>
        <div class="speakers-list">${Object.entries(t.speakers).map(([k, v]) => `
          <div class="row"><span class="dot" style="background:${speakerColor(k)}"></span>
            <input type="text" data-sp="${k}" value="${esc(v)}">
            <span class="muted small" style="min-width:44px;text-align:right">${fmtShort(counts[k] || 0)}</span></div>`).join('')}
        </div>
        <button class="btn sm" id="addSp" style="margin-top:12px">Adicionar falante</button>`;
      $$('[data-sp]', tabBody).forEach((inp) => inp.addEventListener('change', () => {
        t.speakers[inp.dataset.sp] = inp.value.trim() || inp.dataset.sp;
        persist();
        drawTranscript();
      }));
      $('#addSp', tabBody).addEventListener('click', () => {
        const k = 'S' + (Math.max(0, ...Object.keys(t.speakers).map((x) => Number(x.slice(1)) || 0)) + 1);
        t.speakers[k] = `Falante ${k.slice(1)}`;
        persist();
        drawTab();
        drawTranscript();
      });
    } else if (currentTab === 'notas') {
      tabBody.innerHTML = `<textarea id="notes" rows="12" placeholder="Anotações pessoais sobre esta gravação">${esc(t.notes || '')}</textarea>
        <p class="muted small">Salvo automaticamente.</p>`;
      $('#notes', tabBody).addEventListener('input', (e) => { t.notes = e.target.value; persist(); });
    }
  }
  drawTab();
}

// ---------------- configurações ----------------
function renderSettings() {
  const s = getSettings();
  const gpu = 'gpu' in navigator;
  view.innerHTML = `
    <div class="page-head"><div><h1>Configurações</h1><p class="muted">Preferências guardadas apenas neste navegador.</p></div></div>
    <div class="stack" style="max-width:720px">
      <div class="card stack">
        <h2>Transcrição</h2>
        <label class="field">Idioma do áudio
          <select id="lang">${LANGUAGES.map(([v, l]) => `<option value="${v}" ${v === s.language ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <label class="field">Modelo de reconhecimento de fala
          <select id="model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
          <span class="hint" id="modelNote">${esc(MODELS.find((m) => m.id === s.model)?.note || '')}</span>
        </label>
        <label class="field">Tarefa
          <select id="task">
            <option value="transcribe" ${s.task === 'transcribe' ? 'selected' : ''}>Transcrever no idioma original</option>
            <option value="translate" ${s.task === 'translate' ? 'selected' : ''}>Traduzir para o inglês</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" id="gpu" ${s.useGPU ? 'checked' : ''}>
          <span>Usar a placa de vídeo (WebGPU) quando disponível <span class="muted small">${gpu ? '(seu navegador oferece suporte)' : '(não disponível neste navegador, será usado o processador)'}</span></span></label>
      </div>
      <div class="card stack">
        <h2>Inteligência artificial</h2>
        <p class="muted small" style="margin:0">Resumos, tópicos, pontos de ação e perguntas usam o Claude, da Anthropic. Crie uma chave em console.anthropic.com. A chave fica guardada só neste navegador e somente o texto da transcrição é enviado, nunca o áudio. Evite usar a chave em computadores compartilhados.</p>
        <label class="field">Chave da API da Anthropic
          <input type="password" id="apiKey" value="${esc(s.apiKey)}" placeholder="sk-ant-..." autocomplete="off">
        </label>
      </div>
      <div class="card stack">
        <h2>Aparência</h2>
        <label class="field">Tema
          <select id="theme">
            <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Seguir o sistema</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Claro</option>
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Escuro</option>
          </select>
        </label>
      </div>
      <div class="card stack">
        <h2>Dados</h2>
        <p class="muted small" style="margin:0">As transcrições e os áudios ficam no armazenamento do navegador. Limpar os dados do site apaga tudo, então exporte o que for importante.</p>
        <div class="row"><button class="btn danger" id="wipe">Apagar todas as transcrições</button></div>
      </div>
    </div>`;
  const bind = (id, key, fn = (v) => v) => $(id).addEventListener('change', (e) => {
    saveSettings({ [key]: fn(e.target.type === 'checkbox' ? e.target.checked : e.target.value) });
    toast('Preferência salva.');
  });
  bind('#lang', 'language');
  bind('#model', 'model');
  bind('#task', 'task');
  bind('#gpu', 'useGPU');
  bind('#apiKey', 'apiKey', (v) => v.trim());
  bind('#theme', 'theme');
  $('#model').addEventListener('change', (e) => { $('#modelNote').textContent = MODELS.find((m) => m.id === e.target.value)?.note || ''; });
  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Apagar todas as transcrições e áudios deste navegador?')) return;
    for (const item of await db.listAll()) await db.remove(item.id);
    toast('Tudo apagado.');
  });
}

router();

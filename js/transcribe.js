// Ponte entre a interface e o worker do Whisper.
import { getSettings } from './settings.js';

let worker = null;

function getWorker() {
  if (!worker) worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

// Converte qualquer áudio ou vídeo que o navegador saiba ler em PCM mono 16 kHz.
export async function decodeTo16kMono(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new Ctx({ sampleRate: 16000 });
  } catch {
    ctx = new Ctx();
  }
  const decoded = await ctx.decodeAudioData(buf);
  ctx.close?.();
  let mono;
  if (decoded.numberOfChannels === 1) {
    mono = decoded.getChannelData(0).slice();
  } else {
    const a = decoded.getChannelData(0);
    const b = decoded.getChannelData(1);
    mono = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) mono[i] = (a[i] + b[i]) / 2;
  }
  if (decoded.sampleRate !== 16000) mono = resample(mono, decoded.sampleRate, 16000);
  return { audio: mono, duration: decoded.duration };
}

function resample(data, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, data.length - 1);
    const t = pos - i0;
    out[i] = data[i0] * (1 - t) + data[i1] * t;
  }
  return out;
}

/**
 * Transcreve um Blob de áudio/vídeo.
 * callbacks: onStatus(texto), onLoad(progressoDownload), onPartial({segments, progress})
 */
export async function transcribeBlob(blob, callbacks = {}) {
  const settings = getSettings();
  callbacks.onStatus?.('Lendo o arquivo de áudio...');
  const { audio, duration } = await decodeTo16kMono(blob);
  const w = getWorker();

  return new Promise((resolve, reject) => {
    const files = {};
    w.onmessage = (e) => {
      const { type, data } = e.data;
      if (type === 'status') callbacks.onStatus?.(data);
      else if (type === 'load-progress') {
        if (data.status === 'progress' && data.file) {
          files[data.file] = { loaded: data.loaded || 0, total: data.total || 0 };
          const vals = Object.values(files);
          const loaded = vals.reduce((s, f) => s + f.loaded, 0);
          const total = vals.reduce((s, f) => s + f.total, 0);
          callbacks.onLoad?.({ loaded, total, pct: total ? loaded / total : 0 });
        }
      } else if (type === 'partial') callbacks.onPartial?.(data);
      else if (type === 'done') resolve({ segments: data.segments, duration });
      else if (type === 'error') reject(new Error(data));
    };
    w.onerror = (err) => reject(new Error(err.message || 'Falha no worker de transcrição'));
    w.postMessage({
      type: 'transcribe',
      audio,
      model: settings.model,
      language: settings.language,
      task: settings.task,
      preferGPU: settings.useGPU,
    }, [audio.buffer]);
  });
}

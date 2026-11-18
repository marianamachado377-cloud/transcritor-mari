// Web Worker que roda o modelo Whisper (OpenAI) localmente no navegador
// através da biblioteca Transformers.js. O áudio nunca sai do computador.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

env.allowLocalModels = false;

const SAMPLE_RATE = 16000;
const WINDOW_SECONDS = 120; // processa em blocos de 2 min para mostrar progresso parcial

let asr = null;
let loadedKey = '';

async function hasWebGPU() {
  try {
    if (!('gpu' in navigator)) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

async function load(model, preferGPU) {
  const device = preferGPU && (await hasWebGPU()) ? 'webgpu' : 'wasm';
  const key = model + '|' + device;
  if (asr && loadedKey === key) return device;
  const progress_callback = (p) => self.postMessage({ type: 'load-progress', data: p });
  const opts = device === 'webgpu'
    ? { device, dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
    : { device, dtype: 'q8', progress_callback };
  try {
    asr = await pipeline('automatic-speech-recognition', model, opts);
    loadedKey = key;
    return device;
  } catch (err) {
    if (device === 'webgpu') {
      // Se a GPU falhar, tenta novamente pela CPU.
      asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
      loadedKey = model + '|wasm';
      return 'wasm';
    }
    throw err;
  }
}

self.onmessage = async (event) => {
  const { type, audio, model, language, task, preferGPU } = event.data;
  if (type !== 'transcribe') return;
  try {
    self.postMessage({ type: 'status', data: 'Carregando o modelo de reconhecimento de fala...' });
    const device = await load(model, preferGPU);
    self.postMessage({ type: 'status', data: `Modelo pronto (${device === 'webgpu' ? 'placa de vídeo' : 'processador'}). Transcrevendo...` });

    const total = audio.length / SAMPLE_RATE;
    const windowSamples = WINDOW_SECONDS * SAMPLE_RATE;
    const segments = [];

    for (let startSample = 0; startSample < audio.length; startSample += windowSamples) {
      const piece = audio.subarray(startSample, Math.min(audio.length, startSample + windowSamples));
      const offset = startSample / SAMPLE_RATE;
      const pieceDuration = piece.length / SAMPLE_RATE;
      if (pieceDuration < 0.3) break;

      const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true, task: task || 'transcribe' };
      if (language && language !== 'auto') opts.language = language;

      const out = await asr(piece, opts);
      const chunks = out.chunks && out.chunks.length ? out.chunks : [{ timestamp: [0, pieceDuration], text: out.text }];
      const fresh = [];
      for (const c of chunks) {
        const text = (c.text || '').trim();
        if (!text) continue;
        const s = (c.timestamp?.[0] ?? 0) + offset;
        const eRaw = c.timestamp?.[1];
        const e = (eRaw == null ? pieceDuration : eRaw) + offset;
        fresh.push({ start: s, end: Math.max(e, s + 0.2), text });
      }
      segments.push(...fresh);
      const done = Math.min(1, (startSample + piece.length) / audio.length);
      self.postMessage({ type: 'partial', data: { segments: fresh, progress: done, processed: done * total, total } });
    }

    self.postMessage({ type: 'done', data: { segments } });
  } catch (err) {
    self.postMessage({ type: 'error', data: String(err?.message || err) });
  }
};

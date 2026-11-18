// Gravação do microfone ou do áudio de uma aba/reunião, com legenda ao vivo.

export function speechRecognitionAvailable() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function tabCaptureAvailable() {
  return !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * mode: 'mic' grava apenas o microfone; 'tab' mistura o áudio de uma aba
 * (Google Meet, Zoom web, Teams, YouTube...) com o microfone.
 */
export async function startRecording({ mode = 'mic', lang = 'pt-BR', live = true, onLive, onLevel } = {}) {
  const streams = [];
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  streams.push(mic);

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;

  const micSrc = ctx.createMediaStreamSource(mic);
  micSrc.connect(dest);
  micSrc.connect(analyser);

  if (mode === 'tab') {
    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      mic.getTracks().forEach((t) => t.stop());
      ctx.close();
      throw err;
    }
    streams.push(display);
    const audioTracks = display.getAudioTracks();
    if (!audioTracks.length) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      ctx.close();
      throw new Error('Nenhum áudio foi compartilhado. Ao escolher a aba, marque a opção "Compartilhar áudio da guia".');
    }
    const tabSrc = ctx.createMediaStreamSource(new MediaStream(audioTracks));
    tabSrc.connect(dest);
    tabSrc.connect(analyser);
  }

  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  const recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  const startedAt = performance.now();
  let pausedTotal = 0;
  let pausedAt = 0;
  const elapsed = () => ((pausedAt || performance.now()) - startedAt - pausedTotal) / 1000;

  // Nível de áudio para desenhar a onda
  const data = new Uint8Array(analyser.fftSize);
  let raf = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    onLevel?.(data);
    raf = requestAnimationFrame(tick);
  };
  tick();

  // Legenda ao vivo pelo reconhecimento de fala do navegador (usa o microfone)
  let recog = null;
  let stopped = false;
  const liveSegments = [];
  if (live && speechRecognitionAvailable()) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recog = new SR();
    recog.lang = lang;
    recog.continuous = true;
    recog.interimResults = true;
    const starts = {};
    let recogSession = 0;
    recog.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const key = i + ':' + recogSession;
        if (starts[key] == null) starts[key] = Math.max(0, elapsed() - 1.5);
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) liveSegments.push({ start: starts[key], end: elapsed(), text: capitalize(text) });
        } else {
          interim += r[0].transcript;
        }
      }
      onLive?.({ segments: liveSegments, interim });
    };
    recog.onend = () => {
      // O navegador encerra o reconhecimento após silêncios; reiniciamos.
      if (!stopped) { recogSession++; try { recog.start(); } catch { /* ignora */ } }
    };
    recog.onerror = () => { /* erros como "no-speech" são normais */ };
    try { recog.start(); } catch { recog = null; }
  }

  let paused = false;
  return {
    elapsed,
    get paused() { return paused; },
    pause() { if (recorder.state === 'recording') { recorder.pause(); paused = true; pausedAt = performance.now(); } },
    resume() {
      if (recorder.state === 'paused') {
        recorder.resume(); paused = false;
        pausedTotal += performance.now() - pausedAt; pausedAt = 0;
      }
    },
    async stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      try { recog?.stop(); } catch { /* ignora */ }
      const duration = elapsed();
      const blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        recorder.stop();
      });
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      ctx.close();
      return { blob, duration, liveSegments: [...liveSegments] };
    },
  };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

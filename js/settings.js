// Preferências do usuário guardadas no navegador.
const KEY = 'transcritor-mari:settings';

export const MODELS = [
  { id: 'onnx-community/whisper-tiny', label: 'Rápido (Whisper Tiny, ~40 MB)', note: 'Bom para testes e máquinas modestas.' },
  { id: 'onnx-community/whisper-base', label: 'Equilibrado (Whisper Base, ~80 MB)', note: 'Recomendado para a maioria dos usos.' },
  { id: 'onnx-community/whisper-small', label: 'Preciso (Whisper Small, ~250 MB)', note: 'Melhor qualidade em português, mais lento.' },
];

export const LANGUAGES = [
  ['portuguese', 'Português'], ['english', 'Inglês'], ['spanish', 'Espanhol'], ['french', 'Francês'],
  ['italian', 'Italiano'], ['german', 'Alemão'], ['japanese', 'Japonês'], ['chinese', 'Chinês'], ['auto', 'Detectar automaticamente'],
];

export const SPEECH_LANG = { portuguese: 'pt-BR', english: 'en-US', spanish: 'es-ES', french: 'fr-FR', italian: 'it-IT', german: 'de-DE', japanese: 'ja-JP', chinese: 'zh-CN', auto: 'pt-BR' };

const DEFAULTS = {
  model: 'onnx-community/whisper-base',
  language: 'portuguese',
  task: 'transcribe',
  useGPU: true,
  apiKey: '',
  theme: 'auto',
};

export function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* armazenamento indisponível */ }
  applyTheme(next.theme);
  return next;
}

export function applyTheme(theme = getSettings().theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

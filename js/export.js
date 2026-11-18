// Exportação em TXT, SRT, VTT, Markdown, Word (.doc) e JSON.

export function fmtTime(sec, withMs = false, sep = ',') {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return withMs ? `${base}${sep}${String(ms).padStart(3, '0')}` : base;
}

export function fmtShort(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

const speakerName = (t, seg) => (seg.speaker && t.speakers?.[seg.speaker]) || '';

export function toTXT(t, { timestamps = true, speakers = true } = {}) {
  const lines = [t.title, ''];
  for (const seg of t.segments) {
    const parts = [];
    if (timestamps) parts.push(`[${fmtTime(seg.start)}]`);
    const sp = speakers ? speakerName(t, seg) : '';
    if (sp) parts.push(`${sp}:`);
    parts.push(seg.text);
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

export function toSRT(t) {
  return t.segments.map((seg, i) => {
    const sp = speakerName(t, seg);
    return `${i + 1}\n${fmtTime(seg.start, true)} --> ${fmtTime(seg.end, true)}\n${sp ? sp + ': ' : ''}${seg.text}\n`;
  }).join('\n');
}

export function toVTT(t) {
  return 'WEBVTT\n\n' + t.segments.map((seg) => {
    const sp = speakerName(t, seg);
    return `${fmtTime(seg.start, true, '.')} --> ${fmtTime(seg.end, true, '.')}\n${sp ? `<v ${sp}>` : ''}${seg.text}\n`;
  }).join('\n');
}

export function toMarkdown(t) {
  let md = `# ${t.title}\n\n_${new Date(t.createdAt).toLocaleString('pt-BR')} · ${fmtShort(t.duration)}_\n\n`;
  if (t.summary?.text) md += `## Resumo\n\n${t.summary.text}\n\n`;
  md += '## Transcrição\n\n';
  for (const seg of t.segments) {
    const sp = speakerName(t, seg);
    md += `**[${fmtShort(seg.start)}]${sp ? ' ' + sp : ''}** ${seg.text}\n\n`;
  }
  return md;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function toWordHTML(t) {
  const rows = t.segments.map((seg) => {
    const sp = speakerName(t, seg);
    return `<p><span style="color:#116466;font-weight:bold">[${fmtShort(seg.start)}]${sp ? ' ' + escapeHTML(sp) : ''}</span> ${escapeHTML(seg.text)}</p>`;
  }).join('\n');
  const summary = t.summary?.text
    ? `<h2>Resumo</h2>${t.summary.text.split('\n').filter(Boolean).map((l) => `<p>${escapeHTML(l)}</p>`).join('')}`
    : '';
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${escapeHTML(t.title)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt;line-height:1.5} h1{font-size:18pt} h2{font-size:14pt}</style></head>
<body><h1>${escapeHTML(t.title)}</h1><p><i>${new Date(t.createdAt).toLocaleString('pt-BR')} · duração ${fmtShort(t.duration)}</i></p>
${summary}<h2>Transcrição</h2>${rows}</body></html>`;
}

export function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeName(title) {
  return (title || 'transcricao').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'transcricao';
}

export function exportAs(t, kind) {
  const name = safeName(t.title);
  switch (kind) {
    case 'txt': return download(`${name}.txt`, toTXT(t), 'text/plain;charset=utf-8');
    case 'txt-plain': return download(`${name}.txt`, toTXT(t, { timestamps: false, speakers: false }), 'text/plain;charset=utf-8');
    case 'srt': return download(`${name}.srt`, toSRT(t), 'application/x-subrip;charset=utf-8');
    case 'vtt': return download(`${name}.vtt`, toVTT(t), 'text/vtt;charset=utf-8');
    case 'md': return download(`${name}.md`, toMarkdown(t), 'text/markdown;charset=utf-8');
    case 'doc': return download(`${name}.doc`, '﻿' + toWordHTML(t), 'application/msword');
    case 'json': {
      const { audioBlob, ...rest } = t;
      return download(`${name}.json`, JSON.stringify(rest, null, 2), 'application/json');
    }
    case 'audio':
      if (t.audioBlob) {
        const ext = (t.audioBlob.type.split('/')[1] || 'webm').split(';')[0];
        return download(`${name}.${ext}`, t.audioBlob);
      }
      return undefined;
    case 'pdf': return window.print();
    default: return undefined;
  }
}

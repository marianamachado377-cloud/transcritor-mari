# Transcritor Mari

Aplicativo web de transcrição de áudio e vídeo que funciona inteiramente no navegador. Ele reúne os mecanismos típicos de ferramentas comerciais de transcrição, como gravação de aulas e reuniões, envio de arquivos, texto com marcação de tempo sincronizado ao áudio, identificação de falantes, busca, resumo por inteligência artificial e exportação em vários formatos.

## Funcionalidades

- **Envio de arquivos** de áudio ou vídeo (MP3, WAV, M4A, OGG, WEBM, MP4 e outros), inclusive vários de uma vez, com fila de processamento.
- **Gravação pelo microfone** com legenda ao vivo (Web Speech API, disponível no Chrome e no Edge).
- **Gravação de reuniões online** capturando o som de uma aba do navegador (Google Meet, Teams, Zoom web) junto com o microfone.
- **Transcrição local com Whisper** por meio do Transformers.js. O áudio não sai do computador e o modelo, depois de baixado, fica em cache. Usa a placa de vídeo (WebGPU) quando disponível.
- **Editor sincronizado** em que clicar no horário leva ao ponto do áudio, o trecho atual fica destacado durante a reprodução, o texto é editável, Enter divide um trecho e Backspace no início junta com o anterior.
- **Falantes** renomeáveis, com cores, tempo de fala de cada um e alternância automática por pausas.
- **Busca** dentro de uma transcrição e em toda a biblioteca.
- **Resumo, tópicos, pontos de ação e perguntas** sobre o conteúdo com o Claude (requer chave da API da Anthropic) ou resumo extrativo local sem chave.
- **Exportação** em Word, PDF, TXT, Markdown, SRT, WebVTT, JSON e áudio original.
- **Tema claro e escuro**, layout adaptado para celular.

## Como usar

O site é estático e não precisa de servidor próprio. Para rodar localmente basta servir a pasta, por exemplo com

```bash
python3 -m http.server 8000
```

e abrir `http://localhost:8000` no Chrome ou no Edge. Abrir o `index.html` direto do disco não funciona porque o navegador bloqueia módulos e workers em `file://`.

Para publicar gratuitamente, ative o GitHub Pages em *Settings → Pages* escolhendo esta branch e a pasta raiz.

## Limitações conhecidas

- A separação automática de falantes (diarização) não está disponível no navegador. Os falantes são atribuídos manualmente ou alternados por pausas.
- A legenda ao vivo depende do serviço de reconhecimento de fala do próprio navegador e capta somente o microfone. Para reuniões, a transcrição completa com Whisper ao final inclui todas as vozes.
- Arquivos muito longos (acima de cerca de duas horas) podem consumir bastante memória durante a decodificação.
- A chave da API fica no armazenamento local do navegador e as chamadas ao Claude são feitas diretamente do navegador, por isso não use a chave em computadores compartilhados.

## Estrutura

```
index.html            página única
css/style.css         estilos (tema claro/escuro, responsivo)
js/app.js             interface, rotas e editor
js/db.js              armazenamento em IndexedDB
js/recorder.js        gravação do microfone/aba e legenda ao vivo
js/transcribe.js      decodificação do áudio e comunicação com o worker
js/whisper-worker.js  modelo Whisper rodando em Web Worker
js/ai.js              resumo e perguntas com o Claude e resumo local
js/export.js          exportação nos formatos suportados
js/settings.js        preferências do usuário
```

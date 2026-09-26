---
impacto: capacidade_nova
secao: adicionado
titulo: A transcrição de áudio aceita idioma declarado e modelo melhor sem copiar a chave
---

Quem atende em espanhol ou português pode declarar o idioma dos áudios em
`TRANSCRIPTION_LANGUAGES` (por exemplo `es`) e trocar o modelo em
`TRANSCRIPTION_MODEL` (por exemplo `gpt-transcribe`) usando a mesma chave da
OpenAI já cadastrada na organização — antes, trocar o modelo exigia copiar a
chave para o `.env`. O motivo é medido: com o padrão, um áudio sem fala virava
"Thanks for watching!" e "ya es caro" virava "ya es claro", e o assistente
respondia ao que leu; com o idioma declarado e `gpt-transcribe`, os dois saem
certos e o áudio sem fala sai vazio. A tela de Provedores passa a mostrar o
modelo de transcrição que está em uso. Sem essas variáveis, nada muda. Sem a
chave própria, `TRANSCRIPTION_MODEL` só vale com `TRANSCRIPTION_BASE_URL` vazio:
quem já tinha o modelo de outro serviço (Groq, por exemplo) no `.env` segue com
`whisper-1` na OpenAI, como antes.

Contribuição de @jmpo (#1723).

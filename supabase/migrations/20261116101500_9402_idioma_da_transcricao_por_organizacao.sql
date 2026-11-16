-- manifest: **O ponto de transcrição passa a ter idioma da própria organização.** `ai_purpose_bindings.languages text[]` guarda os idiomas esperados no áudio quando a organização escolhe o serviço compatível com OpenAI do ponto `transcricao_de_audio` (#4713). Antes, o idioma vinha só de `TRANSCRIPTION_LANGUAGES` (`.env` da instalação) e valia para todas as organizações; uma instalação com `pt` fixo obrigava a organização que recebe áudio em espanhol a transcrever em português. Nulo/vazio = o serviço detecta sozinho, o comportamento de sempre. Aditiva e idempotente (`add column if not exists`); espelho no `create table` do `baseline.sql`; nada reescrito.

-- IDIOMA DA TRANSCRIÇÃO POR ORGANIZAÇÃO (#4713)
--
-- A coluna é lida por quem monta o degrau 0b da escada
-- (`lib/messaging/media/escada-de-transcricao.ts` + `workers/media-derive-worker.ts`)
-- e escrita pelo ponto em `app/api/v1/ai/providers/route.ts`.
--
-- Por que na LINHA do ponto e não no `settings` da organização: o idioma é da
-- ESCUTA daquele ponto, não da empresa. Um dia o mesmo endereço pode servir
-- visão; a configuração que muda o que vai no corpo de
-- `/v1/audio/transcriptions` mora junto do binding que a escolheu.
--
-- Vazio/NULO é a resposta mais frouxa, como em todo este schema: o serviço
-- detecta o idioma sozinho. Nada de default 'pt' — seria trocar um global por
-- outro.

alter table public.ai_purpose_bindings
  add column if not exists languages text[];

comment on column public.ai_purpose_bindings.languages is
  'Idiomas esperados no áudio (ISO-639-1) quando a organização escolhe o serviço compatível com OpenAI deste ponto. Nulo/vazio = detecção automática do serviço. Entra em /v1/audio/transcriptions como language (ou languages[] nos modelos gpt-transcribe).';

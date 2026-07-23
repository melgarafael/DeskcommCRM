-- 0058: derivado textual de mídia (Onda 3 multimodal) + flags por-agente.
-- media_derived_text: transcrição/OCR/visão — camada universal que qualquer
-- modelo lê. multimodal_input: liga a parte nativa (capability-gated) por agente.
alter table messages
  add column if not exists media_derived_text text,
  add column if not exists media_derived_status text;

alter table ai_agent_versions
  add column if not exists multimodal_input boolean not null default true,
  add column if not exists video_frames_enabled boolean not null default false;

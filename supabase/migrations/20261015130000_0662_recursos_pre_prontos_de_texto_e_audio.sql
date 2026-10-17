-- manifest: Recursos pré-prontos (#2833): o modelo de script ganha TIPO — o de TEXTO cai no campo editável do Inbox e o de ÁUDIO vira anexo pendente. Acrescenta tipo/mídia a message_templates e o bucket recursos-media; sem tocar RLS, políticas ou linhas.
alter table message_templates
  add column if not exists tipo text not null default 'texto',
  add column if not exists media_path text,
  add column if not exists media_mime text,
  add column if not exists media_size_bytes bigint;

-- Vocabulário do tipo: espelhado por lib/inbox/recursos.ts → TIPOS_DE_RECURSO
-- e coberto por tests/invariants/vocabulario-banco-x-typescript.test.ts.
alter table message_templates drop constraint if exists message_templates_tipo_check;
alter table message_templates add constraint message_templates_tipo_check
  check (tipo = any (array['texto'::text, 'audio'::text]));

-- Áudio sem arquivo é recurso que não entrega nada: barra na origem.
alter table message_templates drop constraint if exists message_templates_audio_precisa_de_midia;
alter table message_templates add constraint message_templates_audio_precisa_de_midia
  check (tipo <> 'audio' or media_path is not null);

-- Bucket dos arquivos de áudio dos recursos. Privado, mesmo teto do whatsapp-media.
insert into storage.buckets (id, name, public, file_size_limit)
values ('recursos-media', 'recursos-media', false, 52428800)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

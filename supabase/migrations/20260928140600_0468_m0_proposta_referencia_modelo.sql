-- 0468 — Onda M0: a proposta pode referenciar o modelo usado.
-- Nullable e aditiva: proposta sem modelo (todo o histórico de hoje) convive
-- sem migração de dado nenhuma. `template_snapshot`/`rendered_snapshot`
-- ficam vazios até a Onda M5 (envio) — a Onda M0 só abre o lugar; quem
-- escreve neles é o fluxo de envio, que ainda não existe para modelos.
--
-- CHECK de consistência: os dois campos de "qual modelo" nascem e morrem
-- juntos — proposta não referencia versão sem slug, nem slug sem versão.
alter table public.crm_proposals add column if not exists template_slug text;
alter table public.crm_proposals add column if not exists template_version int;
alter table public.crm_proposals add column if not exists template_snapshot jsonb;
alter table public.crm_proposals add column if not exists rendered_snapshot jsonb;

alter table public.crm_proposals drop constraint if exists crm_proposals_template_slug_versao_juntos_check;
alter table public.crm_proposals add constraint crm_proposals_template_slug_versao_juntos_check
  check ((template_slug is null) = (template_version is null));

notify pgrst, 'reload schema';

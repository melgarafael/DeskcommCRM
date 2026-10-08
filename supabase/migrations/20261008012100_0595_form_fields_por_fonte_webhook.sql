-- manifest: campos de formulário configuráveis por fonte de webhook
alter table public.webhook_sources
  add column if not exists form_fields jsonb not null default '[]'::jsonb;

comment on column public.webhook_sources.form_fields is
  'Definições dos campos adicionais que o formulário HTML gerado por esta fonte exibe; valores submetidos continuam em crm_leads.custom_fields e webhook_lead_captures.fields.';

notify pgrst, 'reload schema';

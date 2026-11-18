-- manifest: O lembrete da agenda sai por modelo aprovado quando a janela de 24 h do cliente fechou (`calendar_event_types.reminder_meta_template_id`, FK composta com a organização).
--
-- 9092 — `calendar_event_types.reminder_meta_template_id`
--
-- O lembrete da agenda sai como texto livre. Num número que só aceita texto livre
-- de quem escreveu nas últimas 24 h (o oficial, direto ou por parceiro), a reserva
-- feita dias antes cai fora da janela e o cron pula o lembrete (#2595): o cliente
-- não é avisado. Com o modelo aprovado do número no tipo, o lembrete sai por ele.
-- As variáveis do corpo, por posição: primeiro nome, dia e hora, título, endereço
-- (`lib/agenda/lembrete-por-modelo.ts`).
--
-- A FK é composta com `organization_id`, como a do remetente
-- (`calendar_event_types_reminder_channel_org_fkey`, 0625): o banco recusa um
-- modelo de OUTRA organização, em vez de confiar só no código. Para isso
-- `meta_templates` ganha a chave (organization_id, id) — o `id` já é único, então
-- ela não recusa linha nenhuma de quem já tem dados.
--
-- `on delete set null (reminder_meta_template_id)`: apagar o modelo volta o tipo
-- ao comportamento de antes (sem lembrete fora da janela, com aviso à equipe) e
-- nunca apaga a organização da linha. Que o modelo é do MESMO número e está
-- aprovado é conferido pelo cron, na leitura.
--
-- Coluna nullable, sem default e sem backfill. Idempotente.

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'meta_templates_organization_id_id_key'
      and conrelid = 'public.meta_templates'::regclass
  ) then
    alter table public.meta_templates
      add constraint meta_templates_organization_id_id_key unique (organization_id, id);
  end if;
end $$;

alter table public.calendar_event_types
  add column if not exists reminder_meta_template_id uuid;

do $$ begin
  alter table public.calendar_event_types
    drop constraint if exists calendar_event_types_reminder_template_org_fkey;
  alter table public.calendar_event_types add constraint calendar_event_types_reminder_template_org_fkey
    foreign key (organization_id, reminder_meta_template_id)
    references public.meta_templates(organization_id, id)
    on delete set null (reminder_meta_template_id) deferrable initially deferred;
end $$;

comment on column public.calendar_event_types.reminder_meta_template_id is
  'Modelo aprovado do número para o lembrete quando a janela de 24 h do cliente fechou (migration 9092). Variáveis do corpo, por posição: primeiro nome, dia e hora, título, endereço. Lido pelo cron agenda-reminder; gravado por /api/v1/agenda/tipos (manager+).';

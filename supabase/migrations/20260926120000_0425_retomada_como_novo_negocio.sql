-- 0425 — Retomada de negócio perdido guarda a cadeia de tentativas (issue #1538).
--
-- Num funil com `settings.reabertura = "novo_negocio"`, mover um lead encerrado
-- para uma etapa aberta NÃO o reabre: nasce um lead novo (`source = 'retomada'`)
-- e esta coluna aponta para o encerrado que ele tenta de vez nova. É por esta
-- coluna que "quantas tentativas até fechar" é derivado — a proposta pede coluna
-- com FK, porque derivar a cadeia por `source_metadata` seria uma leitura que
-- ninguém consegue indexar nem consultar por SQL.
--
-- Aditiva e idempotente. A coluna nasce `null` em toda linha existente (nenhuma
-- retomada aconteceu antes disto) e a FK é `ON DELETE SET NULL`: apagar um
-- negócio (anonimização LGPD, limpeza) solta o ponteiro da tentativa nova em vez
-- de recusar a exclusão ou propagar o apagamento — a retomada tem contato e
-- histórico próprios e não morre junto com a tentativa anterior.
--
-- Sem função nova, sem policy nova: `crm_leads` já tem as policies dela e a
-- coluna é lida e escrita pelo mesmo escopo de sempre.

alter table public.crm_leads
  add column if not exists retomado_de_lead_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fk_crm_leads_retomado_de_lead'
      and conrelid = 'public.crm_leads'::regclass
  ) then
    alter table public.crm_leads
      add constraint fk_crm_leads_retomado_de_lead
      foreign key (retomado_de_lead_id)
      references public.crm_leads(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_crm_leads_retomado_de_lead
  on public.crm_leads (retomado_de_lead_id)
  where retomado_de_lead_id is not null;

-- 0211 — campos personalizados no CONTATO, e a anonimização que os alcança.
--
-- O contato já tinha `tags` e `source_metadata`, mas nada onde o operador
-- guardasse o que o NICHO dele pede — matrícula, convênio, número do processo.
-- A definição continua declarativa em `crm_pipelines.settings.fields[]`, a mesma
-- fonte que `crm_leads.custom_fields` já usa; o que entra aqui é só o VALOR.
--
-- ── A segunda metade não é opcional ───────────────────────────────────────────
--
-- Campo livre num registro de pessoa física recebe CPF. Não é hipótese: é o
-- primeiro uso que um operador de clínica ou de escritório dá a um campo
-- chamado "documento". Uma coluna de PII que a anonimização não alcança faz o
-- sistema responder "anonimizado" a um pedido do titular com o CPF dele intacto
-- no banco — e o SLA de D+15 marcado como cumprido.
--
-- ── Por que TRIGGER NO ESTADO, e não uma linha no cascade ─────────────────────
--
-- A escolha é a mesma que o bloco `trg_contacts_anonimizado_limpa_propostas`
-- já registrou neste baseline, e vale pelo mesmo motivo: há MAIS DE UM caminho
-- que anonimiza um contato.
--
--   fn_lgpd_cascade_redact_contact       o cascade completo
--   app/api/v1/lgpd/anonymize/route.ts:104   a rota direta, que faz um UPDATE
--                                            próprio e nem sequer limpa
--                                            `consent`/`tags`/`source_metadata`
--
-- Acrescentar a linha só ao cascade deixaria a rota direta vazando. Pendurar no
-- FATO (`is_anonymized` virou true) cobre os dois, e cobre o DBA que amanhã
-- fizer à mão. É também a diferença entre editar uma função de 180 linhas vinda
-- de dump e acrescentar dez.
--
-- BEFORE, e não AFTER: o alvo é uma coluna da PRÓPRIA linha. Em `after` seria
-- preciso um segundo UPDATE, com o risco de recursão que ele traz.

alter table public.contacts
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

comment on column public.contacts.custom_fields is
  'Valores de campos personalizados do contato. As definições são declaradas em crm_pipelines.settings.fields[]. Limpo pela anonimização (trg_contacts_anonimizado_limpa_custom_fields).';

-- Dados ANTES da constraint: em banco de clone a coluna pode ter chegado por
-- outro caminho com valor não-objeto, e o `update.sh` roda SEM `ON_ERROR_STOP` —
-- um 23514 aqui seria engolido e a constraint ficaria fora, em silêncio.
update public.contacts
   set custom_fields = '{}'::jsonb
 where custom_fields is null
    or jsonb_typeof(custom_fields) <> 'object';

alter table public.contacts
  drop constraint if exists contacts_custom_fields_object;

alter table public.contacts
  add constraint contacts_custom_fields_object
  check (jsonb_typeof(custom_fields) = 'object');

create or replace function public.fn_contato_anonimizado_limpa_campos_personalizados()
  returns trigger
  language plpgsql
as $$
begin
  -- Anonimização é irreversível (L-04): não há o que preservar aqui.
  new.custom_fields := '{}'::jsonb;
  return new;
end$$;

-- As DUAS origens de EXECUTE (item 9 do CLAUDE.md). Função de gatilho não é
-- alcançável pela REST, mas o `ALTER DEFAULT PRIVILEGES ... TO anon` do corpo
-- deste arquivo vale para toda função criada depois dele, e `revoke from public`
-- não remove um grant nominal a `anon`.
revoke all on function public.fn_contato_anonimizado_limpa_campos_personalizados() from public;
revoke execute on function public.fn_contato_anonimizado_limpa_campos_personalizados() from anon;
revoke execute on function public.fn_contato_anonimizado_limpa_campos_personalizados() from authenticated;

drop trigger if exists trg_contacts_anonimizado_limpa_custom_fields on public.contacts;
create trigger trg_contacts_anonimizado_limpa_custom_fields
  before update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_contato_anonimizado_limpa_campos_personalizados();

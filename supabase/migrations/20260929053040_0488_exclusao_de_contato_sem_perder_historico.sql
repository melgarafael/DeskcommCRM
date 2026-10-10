-- 0488 — Excluir um contato que já passou por retorno automático apaga a ficha INTEIRA (issue #1862)
--
-- ── O sintoma, medido ─────────────────────────────────────────────────────────
-- `DELETE /api/v1/contacts/:id` de um contato com turno de follow-up em
-- `job_queue` (`kind='followup_turn'`) respondia ERRO com `42501`, e a auditoria
-- `contact.delete_blocked` saía com `apagados: ["messages","conversations"]`:
-- o histórico já tinha sido apagado quando a ficha foi recusada. Ficava contato
-- na base, sem histórico. Medido na v1.59.0 e na `main` de 2026-09-28 (#1862).
--
-- ── As DUAS causas, e o que cada uma vira aqui ────────────────────────────────
-- 1. `fn_followup_generation_write` (gatilho BEFORE em `job_queue` e
--    `followup_enrollment_events`) recusa com `42501` (`followup_job_internal` /
--    `followup_step_internal`) qualquer escrita de quem tem `auth.uid()` —
--    inclusive o `DELETE` que chega EM CASCATA quando a ficha é apagada: as duas
--    tabelas apontam para `contacts` com `on delete cascade`, então o banco
--    apaga-as por dentro do gatilho da chave estrangeira. Como superusuário (sem
--    `auth.uid()`) o mesmo `DELETE from contacts` passava; pela API, com a sessão
--    do usuário, não.
--    Conserto: `if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;`
--    como PRIMEIRA instrução do corpo. A cascata roda DENTRO do gatilho da FK
--    (profundidade > 1) e passa; o `DELETE` DIRETO roda na profundidade 1 e
--    CONTINUA recusado com a MESMA 42501 — a recusa não afrouxa, libera-se só a
--    cascata.
--    Escopo real da guarda: passa QUALQUER cascata de chave estrangeira, não só
--    a da ficha. Apagar uma inscrição (`followup_enrollments`), um fluxo
--    (`followup_flow_pointers`) ou a organização também leva os eventos internos
--    junto (antes: `followup_step_internal`). O turno que sobra em `job_queue`
--    sem inscrição/evento de origem falha fechado em `fn_followup_job_current`.
--    A profundidade também não distingue cascata de DELETE feito por outro
--    gatilho: hoje nenhum gatilho do baseline apaga em `job_queue` ou em
--    `followup_enrollment_events` (medido na triagem do #1912); gatilho novo que
--    apague ali herda a passagem.
-- 2. `deleteContactHandler` (`app/api/v1/contacts/_handler.ts`) apagava
--    `messages`, depois `conversations`, depois `contacts` em TRÊS chamadas
--    separadas. Quando a última falhava, as duas primeiras já estavam gravadas —
--    era a perda de histórico da auditoria acima.
--    Conserto: `fn_apagar_contato_com_historico`, função `security invoker` que
--    apaga as três numa transação só, chamada pela rota no lugar dos três
--    DELETE. Vale a RLS de quem chama, e o filtro de `organization_id` é do
--    próprio banco (argumento + WHERE), não do chamador — nenhuma linha de
--    organização alheia é alcançável por ela.
--
-- ── Por que a ordem interna importa ───────────────────────────────────────────
-- `conversations.contact_id` e `messages.contact_id` são `on delete restrict`
-- (a régua da #752): as duas saem ANTES da ficha, como já saíam na rota — só que
-- agora na mesma transação. Compromisso de agenda (`calendar_appointments`, o
-- outro RESTRICT) recusa a ficha com `23503` e a transação inteira desfaz:
-- mensagens e conversas continuam lá.
--
-- ── Reaplicável (a tripla da casa) ────────────────────────────────────────────
-- `create or replace` nas DUAS funções. No `supabase/baseline.sql` o corpo entra
-- nos DOIS lugares certos: o bloco da 0224 (`-- ---- Presença e recuperação
-- (migration 0224) ----`) é EDITADO NO LUGAR com a mesma guarda, e a função nova
-- vai no apêndice ANTES do bloco da `VARREDURA anon` (0116) — depois dela,
-- `tests/unit/varredura-anon-e-o-ultimo-bloco.test.ts` reprova função criada.
--
-- Gates: `tests/invariants/contato-com-turno-de-followup-sai-inteiro.test.ts`
-- (ficha inteira, recusa direta e ficha com compromisso) e
-- `tests/unit/contato-delete.test.ts` (a rota chama UMA função).

create or replace function public.fn_followup_generation_write()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 -- #1862 — DELETE que chega em CASCATA não é escrita de follow-up. Este gatilho
 -- é BEFORE ROW: o DELETE vindo de `on delete cascade` roda sob o gatilho da
 -- chave estrangeira, com `pg_trigger_depth() > 1`. Passa QUALQUER cascata, não
 -- só a da ficha: apagar o contato, a inscrição (followup_enrollments), o fluxo
 -- (followup_flow_pointers) ou a organização leva junto os registros internos.
 -- O turno que sobra sem inscrição/evento falha fechado em
 -- fn_followup_job_current. A profundidade não distingue cascata de DELETE
 -- feito por outro gatilho: hoje nenhum gatilho apaga nestas duas tabelas, e
 -- quem criar um herda esta passagem. O DELETE DIRETO (profundidade 1, com
 -- `auth.uid()`) continua caindo na recusa abaixo — a 42501 não afrouxa.
 if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
 if tg_table_name='job_queue' then
  if auth.uid() is not null and ((tg_op<>'DELETE' and new.kind='followup_turn') or (tg_op<>'INSERT' and old.kind='followup_turn')) then
   raise exception 'followup_job_internal' using errcode='42501';
  end if;
  if tg_op='UPDATE' and old.kind='followup_turn' then
   if new.organization_id<>old.organization_id or new.contact_id is distinct from old.contact_id or new.kind<>old.kind
    or new.payload->'followup_enrollment_id' is distinct from old.payload->'followup_enrollment_id'
    or new.payload->'node_id' is distinct from old.payload->'node_id'
    or new.payload->'source_step_key' is distinct from old.payload->'source_step_key'
   then raise exception 'followup_job_origin_immutable' using errcode='42501'; end if;
  end if;
 elsif auth.uid() is not null and ((tg_op<>'DELETE' and new.idempotency_key ~ ':[0-9]+$') or (tg_op<>'INSERT' and old.idempotency_key ~ ':[0-9]+$')) then
  raise exception 'followup_step_internal' using errcode='42501';
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end; $$;

-- A ficha e o histórico numa transação só: ou sai tudo, ou não sai nada.
-- SECURITY INVOKER de propósito — a RLS de quem chama continua valendo (a mesma
-- que os três DELETE separados da rota respeitavam), e `p_organization_id` fecha
-- a linha por dentro. Nada de service role aqui: quem chama é a sessão do usuário.
create or replace function public.fn_apagar_contato_com_historico(
  p_contact_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path to 'public', 'pg_temp'
as $$
begin
  -- RESTRICT da #752: o histórico sai antes da ficha, na mesma transação.
  delete from public.messages
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.conversations
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.contacts
   where id = p_contact_id
     and organization_id = p_organization_id;

  -- `found` é do DELETE da ficha: false = a ficha não estava acessível para quem
  -- chamou (outra organização, RLS, corrida) — a rota devolve 404 nesse caso.
  return found;
end;
$$;

-- Função nova em `public` nasce exposta (ALTER DEFAULT PRIVILEGES do dump):
-- o revoke tira anon e o grant deixa só quem a rota usa.
revoke execute on function public.fn_apagar_contato_com_historico(uuid, uuid) from public, anon;
grant  execute on function public.fn_apagar_contato_com_historico(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

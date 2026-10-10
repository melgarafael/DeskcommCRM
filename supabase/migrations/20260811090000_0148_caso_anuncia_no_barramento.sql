-- 0148 — o caso passa a ANUNCIAR que abriu e que fechou.
--
-- ## O buraco
--
-- `agent_cases` é a entidade de escalação — o instante em que o sistema declara
-- "isto precisa de gente" — e não emitia NADA no barramento. Grep por
-- `emit_event` em `lib/agent-engine/`, `lib/escalacao/` e `app/api/v1/ai/cases/`
-- devolve zero linhas (controle positivo: a mesma sonda acha
-- `lib/leads/agent-stage-sync.ts:308`). Nenhum consumidor podia reagir a um caso.
--
-- ## Por que TRIGGER, e não um emissor em código (doutrina da 0138)
--
-- A ABERTURA tem um escritor hoje (`openCase`), mas o FECHAMENTO tem CINCO
-- (`provideCaseUpdate`, `resolveCaseFromHuman`, `markAwaitingLead`,
-- `escalateCase`, `encerrarChamadoPeloAgente`). Caçar emissor deixa a garantia
-- dependendo de alguém lembrar, e o próximo caminho nasce mudo. Aqui a garantia
-- é da TABELA: qualquer INSERT/UPDATE que chegue nela — motor, seed, script de
-- migração, rota futura — anuncia.
--
-- E isto NÃO viola o anti-pattern nº 9 do CLAUDE.md: a proibição é "trigger
-- NUNCA faz HTTP". Aqui é SQL puro, sem I/O externo, dentro da transação.
-- `fn_emit_conversation_routing` (0040) já usa este mesmo mecanismo.
--
-- ## Anti-eco (o trigger não pode alimentar a si mesmo)
--
-- O consumidor deste evento escreve em `followup_enrollments`, NUNCA em
-- `agent_cases` — não há caminho de volta. E o trigger de UPDATE é restrito a
-- `of status` mais `old.status is distinct from new.status`: mexer em
-- `updated_at`, `summary` ou `followup_attempts` não emite nada.
--
-- ## Por que o fechamento entra JUNTO, e não numa próxima migration
--
-- Medido no banco de referência: o caso existente fechou em **6 segundos**. Um
-- follow-up nascido de caso e nunca cancelado só morre por esgotamento ou por
-- resposta do contato — o cliente seria cobrado sobre um problema já resolvido.
-- É o invariante 7 do Sistema Vivo (todo laço se fecha) na forma mais literal.

create or replace function public.fn_emit_agent_case_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contact_id uuid;
  v_tipo text;
begin
  v_tipo := case when tg_op = 'INSERT' then 'ai.case_opened' else 'ai.case_closed' end;

  -- O contato viaja no PAYLOAD porque ele sempre existe por schema
  -- (`agent_cases.conversation_id` é not null e `conversations.contact_id` é
  -- not null) e porque poupa o consumidor de uma ida ao banco. O consumidor
  -- mantém o fallback de buscar, para não confiar em convenção.
  select c.contact_id into v_contact_id
    from public.conversations c
   where c.id = new.conversation_id;

  perform public.emit_event(
    v_tipo,
    'agent_case',
    new.id,
    jsonb_build_object(
      'case_id',         new.id,
      'conversation_id', new.conversation_id,
      'contact_id',      v_contact_id,
      'lead_id',         new.lead_id,
      'agent_id',        new.agent_id,
      'source',          new.source,
      'status',          new.status
    ),
    '{}'::jsonb,
    new.organization_id   -- SEMPRE de `new`, nunca de parâmetro: é o filtro de tenant
  );
  return null;            -- AFTER trigger: o retorno é ignorado
end;
$$;

alter function public.fn_emit_agent_case_event() owner to postgres;

-- ⚠️ AS DUAS ORIGENS DE EXECUTE (doutrina de migrations, item 9). Tratar só uma
-- deixa a função exposta com o gate verde: (A) o grant a PUBLIC que o Postgres
-- dá a qualquer função ao criá-la, que `revoke from anon` não remove; (B) o
-- `alter default privileges ... to anon` do baseline, que vale para toda função
-- criada depois dele e que `revoke from public` não remove.
revoke all     on function public.fn_emit_agent_case_event() from public;
revoke execute on function public.fn_emit_agent_case_event() from anon, authenticated;

-- ABERTURA: só os dois status que o código considera aberto
-- (`OPEN_STATUSES` em lib/agent-engine/agent/human-cases.ts:75).
drop trigger if exists trg_agent_case_opened on public.agent_cases;
create trigger trg_agent_case_opened
  after insert on public.agent_cases
  for each row
  when (new.status in ('awaiting_human','awaiting_lead'))
  execute function public.fn_emit_agent_case_event();

-- FECHAMENTO: os três status terminais. `escalated` entra porque o caso deixou
-- de esperar o cliente — seguir cobrando quem já foi passado adiante é o mesmo
-- defeito de cobrar quem já foi resolvido.
drop trigger if exists trg_agent_case_closed on public.agent_cases;
create trigger trg_agent_case_closed
  after update of status on public.agent_cases
  for each row
  when (old.status is distinct from new.status
        and new.status in ('resolved','escalated','cancelled'))
  execute function public.fn_emit_agent_case_event();

notify pgrst, 'reload schema';

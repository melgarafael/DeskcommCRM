-- ════════════════════════════════════════════════════════════════════════════
-- 0293 — A PASSAGEM SE RECONHECE SOZINHA
-- ════════════════════════════════════════════════════════════════════════════
--
-- ─── O defeito que esta migration fecha ────────────────────────────────────
--
-- A migration 0291 criou `passagens_de_atendimento` com `reconhecido_por` /
-- `reconhecido_em`, e NINGUÉM os escrevia. Sem um escritor, três coisas ficam
-- quebradas ao mesmo tempo:
--
--   1. o cartão da conversa nunca sai do estado "esperando alguém assumir",
--      mesmo depois de alguém ter assumido;
--   2. o aviso da Central fica ABERTO para sempre — e como o aviso deduplica
--      por episódio aberto, a PRÓXIMA passagem daquela conversa não abre aviso
--      nenhum. O cliente pede um atendente de novo e ninguém é avisado;
--   3. `fn_expurgar_passagens_vencidas` só apaga linha reconhecida (é o certo:
--      passagem aberta é demanda viva), então a tabela nunca é podada.
--
-- ─── Por que um TRIGGER, e não uma chamada em cinco rotas ──────────────────
--
-- Os cinco caminhos que trocam o dono de uma conversa — assumir, transferir,
-- liberar, devolver ao automático e o rodízio por canal — passam TODOS por
-- `public.fn_conversation_assign`, que insere a linha de auditoria em
-- `conversation_assignment_events` na MESMA transação. Um gatilho ali cobre os
-- cinco sem tocar em rota nenhuma, e cobre também o sexto caminho que alguém
-- escrever amanhã.
--
-- É SQL puro: **nenhum HTTP dentro de trigger** (anti-pattern nº 9). Ele faz dois
-- `update` locais e volta.
--
-- ─── A guarda de estado, e por que ela é a SEGUNDA camada ──────────────────
--
-- A migration 0279 já revogou `insert` direto em `conversation_assignment_events`
-- de `authenticated`: pela REST ninguém forja um evento de atribuição. Esta
-- guarda fecha a INSTÂNCIA também para quem escreve com a service key: o gatilho
-- só reconhece quando a conversa REALMENTE está com aquele dono. Sem ela, uma
-- linha de auditoria incoerente (inserida à mão, ou por um script de migração de
-- dados) marcaria como "assumida" uma passagem que ninguém assumiu — e o aviso
-- da Central sumiria da lista de quem precisa agir.
--
-- ─── Portabilidade ─────────────────────────────────────────────────────────
--
-- Idempotente e portável em `psql` puro: `create or replace function`,
-- `drop trigger if exists` + `create trigger`. Sem `BEGIN`/`COMMIT` (o runner já
-- envolve). Nenhuma tabela é criada, então não há travas de suporte a reaplicar.

-- ── O gatilho: alguém assumiu a conversa ────────────────────────────────────
create or replace function public.fn_passagem_reconhecida()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- `to_user_id is null` é release/devolução ao automático: ninguém assumiu.
  -- Quem fecha esse episódio é `fn_passagem_devolvida`, chamada pela rota de
  -- "devolver ao automático" — e ela grava `reconhecido_em` SEM
  -- `reconhecido_por`, que é como a tabela distingue os dois desfechos.
  if new.to_user_id is null then
    return new;
  end if;

  -- SEGUNDA CAMADA (ver o cabeçalho): só reconhece se a conversa está mesmo com
  -- aquele dono agora. `is not distinct from` e não `=` porque os dois lados
  -- podem ser nulos em outras rotas desta mesma tabela.
  if not exists (
    select 1 from public.conversations c
     where c.id = new.conversation_id
       and c.organization_id = new.organization_id
       and c.assigned_to_user_id is not distinct from new.to_user_id
  ) then
    return new;
  end if;

  update public.passagens_de_atendimento
     set reconhecido_por = new.to_user_id,
         reconhecido_em  = now()
   where organization_id = new.organization_id
     and conversation_id = new.conversation_id
     and reconhecido_em is null;

  -- O aviso da Central se resolve junto. `ref_kind='conversation'` é a chave que
  -- os dois motores passaram a usar (a mesma da dedup) — com `contact` o aviso
  -- de um contato com duas conversas abertas era um só.
  update public.agent_inbox_items
     set status = 'resolved',
         resolved_at = now()
   where organization_id = new.organization_id
     and kind = 'handoff'
     and ref_kind = 'conversation'
     and ref_id = new.conversation_id
     and status = 'open';

  return new;
end;
$$;

-- Função nova em `public` nasce EXPOSTA por DUAS origens (o grant implícito a
-- PUBLIC do Postgres e o `ALTER DEFAULT PRIVILEGES … TO anon` do baseline), e
-- revogar só uma deixa a função alcançável com o gate verde.
revoke all on function public.fn_passagem_reconhecida() from public, anon, authenticated;

drop trigger if exists trg_passagem_reconhecida on public.conversation_assignment_events;
create trigger trg_passagem_reconhecida
  after insert on public.conversation_assignment_events
  for each row execute function public.fn_passagem_reconhecida();

-- ── A devolução ao automático: o episódio fechou sem ninguém assumir ────────
--
-- `reconhecido_em` preenchido COM `reconhecido_por` nulo é o par que a 0291
-- documentou: "devolvida ao automático (ninguém assumiu, mas o episódio
-- fechou)". O CHECK `passagens_reconhecimento_coerente` permite exatamente esse
-- lado e proíbe o inverso.
--
-- **`security definer` e não o client de sessão**: a policy da tabela é `for
-- select` apenas, e `authenticated` não tem `update` — de propósito, para que
-- ninguém reescreva um fato. E não o client de serviço porque abrir admin numa
-- rota quando há molde de definer no repositório é privilégio a mais sem
-- necessidade. A autorização mora NO CORPO.
create or replace function public.fn_passagem_devolvida(
  p_organization_id uuid,
  p_conversation_id uuid
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fechadas integer;
begin
  -- Mesmo padrão de `fn_conversation_assign`: quando há sessão, ela precisa ser
  -- de um membro `agent`+ da organização. Sem sessão (worker com service key) a
  -- checagem não se aplica — quem tem a chave já tem tudo.
  if auth.uid() is not null
     and not public.fn_role_at_least(p_organization_id, 'agent') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'caller must be an active agent+ member of the organization';
  end if;

  update public.passagens_de_atendimento
     set reconhecido_em = now()
   where organization_id = p_organization_id
     and conversation_id = p_conversation_id
     and reconhecido_em is null;
  get diagnostics v_fechadas = row_count;

  update public.agent_inbox_items
     set status = 'resolved',
         resolved_at = now()
   where organization_id = p_organization_id
     and kind = 'handoff'
     and ref_kind = 'conversation'
     and ref_id = p_conversation_id
     and status = 'open';

  return v_fechadas;
end;
$$;

revoke all     on function public.fn_passagem_devolvida(uuid, uuid) from public, anon;
grant  execute on function public.fn_passagem_devolvida(uuid, uuid) to authenticated, service_role;

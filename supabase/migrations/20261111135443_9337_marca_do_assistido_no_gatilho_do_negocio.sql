-- manifest: **O desfecho do negócio leva a marca do modo assistido (#4319, doc 301 = B):** `fn_emit_event_on_lead_change` lê o cabeçalho `x-actor-operation-mode` da requisição (`request.headers`, posto pelo PostgREST) e, quando ele diz `assisted`, grava `actor_operation_mode: "assisted"` no metadata de `lead.won`, `lead.lost`, `lead.reopened` e `lead.assigned`. Com a marca, o motor de automação segura o que fala com o cliente (WhatsApp, e-mail, mensagem da IA, sequência) quando quem fechou o negócio foi a IA no assistido. Só `create or replace` da função do gatilho; nenhuma coluna, nenhum dado tocado. Sem o cabeçalho, o evento sai igual ao de antes.
-- ============================================================================
-- 9337 — O DESFECHO DO NEGÓCIO LEVA A MARCA DO ASSISTIDO (#4319, doc 301 = B).
--
-- O app marca o evento que ELE emite (`lead.stage_changed`) com
-- `actor_operation_mode`. Os quatro eventos deste gatilho não passam pelo app:
-- `emit_event` os recusa vindos da sessão (migration 0581), e o gatilho não vê o
-- ator. Sem a marca, a IA no assistido movia o card para a etapa de ganho e a
-- regra de `lead.won` mandava WhatsApp sem ninguém aprovar.
--
-- O gatilho vê a REQUISIÇÃO: o PostgREST expõe os cabeçalhos em
-- `request.headers` (o mesmo caminho de `fn_pgrst_recusar_replay_do_gateway`).
-- O app põe o cabeçalho só quando o ator está no assistido
-- (`escritaComMarca`). Forjá-lo só deixa a automação mais contida; não abre nada.
--
-- `emit_event` direto, e não `fn_log_event`: este não tem metadata. A entidade é
-- a mesma que ele derivava (`'lead'`, `new.id`).
-- ============================================================================

create or replace function public.fn_emit_event_on_lead_change() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_antes text;
  v_meta jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    return new;
  end if;

  -- Doc 301 = B (#4319): a IA no modo ASSISTIDO (ou a regra que rodou por causa
  -- dela) escreve com o cabeçalho `x-actor-operation-mode: assisted`
  -- (`escritaComMarca`, lib/automation/parada-no-assistido.ts). O evento leva a
  -- marca e o motor de automação segura o que fala com o cliente. Forjar o
  -- cabeçalho só deixa a automação mais contida: não abre nada.
  if coalesce(nullif(current_setting('request.headers', true), '')::jsonb
       ->> 'x-actor-operation-mode', '') = 'assisted' then
    v_meta := jsonb_build_object('actor_operation_mode', 'assisted');
  end if;

  -- O negócio se anuncia: `auth.uid()` segue preenchido aqui (o UPDATE veio da
  -- sessão de quem moveu o card), e sem este sinal a reserva do `emit_event`
  -- calaria o próprio gatilho. A chave é de transação e volta ao valor anterior
  -- antes do `return` — a janela é este corpo, não o resto da transação.
  v_antes := current_setting('deskcomm.desfecho_pelo_negocio', true);
  perform set_config('deskcomm.desfecho_pelo_negocio', 'on', true);

  -- `emit_event` direto, com a entidade que o `fn_log_event` derivava
  -- ('lead', `new.id`): é o único jeito de o metadata chegar à linha.
  if new.status is distinct from old.status then
    if new.status = 'won' then
      perform public.emit_event('lead.won', 'lead', new.id,
        jsonb_build_object('lead_id', new.id, 'value_cents', new.value_cents), v_meta, new.organization_id);
    elsif new.status = 'lost' then
      perform public.emit_event('lead.lost', 'lead', new.id,
        jsonb_build_object('lead_id', new.id, 'lost_reason', new.lost_reason), v_meta, new.organization_id);
    elsif new.status = 'open' then
      perform public.emit_event('lead.reopened', 'lead', new.id,
        jsonb_build_object('lead_id', new.id), v_meta, new.organization_id);
    end if;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id
     or new.owner_agent_id is distinct from old.owner_agent_id then
    perform public.emit_event('lead.assigned', 'lead', new.id,
      jsonb_build_object(
        'lead_id', new.id,
        'from_user_id', old.owner_user_id, 'to_user_id', new.owner_user_id,
        'from_agent_id', old.owner_agent_id, 'to_agent_id', new.owner_agent_id,
        'owner_kind', new.owner_kind), v_meta, new.organization_id);
  end if;

  perform set_config('deskcomm.desfecho_pelo_negocio', coalesce(v_antes, ''), true);
  return new;
end$$;

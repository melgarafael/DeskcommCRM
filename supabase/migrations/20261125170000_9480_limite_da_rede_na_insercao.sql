-- manifest: o teto de respostas do TikTok (A21) vira invariante do banco: `fn_respostas_na_janela` é a ÚNICA régua da contagem (a IA, a equipe e o trigger a leem) e `trg_limite_da_rede_na_insercao` barra, sob lock da conversa, a 11ª mensagem de saída. Sem isto dois envios no mesmo segundo liam 9, passavam, e a 11ª saía `failed` com o erro cru da rede.
--
-- ─── O que entra ───────────────────────────────────────────────────────────
--
--   1. `fn_respostas_na_janela(p_org, p_conversation, p_desde)`: quantas mensagens
--      a empresa mandou desde `p_desde` — saída, sem as `failed`, contando o que
--      está na fila (`coalesce(sent_at, created_at)`). Antes eram duas cópias da
--      régua (PostgREST em `respostas-na-janela.ts`, SQL em `agent/limite-da-rede.ts`);
--      agora as duas chamam esta.
--   2. `fn_limite_da_rede_na_insercao()` + `trg_limite_da_rede_na_insercao`
--      (BEFORE INSERT em `messages`): só age em mensagem de SAÍDA, não `failed`,
--      de conversa `tiktok` com `last_inbound_at`. Pega `pg_advisory_xact_lock`
--      da conversa, conta e, se já houver 10, levanta `limite_da_rede` (ERRCODE
--      23514). O lock vai até o fim da transação do INSERT: o segundo envio espera
--      o primeiro confirmar e então conta 10. Vale para qualquer chamador.
--
-- O teto 10 mora em `LIMITES_POR_REDE_SOCIAL` (TypeScript) E aqui; o teste
-- `limite-da-rede-no-banco.test.ts` exige que os dois andem juntos. A janela de
-- 48 h e a reserva de 2 da equipe ficam só em código (decisão por autor).
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `create or replace` nas funções; `drop trigger if exists` + `create trigger`.
-- security invoker: recebe a organização por argumento, sem validar membership.

create or replace function public.fn_respostas_na_janela(
  p_org uuid,
  p_conversation uuid,
  p_desde timestamptz
)
returns integer
  language sql
  stable
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
  select count(*)::int
    from public.messages m
   where m.organization_id = p_org
     and m.conversation_id = p_conversation
     and m.direction = 'outbound'
     and m.status <> 'failed'
     and coalesce(m.sent_at, m.created_at) >= p_desde;
$$;

comment on function public.fn_respostas_na_janela(uuid, uuid, timestamptz) is
  'Quantas mensagens a empresa mandou na conversa desde p_desde: saída, sem as failed, contando as que ainda estão na fila (coalesce(sent_at, created_at)). É a ÚNICA régua do limite de resposta das redes (A21, TikTok): o gate da IA (agent/limite-da-rede.ts), o envio da equipe (respostas-na-janela.ts, por rpc) e o trigger trg_limite_da_rede_na_insercao a chamam. Contagem inline em outro lugar é uma segunda régua. security invoker: recebe a organização por argumento e não valida membership.';

revoke execute on function public.fn_respostas_na_janela(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant  execute on function public.fn_respostas_na_janela(uuid, uuid, timestamptz)
  to service_role;

create or replace function public.fn_limite_da_rede_na_insercao()
returns trigger
  language plpgsql
  security invoker
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_canal text;
  v_ultima timestamptz;
  v_total integer;
begin
  if new.direction is distinct from 'outbound' or new.status = 'failed' then
    return new;
  end if;

  select c.channel, c.last_inbound_at
    into v_canal, v_ultima
    from public.conversations c
   where c.id = new.conversation_id
     and c.organization_id = new.organization_id;

  if v_canal is distinct from 'tiktok' or v_ultima is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('limite_da_rede:' || new.conversation_id::text));

  v_total := public.fn_respostas_na_janela(new.organization_id, new.conversation_id, v_ultima);
  if v_total >= 10 then
    raise exception 'limite_da_rede: o TikTok aceita 10 respostas desde a última mensagem do cliente'
      using errcode = '23514',
            detail = format('na_janela=%s teto=10', v_total),
            hint = 'limite_da_rede';
  end if;

  return new;
end
$$;

comment on function public.fn_limite_da_rede_na_insercao() is
  'BEFORE INSERT em messages: barra, sob pg_advisory_xact_lock da conversa, a 11ª mensagem de saída de uma conversa do TikTok depois da última do cliente (A21). O teto 10 espelha LIMITES_POR_REDE_SOCIAL.tiktok.maxRespostas (teste limite-da-rede-no-banco). Só conta; janela de 48 h e reserva da equipe ficam em código.';

revoke execute on function public.fn_limite_da_rede_na_insercao()
  from public, anon, authenticated;

drop trigger if exists trg_limite_da_rede_na_insercao on public.messages;
create trigger trg_limite_da_rede_na_insercao
  before insert on public.messages
  for each row execute function public.fn_limite_da_rede_na_insercao();

notify pgrst, 'reload schema';

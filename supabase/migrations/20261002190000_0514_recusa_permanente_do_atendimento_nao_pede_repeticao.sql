-- A RECUSA PERMANENTE DO ATENDIMENTO PARA DE PEDIR REPETIÇÃO — `PT409`, não `40001`.
--
-- ## O defeito, medido em produção (VPS self-hosted, 2026-10-02)
--
-- `fn_service_status` é a porta única de fechar, arquivar e reabrir conversa
-- (`POST /api/v1/conversations/[id]/close` e `PATCH /api/v1/conversations/[id]`).
-- Ela tem lock otimista: a tela manda a revisão que viu (`p_expected`) e, se o
-- atendimento já andou, a função recusa com `service_stale`. É uma recusa
-- PERMANENTE — a revisão enviada nunca vai voltar a bater; quem clicou precisa
-- atualizar a tela. Mas saía com `errcode='40001'`, que significa o contrário:
-- "conflito de serialização, tente de novo".
--
-- E quem acredita nessa promessa é a infraestrutura. Numa instalação com o
-- Supabase self-hosted (Envoy na frente, PostgREST 14.17), uma tela velha
-- clicando em "Encerrar" produziu:
--
--   - 3 chamadas a `rpc/fn_service_status` no log do gateway em 10 minutos, uma
--     delas respondida com 504 depois dos 30 s do Envoy;
--   - ~8.500 execuções da requisição no banco em ~10 s (o `set_config` e o
--     `db_pre_request` de cada uma contados em `pg_stat_statements` sob
--     `service_role`), todas desfeitas;
--   - 29.330 rollbacks contra 2.084 commits em 30 s, e a VPS (2 vCPU) com load
--     10–11 e CPU ociosa em 0%: o CRM inteiro lento para todo mundo.
--
-- O Envoy do self-hosted não tem política de retry — ele só corta em 30 s. A
-- reexecução acontece atrás dele, e continua depois que o cliente desiste.
-- Reiniciar o contêiner do PostgREST apagou o laço na hora (rollbacks: 29.330
-- → 1 em 30 s), o que localiza o mecanismo na camada da REST, e não no app.
--
-- A guarda da 0250 (`fn_pgrst_recusar_replay_do_gateway`) não alcança este
-- caso: ela reconhece a reexecução pelo instante embutido no `sb-request-id`,
-- e esse cabeçalho é carimbado pelo gateway da NUVEM do Supabase. No
-- self-hosted ele não chega, a guarda retorna cedo e o laço não tem fim.
--
-- ## O conserto
--
-- O mesmo da 0363 para a agenda, que é a saída que o runbook
-- `docs/runbooks/postgrest-replay-do-gateway.md` nomeia: `PT409`. O PostgREST
-- lê os três últimos dígitos de `PTxxx` como o status HTTP — `PT409` chega como
-- 409, e 4xx não é reexecutado por ninguém.
--
-- Só `service_stale` muda. `service_contact_changed` CONTINUA `40001`, de
-- propósito: ali o contato da conversa mudou entre a leitura e o lock, e uma
-- nova tentativa relê `pre_contact` e passa — é conflito de serialização de
-- verdade, e a repetição é a resposta certa.
--
-- Os dois chamadores do app passam a ler `PT409` como 409, e continuam lendo
-- `40001` também: o banco e a imagem do app não se atualizam no mesmo instante.
--
-- ## O que NÃO muda
--
-- Corpo idêntico ao da última definição do baseline, com um `errcode` trocado e
-- mais nada: mesma ordem de guardas, mesmo lock (`fn_service_lock`), mesmos
-- efeitos. Grants reafirmados como já estavam (só `service_role`).
-- Sem tabela, coluna ou dado novo. Idempotente: `create or replace`.

create or replace function public.fn_service_status(p_org uuid,p_conversation uuid,p_status text,p_expected bigint default null)
returns public.conversations language plpgsql security definer set search_path=public as $$
declare c public.conversations; terminal boolean; pre_contact uuid;
begin
 if p_status not in ('closed','resolved','archived','open','pending','ai_handling','claimed') then
  raise exception 'invalid_status' using errcode='22023'; end if;
 select * into c from public.conversations where id=p_conversation and organization_id=p_org;
 if not found then raise exception 'service_not_found' using errcode='P0002'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(p_org,c.contact_id);
 select * into c from public.conversations where id=p_conversation and organization_id=p_org for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if p_expected is not null and c.service_revision<>p_expected then raise exception 'service_stale' using errcode='PT409'; end if;
 if c.status=p_status then return c; end if;
 terminal := p_status in ('closed','resolved','archived');
 update public.conversations set status=p_status,status_changed_at=clock_timestamp(),
   service_revision=service_revision+case when terminal or c.status in ('closed','resolved','archived') then 1 else 0 end,
   service_closed_at=case when terminal then clock_timestamp() else service_closed_at end,
   service_started_at=case when c.status in ('closed','resolved','archived') and not terminal then clock_timestamp() else service_started_at end,
   bot_silenced_until=case when terminal and last_handoff_at is null then null else bot_silenced_until end,
   current_demanda_id=case when c.status in ('closed','resolved','archived') and not terminal then null else current_demanda_id end
  where id=c.id and organization_id=p_org returning * into c;
 if terminal then
   update public.demandas set proximo_passo=coalesce(proximo_passo,'Revisar atendimento e registrar o desfecho da demanda')
    where organization_id=p_org and id=c.current_demanda_id and fechada_em is null;
 end if;
 return c;
end; $$;

revoke execute on function public.fn_service_status(uuid,uuid,text,bigint) from public,anon,authenticated;
grant execute on function public.fn_service_status(uuid,uuid,text,bigint) to service_role;

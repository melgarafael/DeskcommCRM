-- 0121 — Passo 3 do cap. 5: a demanda nasce no PONTO DE ENTRADA.
--
-- Até aqui `demandas` só tinha o passado derivado (0119). Uma peça que só recebe
-- e não é alimentada por nada novo **para de crescer** — e peça que só recebe é
-- ilha pelo invariante 1 da própria doutrina. A entidade estava correta e morta.
--
-- ## Por que TRIGGER, e não um emissor em código
--
-- Entrada de mensagem tem mais de um caminho (ingest do WAHA, rota de mensagens,
-- seeds, futuros canais). Caçar cada emissor deixaria a garantia dependendo de
-- alguém lembrar — e o próximo canal nasceria sem demanda, em silêncio.
--
-- O trigger é SQL puro e não faz I/O externo: a proibição da doutrina é
-- "trigger Postgres NUNCA faz HTTP", porque isso põe a rede dentro da transação.
-- Inserir linha é exatamente o que `trg_messages_emit_event` (event_log) e
-- `trg_conversation_routing_requested` já fazem nestas mesmas tabelas.
--
-- ## A regra de abertura, e o que ela deliberadamente NÃO tenta
--
-- Uma mensagem do cliente abre demanda **se não houver demanda aberta para
-- aquele contato**. Isso dá:
--   * toda entrada com demanda (a garantia que faltava);
--   * N demandas por conversa AO LONGO DO TEMPO (fechou uma, a próxima
--     mensagem abre outra) — o modelo N:N da 0119 continua honrado.
--
-- O que NÃO se tenta: detectar dois assuntos SIMULTÂNEOS na mesma conversa.
-- Isso exigiria classificação semântica, e a Fase 3 mediu que a camada lexical
-- não separa assunto (faixas sobrepostas). Fica como dívida DECLARADA — melhor
-- uma demanda por vez, correta, do que duas adivinhadas.

create or replace function public.fn_demanda_abre_no_inbound()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_demanda uuid;
begin
  if new.direction <> 'inbound' then
    return new;
  end if;

  select d.id into v_demanda
    from public.demandas d
   where d.organization_id = new.organization_id
     and d.contact_id = new.contact_id
     and d.fechada_em is null
   order by d.aberta_em desc
   limit 1;

  if v_demanda is null then
    insert into public.demandas
      (organization_id, contact_id, aberta_em, origem, estado, dono_kind)
    values
      (new.organization_id, new.contact_id, new.sent_at, 'inbound', 'aberta', 'ia')
    returning id into v_demanda;
  end if;

  -- O vínculo é por conversa: a mesma demanda acumula os canais por onde a
  -- pessoa falou (cap. 5 §5.4). `on conflict do nothing` porque a chave é o par.
  insert into public.demanda_conversas (organization_id, demanda_id, conversation_id)
  values (new.organization_id, v_demanda, new.conversation_id)
  on conflict do nothing;

  return new;
end;
$$;

-- SECURITY DEFINER porque o trigger roda no INSERT do webhook (service role) e
-- também no de sessão; sem definer, a RLS de `demandas` recusaria a escrita em
-- um dos caminhos e a demanda sumiria justamente na entrada real. O
-- organization_id vem SEMPRE de `new`, nunca de parâmetro — não há superfície
-- para escolher org alheia.
revoke all     on function public.fn_demanda_abre_no_inbound() from public;
revoke execute on function public.fn_demanda_abre_no_inbound() from anon, authenticated;

drop trigger if exists trg_demanda_abre_no_inbound on public.messages;
create trigger trg_demanda_abre_no_inbound
  after insert on public.messages
  for each row execute function public.fn_demanda_abre_no_inbound();

-- ---------------------------------------------------------------------------
-- Fechamento. Sem ele a demanda nunca termina e o denominador do índice (que
-- conta FECHADAS) ficaria vazio para sempre — a métrica morreria em silêncio no
-- exato momento em que a entidade passou a crescer.
-- ---------------------------------------------------------------------------

create or replace function public.fn_demanda_fecha_com_conversa()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('resolved', 'closed') or old.status = new.status then
    return new;
  end if;

  update public.demandas d
     set estado = 'resolvida',
         desfecho = 'resolvida',
         fechada_em = now(),
         updated_at = now()
   where d.organization_id = new.organization_id
     and d.fechada_em is null
     and exists (
       select 1 from public.demanda_conversas dc
        where dc.demanda_id = d.id and dc.conversation_id = new.id
     )
     -- Só fecha se TODAS as conversas da demanda estiverem encerradas: uma
     -- demanda que atravessou dois canais não acabou porque um deles fechou.
     and not exists (
       select 1
         from public.demanda_conversas dc2
         join public.conversations c2 on c2.id = dc2.conversation_id
        where dc2.demanda_id = d.id
          and c2.id <> new.id
          and c2.status not in ('resolved', 'closed')
     );

  return new;
end;
$$;

revoke all     on function public.fn_demanda_fecha_com_conversa() from public;
revoke execute on function public.fn_demanda_fecha_com_conversa() from anon, authenticated;

drop trigger if exists trg_demanda_fecha_com_conversa on public.conversations;
create trigger trg_demanda_fecha_com_conversa
  after update of status on public.conversations
  for each row execute function public.fn_demanda_fecha_com_conversa();

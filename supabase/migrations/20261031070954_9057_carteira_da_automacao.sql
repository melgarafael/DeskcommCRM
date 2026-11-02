-- manifest: **A passagem SDR → Closer passa a ter porta para a CARTEIRA e para as CONVERSAS do cliente (#3514, PR #3565 de @webtecnica).** A ação de automação `assign_owner` trocava só o dono do NEGÓCIO. (1) `fn_definir_carteira_do_cliente` passa a aceitar `p_actor` NULO **somente** com `p_origem = 'automacao'`, e recusa essa origem a quem chega COM ator; `automacao` entra na CHECK `contacts_carteira_origem_vocabulario`. O corpo é o da 9039 (#3642: a carteira leva junto as conversas abertas do dono anterior e as sem dono que a IA não atende) mais essa regra — esta migration renumera a antiga 0799 do PR, cujo carimbo ficava antes da 9039 e cujo corpo partia da 0622 (aplicada fora de ordem, desfaria a #3642). (2) Função nova `fn_passar_conversas_do_contato(org, contato, dono)`: passa ao dono as conversas ABERTAS do contato que estão com OUTRA pessoa, pela `fn_conversation_assign` (`reason = 'transfer'`), com as linhas travadas na mesma transação — conversa encerrada no meio do caminho não é reaberta — e devolve quantas a função de atribuição de fato devolveu. Só `service_role` executa as duas. Sem coluna, sem backfill, idempotente.
-- 9057 — a carteira do cliente ganha a origem `automacao` (ator nulo do servidor), e as conversas abertas do contato ganham uma passagem que não reabre conversa encerrada
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- O funil passa o cliente de um vendedor para outro num ponto conhecido (SDR
-- agenda a reunião, Closer assume). A automação move o NEGÓCIO; a carteira do
-- CONTATO e as conversas ABERTAS ficam com o SDR. O sistema não reconhece o que
-- ele mesmo fez: o negócio é do Closer e o cliente é do SDR.
--
-- As conversas têm porta e ela é usada sem mudança nenhuma daqui
-- (`fn_conversation_assign`, com `p_reason='transfer'`), chamada pela função
-- nova da seção (C). A carteira não tinha:
-- a 0622 fechou a escrita na função DEFINER justamente porque a policy de
-- UPDATE de `contacts` é cega a papel (um Atendente se punha como dono pela
-- REST), e a função exige ator humano manager+.
--
-- ─── Por que a porta é ESTA e não uma função nova ──────────────────────────
--
-- Duas réguas de dono já custaram caro neste repositório (a #3479 mediu papel ×
-- escopo de dados). Uma função `fn_carteira_da_automacao` seria a TERCEIRA: ela
-- teria de repetir a validação do dono candidato, a coerência do trio e a
-- adoção dos negócios sem dono — quatro cópias da mesma regra para envelhecer
-- em ritmos diferentes. Em vez disso, a regra que faltava é UMA: quem não tem
-- ator é o sistema, e o sistema se identifica pela origem.
--
--   * ator nulo + `automacao`  → passa (é a automação);
--   * ator nulo + qualquer outra origem → `carteira_sem_ator` (42501), como hoje;
--   * ator humano + `automacao` → `carteira_origem_invalida` (22023): a origem
--     do sistema não é rótulo que uma pessoa escolhe para o próprio ato.
--
-- A autorização do caminho sem ator é o GRANT: a função só é executável por
-- `service_role` (medido: `revoke ... from public, anon, authenticated`), e é por
-- onde a rota da carteira e o motor de automação já falam com o banco. O papel
-- do dono candidato continua sendo checado do mesmo jeito — a automação não
-- ganha o direito de entregar a carteira a um viewer.

-- ─── (A) o vocabulário da origem ────────────────────────────────────────────

alter table public.contacts
  drop constraint if exists contacts_carteira_origem_vocabulario;
alter table public.contacts
  add constraint contacts_carteira_origem_vocabulario
  check (carteira_origem is null
         or carteira_origem in ('manual', 'importacao', 'atribuicao_automatica', 'automacao'));

-- ─── (B) a porta única, agora com a vez do sistema ──────────────────────────
--
-- O corpo é o VIGENTE da 9039 (#3642: trocar a carteira leva junto as conversas
-- abertas do dono anterior e as sem dono que a IA não atende) com a regra do
-- ator nulo acrescentada. Esta migration era a 0799 do PR, com carimbo de 27/10
-- e corpo da 0622: na cadeia ela rodaria ANTES da 9039 (que apagaria a origem
-- `automacao`), e num banco que já tem a 9039 ela desfaria a #3642. O mesmo
-- corpo está na última definição do `supabase/baseline.sql`.

create or replace function public.fn_definir_carteira_do_cliente(
  p_org uuid,
  p_actor uuid,
  p_contact uuid,
  p_dono uuid,
  p_origem text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ator uuid := p_actor;
  v_papel text;
  v_dono_papel text;
  v_contato_org uuid;
  v_origem text := coalesce(p_origem, 'manual');
  v_anterior uuid;
  v_conversa uuid;
begin
  if v_origem not in ('manual', 'importacao', 'atribuicao_automatica', 'automacao') then
    raise exception 'carteira_origem_invalida' using errcode = '22023';
  end if;
  if v_ator is null then
    -- #3514: sem ator humano, quem grava é o SISTEMA — e só ele. A automação
    -- não tem sessão; o que a identifica é a origem `automacao`, que a função
    -- recusa a quem chega com ator (senão a origem do sistema virava um rótulo
    -- que qualquer manager escolhia para esconder o próprio ato).
    if v_origem <> 'automacao' then
      raise exception 'carteira_sem_ator' using errcode = '42501';
    end if;
  end if;
  if p_org is null or p_contact is null then
    raise exception 'carteira_parametro_invalido' using errcode = '22023';
  end if;

  if v_ator is not null then
    -- Quem muda: manager+ da MESMA organização (e membro aceito, não revogado).
    select uo.role into v_papel
      from public.user_organizations uo
     where uo.user_id = v_ator
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_papel is null or v_papel not in ('manager', 'admin') then
      raise exception 'carteira_permissao_negada'
        using errcode = '42501',
              detail = 'Só manager e admin definem a carteira do cliente.';
    end if;
    if v_origem = 'automacao' then
      raise exception 'carteira_origem_invalida'
        using errcode = '22023',
              detail = 'A origem automacao é do servidor, sem ator: quem chama com ator grava manual ou atribuicao_automatica.';
    end if;
  end if;

  select c.organization_id, c.carteira_user_id into v_contato_org, v_anterior
    from public.contacts c
   where c.id = p_contact;
  if v_contato_org is null then
    raise exception 'carteira_contato_nao_encontrado' using errcode = '22023';
  end if;
  if v_contato_org <> p_org then
    raise exception 'carteira_contato_de_outra_organizacao' using errcode = '42501';
  end if;

  if p_dono is not null then
    -- Quem CONTA: membro ativo da mesma org com papel de trabalho. `viewer` e
    -- membro revogado não contam — o cliente volta ao fluxo normal.
    select uo.role into v_dono_papel
      from public.user_organizations uo
     where uo.user_id = p_dono
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_dono_papel is null or v_dono_papel not in ('agent', 'manager', 'admin') then
      raise exception 'carteira_dono_invalido'
        using errcode = '22023',
              detail = 'O dono precisa ser membro ativo da mesma organização com papel agent, manager ou admin.';
    end if;
  end if;

  update public.contacts
     set carteira_user_id = p_dono,
         carteira_origem = case when p_dono is null then null else v_origem end,
         carteira_definida_em = case when p_dono is null then null else now() end,
         updated_at = now()
   where id = p_contact
     and organization_id = p_org;

  -- Os negócios ABERTOS sem dono do contato vão para o dono da carteira; os que
  -- já têm dono não mudam (ninguém perde carteira por causa de uma carteira).
  if p_dono is not null then
    update public.crm_leads
       set owner_user_id = p_dono,
           owner_kind = 'user',
           assigned_at = coalesce(assigned_at, now())
     where organization_id = p_org
       and contact_id = p_contact
       and status = 'open'
       and owner_user_id is null
       and owner_agent_id is null;

    -- ─── #3642: a carteira leva as conversas abertas ─────────────────────────
    -- Só as que estavam com o dono ANTERIOR da carteira (ou sem dono): conversa
    -- que já é de outra pessoa não é roubada por uma troca de carteira. Passa
    -- pela MESMA porta da transferência, então a conversa, o evento na linha do
    -- tempo e o número do vendedor andam juntos — e `reason` fica no vocabulário
    -- fechado da tabela de eventos ('transfer').
    if p_dono is distinct from v_anterior then
      for v_conversa in
        select c.id
          from public.conversations c
         where c.organization_id = p_org
           and c.contact_id = p_contact
           and c.status in ('open', 'pending', 'claimed', 'ai_handling')
           and (c.assigned_to_user_id is null or c.assigned_to_user_id = v_anterior)
           -- Doc 237, escolha 3-B: a conversa que a IA está atendendo fica com a
           -- IA. Quem diz isso é `comando_da_conversa` (a mesma regra da tela e
           -- do motor), não o status: a IA atende conversa `open` sem dono, e
           -- `ai_handling` quase não é escrito. Passá-la aqui a deixaria
           -- "assumida" e a IA calada sem prazo. Quando a IA passar a conversa
           -- para humano, o dono da carteira já é o vendedor novo.
           and public.comando_da_conversa(c) <> 'automatico'
         order by c.id
      loop
        perform public.fn_conversation_assign(p_org, v_conversa, p_dono, 'transfer');
      end loop;
    end if;
  end if;

  return p_dono;
end;
$$;

revoke execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  to service_role;

-- ─── (C) as conversas abertas que estão com OUTRA pessoa ────────────────────
--
-- A opção "conversas" da ação passa ao dono novo as conversas ABERTAS do
-- contato que hoje estão no nome de outra pessoa — inclusive a de um terceiro,
-- que a carteira (#3642) deixa onde está de propósito. Conversa sem dono não é
-- tocada aqui: ela é fila ou IA atendendo, e `reason = 'transfer'` calaria a IA.
--
-- Por que em SQL, e não um laço no servidor chamando `fn_conversation_assign`:
--   * a conversa encerrada entre a leitura e a troca era REABERTA, porque a
--     função de atribuição grava `status = 'claimed'` sem conferir o status de
--     novo. Aqui as linhas são travadas (`for no key update`) pelo mesmo filtro
--     de "aberta": quem encerra antes da trava tira a conversa do conjunto
--     (o Postgres reavalia o WHERE na versão nova), quem encerra depois espera;
--   * a contagem é a das linhas que a função de atribuição DEVOLVEU. Ela é
--     `returns setof` e devolve vazio quando não grava; contar a chamada sem
--     erro como "movida" contava o que não foi movido;
--   * é tudo ou nada: o recibo diz "passou" ou "não passou", nunca "algumas".
--
-- "Aberta" é a mesma lista da 9039 e de `STATUS_ENCERRADOS`
-- (`lib/inbox/comando-da-conversa.ts`): o complemento de closed/archived/resolved.

create or replace function public.fn_passar_conversas_do_contato(
  p_org uuid,
  p_contact uuid,
  p_dono uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversa uuid;
  v_passou uuid;
  v_movidas integer := 0;
begin
  if p_org is null or p_contact is null or p_dono is null then
    raise exception 'passagem_parametro_invalido' using errcode = '22023';
  end if;

  for v_conversa in
    select c.id
      from public.conversations c
     where c.organization_id = p_org
       and c.contact_id = p_contact
       and c.status in ('open', 'pending', 'claimed', 'ai_handling')
       and c.assigned_to_user_id is not null
       and c.assigned_to_user_id <> p_dono
     order by c.id
       for no key update
  loop
    -- Zero linhas devolvidas = nada gravado: `v_passou` fica nulo e não conta.
    select a.id into v_passou
      from public.fn_conversation_assign(p_org, v_conversa, p_dono, 'transfer') a;
    if v_passou is not null then
      v_movidas := v_movidas + 1;
    end if;
  end loop;

  return v_movidas;
end;
$$;

revoke execute on function public.fn_passar_conversas_do_contato(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fn_passar_conversas_do_contato(uuid, uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';

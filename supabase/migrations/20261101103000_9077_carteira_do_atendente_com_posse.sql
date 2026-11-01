-- manifest: **O Atendente muda a carteira do cliente que já é dele (#3746).** A `fn_definir_carteira_do_cliente` cobrava ator `manager`+ (`carteira_permissao_negada`), então baixar o piso só na rota deixaria o Atendente com um 403 vindo do banco — o fix seria de fachada. Aqui a porta ÚNICA de gravação aceita `agent` COM ESCOPO DE POSSE: o contato já está na carteira dele ou alguma conversa do contato está atribuída a ele; fora disso, `carteira_fora_da_posse` (42501, traduzido em 403 pela rota). `manager`/`admin` seguem sem escopo, `viewer` e revogado seguem recusados. Mesmo corpo da 9057, só o gate do ator muda; EXECUTE continua `service_role`.

-- ─── O quê ──────────────────────────────────────────────────────────────────
--
-- O #3746 mediu duas funções do dia a dia travadas em `manager`+ no app: mudar
-- a carteira do cliente e inscrever o contato num follow-up. A segunda é só
-- rota (`requireRole`); a primeira tem um SEGUNDO gate, este, em SQL. Corrigir
-- apenas o `requireRole` da rota não muda nada no banco: a função levantava
-- `carteira_permissao_negada` para qualquer ator que não fosse `manager`/`admin`
-- e o Atendente continuaria levando 403 — agora vindo de baixo.
--
-- ─── Por que a posse é medida AQUI, e não só na rota ────────────────────────
--
-- Esta é a única porta que grava `contacts.carteira_user_id`: o gatilho
-- `trg_contacts_carteira_so_pelo_servidor` recusa a SESSÃO (42501), e o verbo
-- mora na função. Se a régua ficasse só na rota, todo chamador novo (automação,
-- cron, script de importação, a próxima rota que aparecer) nasceria com o
-- caminho aberto. A rota confere antes para dar a mensagem certa e para não
-- gastar a transação; a função confere porque é a autoridade.
--
-- A régua é a MESMA das duas rotas (`lib/carteira/posse.ts`, #3746), escrita
-- duas vezes porque um lado é TypeScript e o outro é SQL:
--
--   • `manager`/`admin` → passa (papel de gerência não tem escopo de posse);
--   • `agent` + contato já na carteira dele → passa;
--   • `agent` + conversa do contato atribuída a ele → passa;
--   • `agent` sem nenhuma das duas → `carteira_fora_da_posse`;
--   • `viewer`, membro revogado, ator nulo sem `automacao` → como antes.
--
-- ─── O que NÃO muda ─────────────────────────────────────────────────────────
--
--   • o corpo da 9057 (#3642: a carteira leva as conversas abertas do dono
--     anterior e as sem dono que a IA não atende; #3514: `p_actor` nulo só com
--     `p_origem = 'automacao'`);
--   • a validação do DONO candidato (`carteira_dono_invalido`, regra 5);
--   • a adoção dos negócios abertos sem dono, na mesma transação;
--   • o EXECUTE: `revoke ... from public, anon, authenticated` +
--     `grant ... to service_role` seguem valendo — a função é redefinida com
--     `create or replace`, e os privilégios da assinatura não são tocados.
--
-- Sem coluna nova, sem backfill, sem tabela. Idempotente: reaplicar troca a
-- definição pela mesma definição.

-- ─── A porta única, com o Atendente e o escopo de posse ─────────────────────
--
-- `create or replace` da MESMA assinatura (uuid, uuid, uuid, uuid, text): quem já
-- chama não muda nada. O corpo é o vigente da 9057 com o gate do ator trocado —
-- nenhuma outra linha da função foi tocada de propósito, para o diff ser o gate.

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
    -- Quem muda: `agent`+ da MESMA organização (e membro aceito, não revogado).
    -- #3746: o Atendente entrou nesta porta, mas com ESCOPO DE POSSE — o papel
    -- sozinho não distingue "meu cliente" de "cliente do colega", e liberar o
    -- papel seco deixaria qualquer Atendente se pôr como dono do cliente de
    -- outro e levar o negócio seguinte no nome errado (o defeito do #2591).
    select uo.role into v_papel
      from public.user_organizations uo
     where uo.user_id = v_ator
       and uo.organization_id = p_org
       and uo.accepted_at is not null
       and uo.revoked_at is null;
    if v_papel is null or v_papel not in ('agent', 'manager', 'admin') then
      raise exception 'carteira_permissao_negada'
        using errcode = '42501',
              detail = 'Só atendente, manager e admin definem a carteira do cliente.';
    end if;
    if v_papel = 'agent' then
      -- A POSSE, conferida AQUI e não só na rota: esta é a porta ÚNICA de
      -- gravação (`trg_contacts_carteira_so_pelo_servidor` recusa a sessão), e
      -- um chamador novo não pode nascer sem a régua. Posse = o contato já está
      -- na carteira dele OU alguma conversa do contato está atribuída a ele.
      -- Fora das duas: `carteira_fora_da_posse`, que a rota traduz em 403.
      if not exists (
           select 1
             from public.contacts c
            where c.id = p_contact
              and c.organization_id = p_org
              and c.carteira_user_id = v_ator
         )
         and not exists (
           select 1
             from public.conversations cv
            where cv.organization_id = p_org
              and cv.contact_id = p_contact
              and cv.assigned_to_user_id = v_ator
         ) then
        raise exception 'carteira_fora_da_posse'
          using errcode = '42501',
                detail = 'O atendente só muda a carteira do cliente que já está com ele: conversa atribuída a ele ou contato na carteira dele.';
      end if;
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

-- ─── Privilégios: inalterados, e conferidos aqui de propósito ────────────────
--
-- `create or replace` preserva os privilégios da assinatura, mas repetir o
-- revoke/grant custa nada e deixa o arquivo legível sozinho: a função é do
-- `service_role`, e é o servidor quem decide com o ator que a rota passou.

revoke execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  to service_role;

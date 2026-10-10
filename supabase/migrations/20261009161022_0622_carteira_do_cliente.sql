-- manifest: **Carteira do cliente (#2591): o contato ganha um vendedor dono, que é avisado quando o cliente fala com outro e fica com o negócio novo.** Hoje o dono só existe em `crm_leads.owner_user_id` e em `conversations.assigned_to_user_id` — nascem de quem atendeu primeiro ou do rodízio. Aqui: (A) `contacts.carteira_user_id`/`carteira_origem`/`carteira_definida_em` com vocabulário fechado e coerência de uma via só (dono gravado exige origem e data, para o `on delete set null` do FK não recusar a exclusão do login do dono); (B) a coluna fica FORA do que `authenticated` grava (gatilho 42501, mesma forma da 0583) e só o servidor escreve pela `fn_definir_carteira_do_cliente` (SECURITY DEFINER, manager+ chamando, dono tem de ser membro ativo `agent`/`manager`/`admin` da MESMA organização — `viewer` e revogado não contam), que na mesma transação adota os negócios abertos SEM dono do contato; (C) `trg_crm_lead_nasce_na_carteira` (BEFORE INSERT) preenche dono/kind/assigned_at quando o negócio chega SEM dono e o contato tem carteira qualificada — negócio que já tem dono não muda, e sem carteira nada muda (o rodízio continua decidindo). Sem backfill: contato sem carteira é o comportamento de hoje.
-- 0622: dono por contato (contacts.carteira_*), escrita só pelo servidor e negócio novo que nasce com o dono
--
-- ─── O defeito ───────────────────────────────────────────────────────────────
--
-- Em operação com um WhatsApp por vendedor, o cliente "pertence" a quem o
-- atende há anos — mas o CRM não sabe disso: o dono só existe no NEGÓCIO e na
-- CONVERSA, e os dois nascem de quem atendeu primeiro ou do rodízio. O cliente
-- do vendedor A que escreve no número de B é atendido por B sem ninguém
-- avisar A, e o negócio novo nasce no nome de B (ou do rodízio). A comissão vai
-- para a pessoa errada e a disputa fica sem registro de quem era o dono.
--
-- ─── As três peças, e por que cada uma mora onde mora ───────────────────────
--
-- (A) O dono é do CONTATO, não do negócio: três colunas em `contacts`, com
--     `on delete set null` (o dono sai do Supabase, o cliente volta ao fluxo
--     normal) e um CHECK de vocabulário fechado + um CHECK de coerência de uma
--     via só (dono gravado exige origem e data; ver o comentário no CHECK).
--
-- (B) A escrita é do servidor, e isto não é preferência: a policy de UPDATE de
--     `contacts` não olha papel (medido pelo autor da issue numa cópia), então
--     um Atendente se põe como dono pela REST e leva o negócio seguinte. O
--     gatilho INVOKER recusa a sessão (`authenticated`/`anon`) com 42501 —
--     mesmo desenho do `trg_membro_provisorio_so_pelo_servidor` da 0583 — e a
--     função DEFINER valida papel do ator e do dono candidato, grava e
--     adota os negócios abertos sem dono na MESMA transação. Ela é só do
--     service_role: a rota chama depois do `requireRole("manager")` e passa o
--     ator (`p_actor`), como a `fn_definir_marca_da_organizacao`.
--
-- (C) O negócio novo nasce com o dono, e isto é gatilho de propósito: a criação
--     tem cinco caminhos (rota, automação, roteador, ingestão, MCP) e guardar
--     a regra em um deles deixa os outros quatro com o defeito. A guarda
--     `owner_user_id is not null OR owner_agent_id is not null` é a régua da
--     issue: negócio que já tem dono não muda por gatilho. Sem carteira a
--     função devolve a linha intacta — é o que mantém o rodízio atual de pé.
--
-- Sem backfill de propósito: `carteira_user_id` nulo é o comportamento de hoje
-- em toda instalação existente, e inventar dono a partir do rodízio antigo
-- seria justamente o erro que a issue quer corrigir.

-- ─── (A) dono por contato ───────────────────────────────────────────────────

alter table public.contacts
  add column if not exists carteira_user_id uuid
    references auth.users (id) on delete set null,
  add column if not exists carteira_origem text,
  add column if not exists carteira_definida_em timestamptz;

alter table public.contacts
  drop constraint if exists contacts_carteira_origem_vocabulario;
alter table public.contacts
  add constraint contacts_carteira_origem_vocabulario
  check (carteira_origem is null
         or carteira_origem in ('manual', 'importacao', 'atribuicao_automatica'));

alter table public.contacts
  drop constraint if exists contacts_carteira_trio_coerente;
alter table public.contacts
  add constraint contacts_carteira_trio_coerente
  check (
    -- Uma via só: dono gravado exige origem e data. O inverso não, porque o
    -- `on delete set null` do FK zera SÓ `carteira_user_id` — com o trio
    -- bicondicional, excluir o login do dono era recusado pelo CHECK.
    carteira_user_id is null
    or (carteira_origem is not null and carteira_definida_em is not null)
  );

-- ─── (B) a coluna fica fora do que a sessão grava ───────────────────────────

create or replace function public.fn_contacts_carteira_so_pelo_servidor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- SECURITY DEFINER e service_role passam (current_user é o dono/papel de
  -- serviço): o alvo é a SESSÃO autenticada, que não tem como se dar carteira.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.carteira_user_id is not null
       or new.carteira_origem is not null
       or new.carteira_definida_em is not null then
      raise exception 'contacts_carteira_so_pelo_servidor'
        using errcode = '42501',
              detail = 'A carteira do cliente é gravada por fn_definir_carteira_do_cliente, nunca pela sessão.';
    end if;
    return new;
  end if;
  if new.carteira_user_id is distinct from old.carteira_user_id
     or new.carteira_origem is distinct from old.carteira_origem
     or new.carteira_definida_em is distinct from old.carteira_definida_em then
    raise exception 'contacts_carteira_so_pelo_servidor'
      using errcode = '42501',
            detail = 'A carteira do cliente é gravada por fn_definir_carteira_do_cliente, nunca pela sessão.';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_contacts_carteira_so_pelo_servidor() from public, anon, authenticated;

drop trigger if exists trg_contacts_carteira_so_pelo_servidor on public.contacts;
create trigger trg_contacts_carteira_so_pelo_servidor
  before insert or update on public.contacts
  for each row execute function public.fn_contacts_carteira_so_pelo_servidor();

-- ─── (B) a única porta de escrita ───────────────────────────────────────────

drop function if exists public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, text);

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
begin
  if v_ator is null then
    raise exception 'carteira_sem_ator' using errcode = '42501';
  end if;
  if p_org is null or p_contact is null then
    raise exception 'carteira_parametro_invalido' using errcode = '22023';
  end if;
  if v_origem not in ('manual', 'importacao', 'atribuicao_automatica') then
    raise exception 'carteira_origem_invalida' using errcode = '22023';
  end if;

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

  select c.organization_id into v_contato_org
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
  end if;

  return p_dono;
end;
$$;

revoke execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fn_definir_carteira_do_cliente(uuid, uuid, uuid, uuid, text)
  to service_role;

-- ─── (C) o negócio novo nasce com o dono ────────────────────────────────────

create or replace function public.fn_crm_lead_nasce_na_carteira()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dono uuid;
begin
  -- Regra da issue: negócio que já tem dono não muda. Ninguém perde carteira
  -- por um gatilho, e o dono de IA segue tocando o que está tocando.
  if new.owner_user_id is not null or new.owner_agent_id is not null then
    return new;
  end if;
  if new.contact_id is null then
    return new;
  end if;

  select c.carteira_user_id into v_dono
    from public.contacts c
   where c.id = new.contact_id
     and c.organization_id = new.organization_id;
  -- Sem carteira (ou dono que saiu da equipe / que só lê) nada muda: é o
  -- rodízio de hoje que decide, como antes desta migration.
  if v_dono is null then
    return new;
  end if;
  perform 1
    from public.user_organizations uo
   where uo.user_id = v_dono
     and uo.organization_id = new.organization_id
     and uo.accepted_at is not null
     and uo.revoked_at is null
     and uo.role in ('agent', 'manager', 'admin');
  if not found then
    return new;
  end if;

  new.owner_user_id := v_dono;
  new.owner_kind := 'user';
  new.assigned_at := coalesce(new.assigned_at, now());
  return new;
end;
$$;

revoke execute on function public.fn_crm_lead_nasce_na_carteira() from public, anon, authenticated;

drop trigger if exists trg_crm_lead_nasce_na_carteira on public.crm_leads;
create trigger trg_crm_lead_nasce_na_carteira
  before insert on public.crm_leads
  for each row execute function public.fn_crm_lead_nasce_na_carteira();

notify pgrst, 'reload schema';

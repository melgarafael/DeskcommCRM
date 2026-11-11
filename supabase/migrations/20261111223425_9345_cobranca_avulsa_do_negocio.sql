-- manifest: **A cobrança avulsa nasce do negócio, presa a um tenant e sem gateway.** Cria `cobrancas_avulsas` — valor, moeda, vencimento e estado (`pendente`, `paga`, `cancelada`) — ancorada em `crm_leads` e/ou `conversations` da MESMA organização, com gatilho que recusa âncora de outro tenant, RLS por operação e a regra de que `paga` é do servidor: a sessão cria `pendente`, edita e cancela, nunca confirma pagamento. É o degrau que faltava entre a proposta (documento, `crm_proposals`) e o caixa (`financial_entries`): nenhum dos dois é uma COBRANÇA a receber. Sem gateway, sem tela, sem link de pagamento. Prova em `tests/invariants/cobranca-avulsa-do-negocio.test.ts`.
--
-- ═══ Por que a tabela é do CORE, e não de um módulo ═══
--
-- O único "a receber" por tenant que existe hoje é `honorarios_parcelas`
-- (migration 0480), que só existe depois de o administrador instalar o módulo
-- de advocacia — e é uma parcela de contrato de honorários, não uma cobrança
-- qualquer. A issue #4058 pede cobrar DENTRO da conversa, em qualquer segmento:
-- se esta tabela fosse de módulo, todo tenant que não é escritório de advocacia
-- continuaria sem poder cobrar. Core, portanto.
--
-- ═══ Por que o estado é só três, e "vencida" não está aqui ═══
--
-- `vencida` é DERIVÁVEL: `pendente` com `vencimento` no passado. Guardá-la
-- criaria duas verdades sobre a mesma linha — o relógio e a coluna — e a coluna
-- ficaria para trás no primeiro dia em que ninguém rodasse a régua. Quem exibe
-- calcula (ver `estadoExibido` em `lib/cobranca/avulsa.ts`); o banco guarda o
-- que só o banco sabe. Mesmo raciocínio de `cobranca_assinaturas`, que também
-- não guarda `suspensa`: a suspensão mora em `organizations.status`.
--
-- ═══ Por que `paga` é do servidor ═══
--
-- Sem gateway nesta fatia, quem confirma pagamento é uma pessoa olhando o
-- extrato — e é exatamente aí que a sessão do navegador vira a porta larga: com
-- a anon key + JWT do atendente, o PostgREST alcança esta tabela direto (o
-- mesmo motivo documentado na 0464). Um `PATCH` com `estado: 'paga'` seria um
-- "recebi" sem dinheiro. O gatilho abaixo recusa, e a policy só deixa a sessão
-- escrever em `pendente`. Quem confirma é `service_role`, na fatia do gateway.
--
-- Idempotente: `create ... if not exists`, `create or replace function`,
-- `drop ... if exists` antes de cada policy e gatilho. Espelhado no apêndice do
-- `supabase/baseline.sql`.

create table if not exists public.cobrancas_avulsas (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- ── A ÂNCORA: é isto que faz a cobrança ser "do negócio" e não um número solto
  --
  -- `set null`, e não `cascade`: a cobrança é registro financeiro e sobrevive à
  -- linha operacional que a originou — a mesma decisão de
  -- `financial_entries.sale_id` e de `honorarios_parcelas.financial_entry_id`.
  -- O que NÃO se admite é nascer sem âncora nenhuma (constraint abaixo): uma
  -- cobrança sem negócio e sem conversa é um valor no vácuo, e ninguém sabe de
  -- quem cobrar depois.
  lead_id uuid references public.crm_leads(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,

  descricao text not null,
  -- `_cents` + `moeda`, a regra do CLAUDE.md. Positivo: cobrança de zero ou
  -- negativa é estorno disfarçado, e estorno não é esta tabela.
  valor_cents bigint not null,
  moeda text not null default 'BRL',
  -- Data, não timestamp: "vence em 10/12" é o que se combina com o cliente. O
  -- fuso entra na hora de exibir, não no dado.
  vencimento date,

  estado text not null default 'pendente',

  -- As datas de desfecho existem separadas de propósito: `pago_em` responde
  -- "quando caiu" mesmo depois de a linha ser cancelada por engano e reaberta,
  -- e dar baixa e cancelar são fatos diferentes com autores diferentes.
  pago_em timestamptz,
  cancelada_em timestamptz,

  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cobrancas_avulsas_descricao_nao_vazia
    check (length(btrim(descricao)) > 0),
  constraint cobrancas_avulsas_valor_positivo
    check (valor_cents > 0),
  constraint cobrancas_avulsas_moeda_iso
    check (moeda ~ '^[A-Z]{3}$'),
  constraint cobrancas_avulsas_estado_valido
    check (estado in ('pendente', 'paga', 'cancelada')),
  -- `paga` sem data e data sem `paga` são a mesma linha contada duas vezes.
  constraint cobrancas_avulsas_paga_tem_data
    check ((estado = 'paga') = (pago_em is not null)),
  constraint cobrancas_avulsas_cancelada_tem_data
    check ((estado = 'cancelada') = (cancelada_em is not null)),
  -- O piso de âncora: negócio OU conversa. Contato sozinho não basta — a
  -- conversa é onde a cobrança é enviada e o negócio é o que ela vale.
  constraint cobrancas_avulsas_tem_ancora
    check (lead_id is not null or conversation_id is not null)
);

-- A lista da tela do negócio e a do contato, na ordem em que se cobra.
create index if not exists cobrancas_avulsas_org_lead_idx
  on public.cobrancas_avulsas (organization_id, lead_id)
  where lead_id is not null;
create index if not exists cobrancas_avulsas_org_conversa_idx
  on public.cobrancas_avulsas (organization_id, conversation_id)
  where conversation_id is not null;
-- O que está em aberto por vencimento — a pergunta que a fatia seguinte faz.
create index if not exists cobrancas_avulsas_org_estado_venc_idx
  on public.cobrancas_avulsas (organization_id, estado, vencimento);

comment on table public.cobrancas_avulsas is
  'Cobrança avulsa de um tenant contra o próprio cliente, ancorada em negócio (crm_leads) e/ou conversa: valor, moeda, vencimento e estado (pendente/paga/cancelada). NÃO é a assinatura da instalação (cobranca_assinaturas), não é proposta (crm_proposals) e não é lançamento de caixa (financial_entries). "vencida" é derivada de pendente + vencimento no passado, nunca gravada. Escrita: sessão só em pendente; confirmar pagamento é do service_role. Migration 9345, issue #4058.';
comment on column public.cobrancas_avulsas.estado is
  'pendente = cobrança emitida e não paga; paga = pagamento confirmado pelo servidor (pago_em obrigatório); cancelada = desfeita antes do pagamento (cancelada_em obrigatório). "vencida" NÃO é estado: é pendente com vencimento no passado.';
comment on column public.cobrancas_avulsas.pago_em is
  'Quando o pagamento foi confirmado. Só o service_role grava — junto com estado = paga, e o gatilho recusa a sessão que tente qualquer um dos dois.';

-- ─── a âncora não cruza tenant ───────────────────────────────────────────────
--
-- RLS filtra a linha pelo `organization_id` DELA. Se o INSERT trouxer
-- `organization_id` = A e `lead_id` de B, a policy passa (a coluna da linha é A)
-- e a cobrança de A aponta para o negócio do vizinho — o mesmo buraco que a
-- 0464 fechou em `crm_proposal_items` com `fn_verificar_org_do_item_da_proposta`,
-- e que aqui vale para três FKs. Não há FK composta que amarre as duas colunas,
-- então a trava é gatilho.
--
-- ⚠️ `security definer` NÃO é decoração: medido no primeiro verde desta fatia.
-- Com a função INVOKER, a busca do dono do negócio roda com o papel da SESSÃO e
-- cai na RLS de `crm_leads` — o attendente de B não enxerga o lead de A, o
-- `select ... into v_org` devolve NULL e a comparação dá mismatch. O insert
-- cruzado era recusado (bom), mas pelo motivo errado, e o MESMO mecanismo
-- recusaria insert LEGÍTIMO de um attendente que não enxerga o negócio por
-- visibilidade (`visibility_mode = 'own'`). A consistência de tenant é decisão
-- do banco, não da visibilidade de quem chama: roda como dono da função.
create or replace function public.fn_verificar_org_da_cobranca_avulsa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if new.lead_id is not null then
    select organization_id into v_org from public.crm_leads where id = new.lead_id;
    if v_org is distinct from new.organization_id then
      raise exception 'cobranca_lead_org_mismatch' using errcode = '23514';
    end if;
  end if;

  if new.conversation_id is not null then
    select organization_id into v_org from public.conversations where id = new.conversation_id;
    if v_org is distinct from new.organization_id then
      raise exception 'cobranca_conversa_org_mismatch' using errcode = '23514';
    end if;
  end if;

  if new.contact_id is not null then
    select organization_id into v_org from public.contacts where id = new.contact_id;
    if v_org is distinct from new.organization_id then
      raise exception 'cobranca_contato_org_mismatch' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_verificar_org_da_cobranca_avulsa() from public, anon, authenticated, service_role;

drop trigger if exists trg_cobrancas_avulsas_org_consistente on public.cobrancas_avulsas;
create trigger trg_cobrancas_avulsas_org_consistente
  before insert or update on public.cobrancas_avulsas
  for each row execute function public.fn_verificar_org_da_cobranca_avulsa();

-- ─── "recebi" não se escreve pela sessão ─────────────────────────────────────
--
-- Policy permissiva não vê o `old`, então a TRANSIÇÃO não cabe nela: é aqui.
-- Vale para a sessão (`authenticated`/`anon`) e não para `service_role` nem
-- para `security definer` — `current_user` delas não é o da sessão. INVOKER de
-- propósito, como `fn_crm_proposals_transicao_da_sessao` e `fn_meet_stamp`.
create or replace function public.fn_cobranca_avulsa_paga_e_do_servidor()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  -- o que o CANCELAMENTO pode tocar; todo o resto tem de ficar idêntico
  v_cancelamento constant text[] := array['estado', 'cancelada_em', 'updated_at'];
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.estado <> 'pendente' or new.pago_em is not null or new.cancelada_em is not null then
      raise exception 'cobranca_nasce_pendente' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.pago_em is not null or new.estado = 'paga' then
    raise exception 'cobranca_paga_e_do_servidor' using errcode = '42501';
  end if;

  if new.estado = 'cancelada'
     and (to_jsonb(new) - v_cancelamento) is distinct from (to_jsonb(old) - v_cancelamento) then
    raise exception 'cobranca_cancelamento_nao_muda_o_valor' using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_cobranca_avulsa_paga_e_do_servidor() from public, anon;

drop trigger if exists trg_cobrancas_avulsas_paga_e_do_servidor on public.cobrancas_avulsas;
create trigger trg_cobrancas_avulsas_paga_e_do_servidor
  before insert or update on public.cobrancas_avulsas
  for each row execute function public.fn_cobranca_avulsa_paga_e_do_servidor();

-- ─── RLS POR OPERAÇÃO, espelhando o que uma rota faria ───────────────────────
alter table public.cobrancas_avulsas enable row level security;

-- Leitura: qualquer papel da organização (quem atende precisa ver o que foi
-- cobrado), com o bypass de suporte da plataforma no molde de `crm_proposals`.
drop policy if exists cobrancas_avulsas_select on public.cobrancas_avulsas;
create policy cobrancas_avulsas_select on public.cobrancas_avulsas
  for select using (
    (organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin()
  );

-- Emitir: `agent`, e só `pendente` — cobrança nasce em aberto, nunca quitada.
drop policy if exists cobrancas_avulsas_insert on public.cobrancas_avulsas;
create policy cobrancas_avulsas_insert on public.cobrancas_avulsas
  for insert
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent')
              and estado = 'pendente');

-- Editar/cancelar: só o que ainda está em aberto. A linha paga sai do alcance
-- da sessão por completo (nem leitura de UPDATE), e o gatilho acima cobre a
-- transição que a policy não vê.
drop policy if exists cobrancas_avulsas_update on public.cobrancas_avulsas;
create policy cobrancas_avulsas_update on public.cobrancas_avulsas
  for update
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'agent')
         and estado = 'pendente')
  with check (organization_id in (select public.fn_user_org_ids())
              and public.fn_role_at_least(organization_id, 'agent')
              and estado in ('pendente', 'cancelada'));

-- Apagar: `manager`, e só antes do pagamento — depois de paga é registro.
drop policy if exists cobrancas_avulsas_delete on public.cobrancas_avulsas;
create policy cobrancas_avulsas_delete on public.cobrancas_avulsas
  for delete
  using (organization_id in (select public.fn_user_org_ids())
         and public.fn_role_at_least(organization_id, 'manager')
         and estado = 'pendente');

-- O default ACL do Supabase concede tudo aos três papéis, e `GRANT` enumerado
-- só ACRESCENTA (CLAUDE.md, Migrations): o `revoke` explícito é o que protege
-- no Supabase real, não a lista do dump.
revoke all on public.cobrancas_avulsas from anon, authenticated;
grant select, insert, update, delete on public.cobrancas_avulsas to authenticated;
grant all on public.cobrancas_avulsas to service_role;

drop trigger if exists trg_cobrancas_avulsas_updated_at on public.cobrancas_avulsas;
create trigger trg_cobrancas_avulsas_updated_at
  before update on public.cobrancas_avulsas
  for each row execute function public.fn_set_updated_at();

notify pgrst, 'reload schema';

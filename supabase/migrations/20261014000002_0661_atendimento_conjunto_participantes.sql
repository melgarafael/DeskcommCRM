-- manifest: **Atendimento conjunto — participantes da conversa (issue #2542).** Hoje cada conversa tem dono único (`conversations.assigned_to_user_id`) e o sistema só sabe ASSUMIR, PASSAR e SOLTAR — não sabe DIVIDIR. Esta migration cria a peça que faltava: a tabela `conversation_participants` (tenant-aware, uma linha por convidado) e a UMA linha que faz o convidado VER a conversa — o ramo de participante no `SELECT` de `conversations` (`conversations_select`). O convidado passa a ler a conversa e as mensagens dela (que herdam o escopo por `exists`), sem tocar no dono: `assigned_to_user_id` não é escrito por nenhuma linha desta migration. RLS de leitura com o molde da 0291 (organização + papel `agent`+ + só a PRÓPRIA linha de participação), escrita `revoke all`/`grant select` — as rotas escrevem pelo service role. `left_at` marca a saída (soft delete): remover o participante tira o acesso sem apagar o fato de ele ter participado. Idempotente.
-- ---- participantes do atendimento conjunto (migration 0661) ----
--
-- Issue #2542 (proposta 💡). Situações (fechamento com dois perfis,
-- escalonamento sem troca de mão, onboarding, treinamento, supervisão, dois
-- departamentos) que hoje só a transferência (mão única) e a notes interna
-- (contexto, não co-atendimento) não resolvem.
--
-- ─── A decisão de desenho (e por que o DONO não muda) ──────────────────────
--
-- Entrar não é assumir. `conversation_participants` é aditiva: convidar NÃO
-- escreve `conversations.assigned_to_user_id`. O dono único continua sendo
-- quem pode FECHAR/TRANSFERIR; o convidado LÊ e RESPONDE. É o que permite o
-- cenário 2 (o N1 continua respondendo enquanto o N2 entra) — transferência
-- mataria isso, porque quem transfere sai.
--
-- ─── Por que o convidado VÊ: o ramo no SELECT de conversations ─────────────
--
-- `fn_can_view_conversation(org, assigned_to)` recebe os CAMPOS DA ROW e não o
-- id da conversa, então ampliá-la para participantes exigiria mudar a
-- assinatura e todos os chamadores (counts, notas, push). A peça mínima é a
-- policy: `conversations_select` ganha um `or exists (… participation ativa …)`.
-- `messages` NÃO precisa de ramo próprio: `messages_select` é
-- `exists (select 1 from conversations c where c.id = messages.conversation_id)`
-- e essa subconsulta roda sob a RLS de `conversations` — o convidado vê as
-- mensagens por herança, o MESMO mecanismo que a 0035 documenta.
--
-- ─── Por que a RLS de participantes NÃO cita `conversations` ───────────────
--
-- Se a policy de `conversation_participants` referenciasse `conversations`,
-- e `conversations_select` referencia `conversation_participants`, as duas se
-- chamariam mutuamente e o Postgres abortaria com `infinite recursion detected
-- in policy`. Então a policy de participantes responde só a pergunta SEGURA:
-- "esta linha é MINHA linha de participação?" (`user_id = auth.uid()`). Quem
-- precisa listar os participantes de uma conversa (a tela do dono) lê pelo
-- caminho do servidor, que revalida papel e organização — não pela RLS.
--
-- ─── Não emite tipo novo de `event_log` ───────────────────────────────────
--
-- Convidar/remover NÃO chama `emit_event`: um tipo novo obrigaria a mexer na
-- lista de `fn_event_log_e_registro` (#753) e a notificação do convite é a
-- fatia 3 da issue, declarada como pendência no PR. A trilha vive no
-- `api_audit_log` (`conversation.invited` / `conversation.participant_removed`).

create table if not exists public.conversation_participants (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  -- Quem convidou. `set null` e não `cascade`: perder quem convidou não pode
  -- apagar o fato de a participação existir.
  invited_by       uuid references auth.users(id) on delete set null,
  joined_at        timestamptz not null default now(),
  -- `null` = participação ATIVA. Preenchido = saiu (soft delete). A coluna
  -- existe porque remover tira o ACESSO sem apagar o histórico: "quem já
  -- participou desta conversa" continua respondível.
  left_at          timestamptz,
  -- Um vínculo por (conversa, pessoa). Reentrar é UPDATE (`left_at = null`),
  -- não INSERT novo — é o que sustenta o `on conflict` da rota.
  constraint conversation_participants_unico unique (conversation_id, user_id)
);

-- Auto-cura para o clone que já tenha uma versão anterior da tabela.
alter table public.conversation_participants add column if not exists invited_by uuid;
alter table public.conversation_participants add column if not exists joined_at timestamptz not null default now();
alter table public.conversation_participants add column if not exists left_at timestamptz;

-- Leitor: a lista do convidado — "as conversas em que eu participo". Filtra
-- `left_at is null` porque participação encerrada não é conversa dele.
create index if not exists participantes_por_usuario
  on public.conversation_participants (organization_id, user_id)
  where left_at is null;
-- Leitor: a tela do dono — "quem participa desta conversa".
create index if not exists participantes_por_conversa
  on public.conversation_participants (organization_id, conversation_id);

alter table public.conversation_participants enable row level security;

-- ── Privilégio: leitura pela sessão, escrita SÓ pelo servidor ──────────────
-- `revoke all` PRIMEIRO — o default ACL do baseline concede INSERT/UPDATE/
-- DELETE a `authenticated` a toda tabela nova; sem o revoke, a escrita de um
-- vínculo seria uma chamada PostgREST de qualquer membro.
revoke all    on public.conversation_participants from anon, authenticated;
grant  select on public.conversation_participants to authenticated;
grant  all    on public.conversation_participants to service_role;

-- ── RLS de leitura: organização + papel + É A MINHA LINHA ───────────────────
-- As três condições, e cada uma fecha uma porta:
--   · `fn_user_org_ids`    — o vizinho não lê (invariante cross-org);
--   · `fn_role_at_least`   — `viewer` não lê vínculo de atendimento;
--   · `user_id = auth.uid()` — cada um lê a PRÓPRIA participação, e só ela
--     (ver o cabeçalho: citar `conversations` aqui causaria recursão).
drop policy if exists tenant_isolation_conversation_participants_select on public.conversation_participants;
create policy tenant_isolation_conversation_participants_select
  on public.conversation_participants
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and user_id = auth.uid()
  );

-- ── O ramo que faz o convidado VER a conversa ──────────────────────────────
-- Recria `conversations_select` acrescentando SÓ o `or exists (…)`: a parte
-- `fn_can_view_conversation` fica byte a byte igual (a régua de visibilidade
-- continua sendo ELA; aqui só se ACRESCENTA a porta do participante).
-- O drop e o create vão num ÚNICO bloco DO: o update.sh aplica o baseline sem
-- ON_ERROR_STOP e em autocommit. Soltos, um create que falhasse depois do drop
-- deixaria `conversations` com RLS e SEM policy de SELECT — o inbox sumiria
-- para todos. Dentro do DO, a falha desfaz o drop e a policy anterior fica.
do $conversations_select$ begin
  drop policy if exists "conversations_select" on public.conversations;
  create policy "conversations_select" on public.conversations
    for select using (
      public.fn_can_view_conversation(organization_id, assigned_to_user_id)
      or exists (
        select 1
          from public.conversation_participants cp
         where cp.conversation_id = conversations.id
           and cp.organization_id = conversations.organization_id
           and cp.user_id = auth.uid()
           and cp.left_at is null
      )
    );
end $conversations_select$;

-- ── travas do suporte, depois de toda tabela nova (migration 0274) ─────────
-- `conversation_participants` nasce SERVER-ONLY na escrita (revoke de
-- anon/authenticated + grant select), então o ramo server-only da função lhe
-- dá ZERO policies `support_write_*` — o contrato mais restritivo.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';

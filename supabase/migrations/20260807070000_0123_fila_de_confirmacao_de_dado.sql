-- 0123 — o dado que o cliente diz na conversa espera confirmação humana
--
-- ═══ A DECISÃO (spec 17 §4b) ═══
--
-- O Operador PROPÕE; um humano CONFIRMA. A IA não grava dado de contato direto.
--
-- Não é cautela abstrata: `contactPatchSchema` aceita e-mail livre e o handler
-- não lia o valor anterior antes de sobrescrever. Um e-mail dito de brincadeira
-- substituiria o correto e o valor antigo não existiria em lugar nenhum. Note a
-- assimetria que ficaria sem esta fila: o `pushName` do WhatsApp é CONGELADO
-- pelo `coalesce` do upsert, e o e-mail dito ao robô seria sobrescrevível à
-- vontade.
--
-- ═══ POR QUE UMA TABELA, E NÃO A CENTRAL DE AVISOS ═══
--
-- `agent_inbox_items` tem 10 colunas e nenhuma delas guarda um par
-- campo/valor: `title` e `body` são prosa para humano ler, e `ref_id` é ponteiro
-- sem dizer qual campo nem qual valor novo. O único PATCH dela aceita `{status}`
-- e nada mais. Acrescentar um jsonb ali converteria uma tabela de AVISO em
-- tabela de TRABALHO e faria "marcar como resolvido" conviver com "gravar o
-- dado" no mesmo campo `status` — dois significados num estado só, numa tabela
-- usada por 16 tipos de aviso.
--
-- ═══ A FORMA É COPIADA, NÃO INVENTADA ═══
--
-- `crm_lead_reactivations` (wave 7) já é uma fila de proposta com prazo,
-- decisão datada, decisor e idempotência por índice parcial — e já rodou em
-- produção. Esta tabela é a mesma forma com a chave certa: a proposta é sobre a
-- PESSOA (um contato tem N negócios), então a chave é `contact_id` + campo.
--
-- Estender aquela tabela seria usar a chave errada E contrariar o comentário
-- escrito no campo `draft` dela ("nenhum dado do lead entra aqui por cópia").
-- Reusa-se a FORMA, não a linha.

create table if not exists public.contact_field_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,

  -- QUAL campo. Vocabulário FECHADO por CHECK: o que entra aqui vira escrita em
  -- `contacts`, e campo livre deixaria a IA propor qualquer coluna.
  campo text not null,

  -- O valor proposto e o que existia quando a proposta nasceu. O segundo é o
  -- `from` que a regra L-06 exige — e existe ANTES da confirmação justamente
  -- para que a decisão seja tomada com os dois lados à vista.
  valor_proposto text not null,
  valor_anterior text,

  -- DE ONDE veio, para quem decide poder conferir em vez de acreditar.
  -- `trecho` é o que a pessoa escreveu; sem ele a confirmação é um ato de fé.
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  trecho text,
  proposed_by_agent_id uuid references public.ai_agents(id) on delete set null,

  status text not null default 'pending',

  -- Carimbados pelo BANCO, nunca pelo processo — mesma razão da 0081: instantes
  -- comparados entre si vêm do mesmo relógio.
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by_user_id uuid references auth.users(id) on delete set null,
  -- Por que foi recusada. É o LAÇO DE RETORNO (invariante 7): proposta que o
  -- humano rejeita diz onde a IA erra, e sem o motivo o sinal é só um número.
  motivo_recusa text,
  updated_at timestamptz not null default now()
);

comment on table public.contact_field_proposals is
  'Dado do contato que a IA ouviu na conversa e propôs — aguardando confirmação humana (spec 17 §4b). SEMPRE com prazo: proposta que ninguém decide vira badge permanente, que simula atenção e adia a decisão. No vencimento sai da tela e vira item de caixa.';

alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_campo_check;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_campo_check check (
    campo = any (array['email', 'name', 'phone_number']::text[])
  );

alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_status_check;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_status_check check (
    status = any (array['pending', 'accepted', 'dismissed', 'expired']::text[])
  );

-- Prazo no futuro: proposta que nasce vencida vira item de caixa no primeiro
-- tick e ninguém entende de onde veio.
alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_prazo_no_futuro;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_prazo_no_futuro check (expires_at > proposed_at);

-- Decisão e decisor andam juntos. Status decidido sem `decided_at` é registro
-- que não sabe dizer quando aconteceu — e é essa a pergunta que a auditoria faz.
alter table public.contact_field_proposals
  drop constraint if exists contact_field_proposals_decisao_datada;
alter table public.contact_field_proposals
  add constraint contact_field_proposals_decisao_datada check (
    (status = 'pending' and decided_at is null)
    or (status <> 'pending' and decided_at is not null)
  );

-- ⚠️ ESTE ÍNDICE É A IDEMPOTÊNCIA — não é otimização.
--
-- A IA vai ouvir o mesmo e-mail em dez mensagens seguidas. Sem ele, dez
-- propostas idênticas viram dez linhas e a tela do humano vira uma coluna de
-- repetições. `where not exists` no código NÃO substitui: é check-then-act, e
-- dois turnos concorrentes passam pela janela — o mesmo defeito que a 0027 veio
-- matar nos contatos.
--
-- PARCIAL: propostas decididas ficam como histórico e não bloqueiam a próxima. O
-- cliente pode corrigir o e-mail que ele mesmo deu errado, e impedir isso
-- deixaria a correção sem caminho.
create unique index if not exists uq_contact_field_proposals_uma_viva
  on public.contact_field_proposals (organization_id, contact_id, campo)
  where status = 'pending';

-- O worker de vencimento varre por aqui.
create index if not exists idx_contact_field_proposals_vencendo
  on public.contact_field_proposals (organization_id, expires_at)
  where status = 'pending';

alter table public.contact_field_proposals enable row level security;

drop policy if exists tenant_isolation_contact_field_proposals_all on public.contact_field_proposals;
create policy tenant_isolation_contact_field_proposals_all on public.contact_field_proposals
  for all
  using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

revoke all on public.contact_field_proposals from anon;

-- `proposed_at` e `updated_at` vêm do banco.
create or replace function public.fn_carimba_proposta_de_dado()
  returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op = 'INSERT' then
    new.proposed_at := now();
  end if;
  new.updated_at := now();
  return new;
end$$;

revoke all on function public.fn_carimba_proposta_de_dado() from public, anon;

drop trigger if exists trg_contact_field_proposals_carimbo on public.contact_field_proposals;
create trigger trg_contact_field_proposals_carimbo
  before insert or update on public.contact_field_proposals
  for each row
  execute function public.fn_carimba_proposta_de_dado();

-- ---- LGPD: anonimizar o contato apaga as propostas dele ----
--
-- Sem isto, anonimizar um contato deixaria o e-mail dele VIVO dentro de uma
-- proposta pendente — PII sobrevivendo ao direito de esquecimento numa tabela
-- que ninguém lembraria de olhar.
--
-- ⚠️ TRIGGER NO ESTADO, não chamada dentro do cascade — e a escolha importa.
-- Há mais de um caminho que anonimiza: `fn_lgpd_cascade_redact_contact` (o
-- cascade completo) e `/api/v1/lgpd/anonymize` (a rota direta), e amanhã pode
-- haver um DBA fazendo à mão. Pendurar a limpeza em UM deles deixaria os outros
-- vazando; pendurar no FATO (`is_anonymized` virou true) cobre todos, inclusive
-- os que ainda não existem. É também a diferença entre editar uma função de 180
-- linhas vinda de dump — com o risco que isso traz — e acrescentar 10.
--
-- As propostas são APAGADAS, não redigidas: diferente da timeline, aqui não há
-- histórico a preservar (proposta não decidida nunca virou fato) e o conteúdo é
-- integralmente dado pessoal.
create or replace function public.fn_apaga_propostas_de_contato_anonimizado()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
begin
  delete from public.contact_field_proposals where contact_id = new.id;
  return new;
end$$;

revoke all on function public.fn_apaga_propostas_de_contato_anonimizado() from public;
revoke execute on function public.fn_apaga_propostas_de_contato_anonimizado() from anon;
revoke execute on function public.fn_apaga_propostas_de_contato_anonimizado() from authenticated;

drop trigger if exists trg_contacts_anonimizado_limpa_propostas on public.contacts;
create trigger trg_contacts_anonimizado_limpa_propostas
  after update of is_anonymized on public.contacts
  for each row
  when (new.is_anonymized = true and coalesce(old.is_anonymized, false) = false)
  execute function public.fn_apaga_propostas_de_contato_anonimizado();

notify pgrst, 'reload schema';

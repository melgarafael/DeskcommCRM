-- manifest: **O link de pagamento do cliente final passa a ser REGISTRADO na conversa (#3509, degrau 1).** Tabela `pagamento_recebimentos` — `pendente → paga | expirada | cancelada | estornada`, `provedor`, `external_id`, `valor_cents`, `conversa`/`mensagem`/`negócio` de origem — com RLS por organização (leitura e escrita para `agent+`, `anon` revogado) e índice único `(organization_id, provedor, external_id)` que é a IDEMPOTÊNCIA do aviso de pagamento. Nenhuma chamada ao provedor: a credencial é do dono da conta e não existe neste degrau.
--
-- 9047 — registro do link e recebimento do aviso de "pago" (issue #3509).
--
-- ═══ O QUE ESTA MIGRATION ENTREGA, E O QUE ELA RECUSA ═══
--
-- Hoje a atendente gera o link no aplicativo do meio de pagamento, cola na
-- conversa, confere no extrato e move o negócio à mão — três passos manuais, e o
-- do meio (conferir) é o que ninguém faz quando a fila aperta. O degrau 1 grava
-- o link como DADO na conversa e deixa o aviso do provedor marcar "pago" sem
-- ninguém digitar nada.
--
-- O que esta migration NÃO faz, de propósito: não chama a API da InfinitePay,
-- não guarda credencial, não concilia extrato, não move caixa. Sem contrato e sem
-- token, "gerar o link" é conversa para o dono da conta — e fingir um cliente de
-- API seria pior que não ter: um adaptador inventado passa nos testes e mente em
-- produção.
--
-- ═══ POR QUE TABELA, E NÃO SÓ `messages.metadata` ═══
--
-- O metadado na mensagem é o que a conversa MOSTRA (`pagamento: {provedor, id,
-- valor, status}`), e ele é ponteiro, não verdade. A verdade precisa de uma
-- linha que o aviso do provedor consiga encontrar sem varrer mensagem, e de um
-- índice ÚNICO que transforme "aviso repetido" em 23505 em vez de em segunda
-- confirmação. `messages` não serve para nenhuma das duas: não tem chave por
-- (organização, id do provedor) e um UPDATE nela é o que a anonimização zera
-- (passo 3 da cascata) — registro de pagamento não pode depender de metadado que
-- a LGPD apaga por desenho.
--
-- ═══ A IDEMPOTÊNCIA É O ÍNDICE, E O ESTADO É O `status` ═══
--
-- `unique (organization_id, provedor, external_id)`: o provedor reentrega o
-- aviso, e a segunda entrega não cria linha nova. E a confirmação é
-- compare-and-set (`update ... where id = ? and status = 'pendente'`), então
-- duas entregas SIMULTÂNEAS do mesmo evento também só movem o negócio uma vez:
-- quem chega depois atualiza zero linhas e sai sem efeito. Checar com `select`
-- antes seria check-then-act — a lição da 0027.
--
-- ═══ `lead_id` NULO É ESTADO LEGÍTIMO ═══
--
-- Nem todo link se prende a um negócio (cliente avulso, conversa sem card). O
-- aviso de pagamento continua valendo — marca `paga` e não move nada; quem move
-- é o humano. `on delete set null` porque apagar o negócio não pode apagar o
-- pagamento que a pessoa fez.
--
-- ═══ LGPD ═══
--
-- A linha NÃO guarda nada que identifique o titular: sem nome, sem telefone, sem
-- e-mail, sem CPF e sem o corpo da mensagem. `external_id` é o id do pagamento no
-- provedor e o valor é o valor. Os dois vínculos (`conversation_id`,
-- `message_id`) existem para a conversa mostrar o registro; a anonimização zera o
-- corpo e o `metadata` da mensagem (passo 3 da cascata), e o que sobra aqui é o
-- fato comercial — o mesmo critério do `orders` (valor e status preservados,
-- identidade zerada).

create table if not exists public.pagamento_recebimentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Onde o link foi REGISTRADO. A conversa é obrigatória (o registro nasce na
  -- conversa, é o que a atendente vê); a mensagem pode desaparecer sem levar o
  -- registro do pagamento junto.
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete set null,

  -- O negócio que o aviso de "pago" pode mover. Nulo quando não há card aberto.
  lead_id uuid references public.crm_leads(id) on delete set null,

  -- `infinitepay` hoje. Texto sem CHECK fechado: provedor novo é uma linha de
  -- vocabulário no TypeScript, não uma migration que reescreve constraint (a
  -- doutrina da 0772 para `campo`). A FORMA é conferida abaixo.
  provedor text not null,

  -- O id do pagamento NO PROVEDOR. É a chave que o aviso traz e o que o
  -- índice único deduplica.
  external_id text not null,

  valor_cents bigint not null,
  -- Moeda ISO da cobrança. Três letras, maiúsculas: `crm_leads.currency` usa a
  -- mesma forma.
  moeda text not null default 'BRL',

  status text not null default 'pendente',
  -- Quando o provedor avisou que pagou. Gravado pela ROTA do aviso, com o
  -- relógio do processo: o PostgREST não expõe `now()` num UPDATE e um `default`
  -- só valeria no INSERT. A coerência com o `status` é o CHECK abaixo quem cobra
  -- — e é ela que importa aqui ("pago" tem data, "pendente" não tem).
  pago_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pagamento_recebimentos is
  'Link de pagamento do CLIENTE FINAL registrado na conversa e o desfecho que o aviso do provedor trouxe (issue #3509, degrau 1). O metadado `messages.metadata.pagamento` é PONTEIRO para esta linha, nunca a verdade — a verdade é o `status` aqui, e a idempotência do aviso é o índice único (organization_id, provedor, external_id). NÃO guarda credencial do provedor, NÃO chama a API dele e não tem dado pessoal do titular: só provedor, id externo, valor e estado.';

-- ⚠️ COMENTÁRIO DE COLUNA DENTRO DA GUARDA: `comment on column` em tabela ausente
-- é ERRO, não aviso, e abortaria a migration inteira num clone que aplica só
-- parte da cadeia.
do $$
begin
  if to_regclass('public.pagamento_recebimentos') is not null then
    comment on column public.pagamento_recebimentos.status is
      'Estado do recebimento: pendente → paga | expirada | cancelada | estornada. A confirmação é compare-and-set (where status = ''pendente''), então o aviso repetido do provedor não move o negócio duas vezes (issue #3509).';
    comment on column public.pagamento_recebimentos.external_id is
      'Id do pagamento NO PROVEDOR. Junto com organization_id e provedor forma o índice único que deduplica o aviso. Não é dado pessoal: é o identificador comercial do pagamento.';
    comment on column public.pagamento_recebimentos.lead_id is
      'Negócio que o aviso de "pago" move para a etapa de ganho, quando existe. Nulo é legítimo (link avulso, conversa sem card): o pagamento é registrado e o humano move.';
  end if;
end $$;

alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_status_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_status_check check (
    status = any (array['pendente', 'paga', 'expirada', 'cancelada', 'estornada']::text[])
  );

alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_valor_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_valor_check check (valor_cents > 0);

-- `paga` sem data é registro que não sabe dizer QUANDO pagou — e é essa a
-- pergunta que a conciliação vai fazer. O contrário também: data de pagamento em
-- recebimento que não está pago é mentira guardada.
alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_pago_datado_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_pago_datado_check check (
    (status = 'paga') = (pago_em is not null)
  );

alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_provedor_forma_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_provedor_forma_check check (
    provedor ~ '^[a-z][a-z0-9_]{2,31}$'
  );

alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_moeda_iso_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_moeda_iso_check check (moeda ~ '^[A-Z]{3}$');

-- ⚠️ ESTE ÍNDICE É A IDEMPOTÊNCIA DO AVISO — não é otimização.
--
-- O provedor reentrega o mesmo evento (é o comportamento normal de webhook), e
-- sem o único cada reentrega criaria uma linha nova, o negócio andaria de novo e
-- a conversa ganharia um aviso por tentativa. `where not exists` no código não
-- substitui: é check-then-act.
create unique index if not exists pagamento_recebimentos_provedor_externo_uniq
  on public.pagamento_recebimentos (organization_id, provedor, external_id);

-- A conversa lista os recebimentos dela (o balão mostra valor e estado).
create index if not exists pagamento_recebimentos_conversa_idx
  on public.pagamento_recebimentos (organization_id, conversation_id);

-- A varredura de pendentes por organização (o cron de conciliação futuro lê
-- daqui; hoje quem lê é a tela).
create index if not exists pagamento_recebimentos_status_idx
  on public.pagamento_recebimentos (organization_id, status);

drop trigger if exists trg_pagamento_recebimentos_updated_at on public.pagamento_recebimentos;
create trigger trg_pagamento_recebimentos_updated_at
  before update on public.pagamento_recebimentos
  for each row execute function public.fn_set_updated_at();

alter table public.pagamento_recebimentos enable row level security;

-- GRANTS EXPLÍCITOS, UM POR PAPEL, e não o default do `pg_dump`.
--
-- O `alter default privileges ... grant all on tables to anon` do baseline
-- alcança toda tabela nova, e a anon key vai para o browser: valor e estado de
-- pagamento de uma organização não podem ser lidos por ela. Mesmo desenho da
-- 0772 (`revoke all ... from anon` + policies por organização).
revoke all on public.pagamento_recebimentos from anon;
grant select, insert, update on public.pagamento_recebimentos to authenticated;
grant select, insert, update, delete on public.pagamento_recebimentos to service_role;

-- Leitura: quem enxerga a organização. O `exists` na conversa roda sob a RLS de
-- `conversations`, então o escopo de visibilidade do atendimento (o mesmo do
-- Inbox) vale aqui sem uma segunda régua.
drop policy if exists tenant_isolation_pagamento_recebimentos_select on public.pagamento_recebimentos;
create policy tenant_isolation_pagamento_recebimentos_select on public.pagamento_recebimentos
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and exists (
        select 1 from public.conversations c
         where c.id = pagamento_recebimentos.conversation_id
           and c.organization_id = pagamento_recebimentos.organization_id
      )
  );

-- Escrita: `agent` para cima. Quem REGISTRA o link é a atendente; `viewer` não.
-- A confirmação de pagamento NÃO passa por aqui — quem marca `paga` é o webhook,
-- com o admin client (service_role), porque não existe sessão de usuário num
-- aviso de provedor.
drop policy if exists tenant_isolation_pagamento_recebimentos_write on public.pagamento_recebimentos;
create policy tenant_isolation_pagamento_recebimentos_write on public.pagamento_recebimentos
  for all to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      -- O vínculo tem de ser da MESMA organização: sem isto, um `insert` com o
      -- organization_id da própria empresa e o conversation_id de outra gravaria
      -- uma linha que ninguém enxerga (a policy de leitura confere o par). O
      -- caminho da tela já valida a conversa antes, mas guarda de RLS não confia
      -- na camada de cima.
      and exists (
        select 1 from public.conversations c
         where c.id = pagamento_recebimentos.conversation_id
           and c.organization_id = pagamento_recebimentos.organization_id
      )
  );

-- ⚠️ AS TRÊS TRAVAS DO SUPORTE, DEPOIS DA TABELA.
-- A varredura de `fn_aplicar_travas_de_suporte()` percorre `pg_class` no momento em
-- que roda; a última chamada do baseline acontece ANTES desta tabela nascer, então
-- sem esta linha a tabela fica sem `support_write_insert/update/delete` e o
-- invariante `travas-de-suporte-cobrem-toda-tabela-na-instalacao` reprova — foi
-- exatamente o que o `test:db` mediu (369 travas contra 372 esperadas).
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';

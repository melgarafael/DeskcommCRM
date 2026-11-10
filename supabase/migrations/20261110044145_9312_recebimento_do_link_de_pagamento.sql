-- manifest: **O link de pagamento do cliente final ganha um recebimento na conversa (#3509, degrau 1).** Tabela `pagamento_recebimentos` — `pendente → paga | expirada | cancelada | estornada`, `provedor`, `valor_cents`, conversa e negócio de origem, e o HASH do endereço de aviso próprio de cada recebimento — com leitura por organização e escrita só pelo servidor (`authenticated` lê, não escreve; `anon` revogado). O aviso do provedor acha a linha pelo id que vem na URL dele; o id do pagamento no provedor (`external_id`) é gravado pelo aviso e o índice único `(organization_id, provedor, external_id)` é a idempotência. Nenhuma chamada ao provedor e nenhum segredo da instalação.
--
-- 9312 — registro do recebimento e aviso de "pago" (issue #3509). Trabalho
-- original de @webtecnica no #3590 (lá numerado 9047).
--
-- ═══ O QUE ESTA MIGRATION ENTREGA, E O QUE ELA RECUSA ═══
--
-- Hoje a atendente gera o link no aplicativo do meio de pagamento, manda na
-- conversa, confere no extrato e move o negócio à mão — três passos manuais, e o
-- do meio (conferir) é o que ninguém faz quando a fila aperta. O degrau 1 cria
-- o recebimento ANTES do link: o CRM devolve um endereço de aviso próprio deste
-- recebimento, a atendente o cola como "URL do Webhook" ao criar o link no
-- provedor, e o aviso de "pago" marca o recebimento sem ninguém digitar nada.
--
-- O que esta migration NÃO faz, de propósito: não chama a API do provedor, não
-- guarda credencial, não concilia extrato, não move caixa.
--
-- ═══ COMO O AVISO ACHA A LINHA, E POR QUE NÃO PELO ID DO PROVEDOR ═══
--
-- O id do pagamento que o provedor manda no aviso (`invoice_slug`, medido na
-- InfinitePay em 31/10 e 03/11) não existe quando o link é criado, e o que a
-- atendente digitaria não é o que volta. Quem volta, em todo aviso e nos dois
-- tipos de link, é a URL que nós configuramos: o id do recebimento e o segredo
-- vão nela. O segredo é DESTE recebimento (`aviso_token_hash`): não há segredo
-- da instalação dividido entre empresas, e vazar a URL de um pagamento não abre
-- o de mais ninguém. Só o hash fica no banco; o texto do segredo é mostrado uma
-- vez, no registro.
--
-- ═══ A IDEMPOTÊNCIA ═══
--
-- A confirmação é compare-and-set (`update ... where id = ? and status =
-- 'pendente'`): o provedor reentrega o aviso (5 tentativas medidas em 03/11), e
-- a segunda entrega atualiza zero linhas e sai sem efeito. O índice único em
-- `(organization_id, provedor, external_id)` impede o MESMO pagamento do
-- provedor de confirmar dois recebimentos.
--
-- ═══ QUEM ESCREVE ═══
--
-- Só o servidor (`service_role`): o registro passa pela rota da conversa, que
-- confere papel e organização, e a confirmação passa pelo aviso. A sessão do
-- usuário LÊ e não escreve — é o aviso do provedor que diz que pagou, e nenhum
-- outro caminho.
--
-- ═══ `lead_id` NULO É ESTADO LEGÍTIMO ═══
--
-- Nem todo recebimento se prende a um negócio (cliente avulso, conversa sem
-- card). O aviso continua valendo — marca `paga` e não move nada. `on delete set
-- null` porque apagar o negócio não pode apagar o pagamento que a pessoa fez.
--
-- ═══ LGPD ═══
--
-- A linha NÃO guarda nada que identifique o titular: sem nome, telefone,
-- e-mail, CPF nem corpo de mensagem. É o fato comercial — o mesmo critério do
-- `orders` (valor e status preservados, identidade zerada).

create table if not exists public.pagamento_recebimentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- Onde o recebimento foi REGISTRADO: a conversa que a atendente vê.
  conversation_id uuid not null references public.conversations(id) on delete cascade,

  -- O negócio que o aviso de "pago" pode mover. Nulo quando não há card aberto.
  lead_id uuid references public.crm_leads(id) on delete set null,

  -- `infinitepay` hoje. Texto sem CHECK fechado: provedor novo é uma linha de
  -- vocabulário no TypeScript, não uma migration que reescreve constraint. A
  -- FORMA é conferida abaixo.
  provedor text not null,

  -- O id do pagamento NO PROVEDOR, gravado pelo aviso que confirma. Nulo
  -- enquanto ninguém pagou.
  external_id text,

  -- sha256 (hex) do segredo que vai na URL do aviso deste recebimento.
  aviso_token_hash text not null,

  valor_cents bigint not null,
  moeda text not null default 'BRL',

  status text not null default 'pendente',
  -- Quando o provedor avisou que pagou. Gravado pela rota do aviso.
  pago_em timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pagamento_recebimentos is
  'Recebimento do CLIENTE FINAL registrado na conversa e o desfecho que o aviso do provedor trouxe (issue #3509, degrau 1). O aviso acha a linha pelo id na URL dele e prova a origem com o segredo deste recebimento (só o hash fica aqui). A verdade é o `status`; quem escreve é só o servidor. NÃO guarda credencial do provedor nem dado pessoal do titular.';

-- ⚠️ COMENTÁRIO DE COLUNA DENTRO DA GUARDA: `comment on column` em tabela ausente
-- é ERRO, não aviso.
do $$
begin
  if to_regclass('public.pagamento_recebimentos') is not null then
    comment on column public.pagamento_recebimentos.status is
      'Estado do recebimento: pendente → paga | expirada | cancelada | estornada. A confirmação é compare-and-set (where status = ''pendente''), então o aviso repetido do provedor não move o negócio duas vezes (issue #3509).';
    comment on column public.pagamento_recebimentos.external_id is
      'Id do pagamento NO PROVEDOR, gravado pelo aviso que confirmou. Junto com organization_id e provedor forma o índice único que impede um pagamento de confirmar dois recebimentos.';
    comment on column public.pagamento_recebimentos.aviso_token_hash is
      'sha256 (hex) do segredo que vai na URL do aviso deste recebimento. O texto do segredo é mostrado uma vez, no registro, e não fica no banco.';
    comment on column public.pagamento_recebimentos.lead_id is
      'Negócio que o aviso de "pago" move para a etapa de ganho, quando existe. Nulo é legítimo: o pagamento é registrado e o humano move.';
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

-- `paga` sem data é registro que não sabe dizer QUANDO pagou; data em
-- recebimento que não está pago é mentira guardada.
alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_pago_datado_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_pago_datado_check check (
    (status = 'paga') = (pago_em is not null)
  );

-- `paga` sem o id do provedor é pagamento que ninguém consegue conferir no extrato.
alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_pago_identificado_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_pago_identificado_check check (
    status <> 'paga' or external_id is not null
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

alter table public.pagamento_recebimentos
  drop constraint if exists pagamento_recebimentos_token_forma_check;
alter table public.pagamento_recebimentos
  add constraint pagamento_recebimentos_token_forma_check check (aviso_token_hash ~ '^[0-9a-f]{64}$');

-- ⚠️ ESTE ÍNDICE É PARTE DA IDEMPOTÊNCIA — não é otimização. Nulo não colide
-- (todo recebimento pendente tem `external_id` nulo).
create unique index if not exists pagamento_recebimentos_provedor_externo_uniq
  on public.pagamento_recebimentos (organization_id, provedor, external_id);

create index if not exists pagamento_recebimentos_conversa_idx
  on public.pagamento_recebimentos (organization_id, conversation_id);

create index if not exists pagamento_recebimentos_status_idx
  on public.pagamento_recebimentos (organization_id, status);

drop trigger if exists trg_pagamento_recebimentos_updated_at on public.pagamento_recebimentos;
create trigger trg_pagamento_recebimentos_updated_at
  before update on public.pagamento_recebimentos
  for each row execute function public.fn_set_updated_at();

alter table public.pagamento_recebimentos enable row level security;

-- GRANTS EXPLÍCITOS, UM POR PAPEL. O `alter default privileges ... grant all on
-- tables to anon` do baseline alcança toda tabela nova, e a anon key vai para o
-- browser. `authenticated` só lê: as duas portas de escrita são rotas do
-- servidor, e uma terceira pela REST seria um "pago" que o provedor não disse.
revoke all on public.pagamento_recebimentos from anon;
revoke all on public.pagamento_recebimentos from authenticated;
grant select on public.pagamento_recebimentos to authenticated;
grant select, insert, update, delete on public.pagamento_recebimentos to service_role;

-- Leitura: quem enxerga a organização. O `exists` na conversa roda sob a RLS de
-- `conversations`, então o escopo de visibilidade do atendimento vale aqui sem
-- uma segunda régua.
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

-- Sem policy de escrita: sem ela e sem o grant, a REST recusa por dois lados.
drop policy if exists tenant_isolation_pagamento_recebimentos_write on public.pagamento_recebimentos;

-- ⚠️ AS TRÊS TRAVAS DO SUPORTE, DEPOIS DA TABELA. A varredura de
-- `fn_aplicar_travas_de_suporte()` percorre `pg_class` no momento em que roda;
-- sem esta linha a tabela fica sem `support_write_insert/update/delete`.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

notify pgrst, 'reload schema';

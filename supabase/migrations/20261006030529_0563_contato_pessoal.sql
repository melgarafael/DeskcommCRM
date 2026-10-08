-- manifest: **Contato pessoal nasce no banco (spec 21, fatia 1): `contacts.is_personal` com default desligado, índice parcial, e o status de saída `personal` no CHECK de `campaign_recipients`.** A marca fica numa coluna nova de propósito (reutilizar `is_blocked` misturaria descadastro com pessoal na auditoria e nas regras — spec §3.1). Quem marcou/quando fica só em auditoria + timeline, sem coluna extra (spec §3.6). O gatilho 0397 NÃO é estendido de propósito (§12.1 do plano: trigger é invariante de dado; o roteiro `coletando` de pessoal é cancelado pelo código da rota de marcar). Idempotente: `add column if not exists`, `create index if not exists`, `drop constraint if exists` + `add`. Apêndice espelhado no fim do `baseline.sql`; `MANIFEST.md` é histórico e não recebe linha.

-- 0563 — contato pessoal: a coluna e a saída de campanha.
--
-- `is_personal boolean DEFAULT false NOT NULL` (espelha `is_blocked`): contato
-- nasce operacional, e só vira pessoal por gesto explícito de gerente/dono na
-- rota `POST /api/v1/contacts/[id]/personal` (spec 21 §3.2, decisão 1).
--
-- O status `personal` em `campaign_recipients` é SAÍDA PRÓPRIA, não `opted_out`:
-- reutilizar `opted_out` inflaria a taxa "pediu para parar" com quem nunca pediu
-- (D7 do plano). Entra no CHECK aqui e em `STATUS_DO_DESTINATARIO` +
-- `TERMINAIS_DE_DESPACHO` (`lib/campanhas/tipos.ts`) juntos — um lado sem o
-- outro é `23514` num caminho pouco exercitado.
--
-- Medido no CI pelo invariante ao lado
-- (`tests/invariants/contato-pessoal-coluna.test.ts`): coluna existe com default
-- false, índice parcial existe, CHECK aceita `personal`.

alter table public.contacts
  add column if not exists is_personal boolean default false not null;

comment on column public.contacts.is_personal is
  'Contato de vida pessoal (spec 21): escondido da operação e inutilizado para envio. Só gerente/dono marca e desmarca, pela rota personal; quem/quando fica em auditoria + timeline, nunca aqui.';

create index if not exists idx_contacts_org_personal
  on public.contacts (organization_id)
  where (is_personal = true);

-- A saída de campanha de quem vira pessoal: marca a saída sem remover a linha,
-- como o pedido de saída faz — a métrica perde o elegível, nunca o denominador.
alter table public.campaign_recipients
  drop constraint if exists campaign_recipients_status_check;

alter table public.campaign_recipients
  add constraint campaign_recipients_status_check check (status in (
    'pending','queued','sending','sent','delivered','read','replied',
    'failed','skipped','cancelled','opted_out','personal'
  ));

notify pgrst, 'reload schema';

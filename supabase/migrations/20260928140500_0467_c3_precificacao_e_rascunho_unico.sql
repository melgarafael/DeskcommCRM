-- 0467 — Onda C3 da spec de Propostas (2026-09-23): D5 (raiz: preço vindo do
-- catálogo no servidor) + §5.1/5.2 (pricing_status, item sem preço) + §5.3
-- (um rascunho aberto por negócio, com dedupe do que já existe).

-- ── §5.2 — item sem preço ("a definir") ─────────────────────────────────────
-- O CHECK crm_proposal_items_preco_nao_negativo (preco_unitario_cents >= 0)
-- continua valendo quando houver valor: em Postgres, CHECK só falha quando a
-- expressão avalia para FALSE, e `NULL >= 0` avalia NULL (passa). Não precisa
-- reescrever a constraint.
alter table public.crm_proposal_items alter column preco_unitario_cents drop not null;

-- ── §5.1 — pricing_status ────────────────────────────────────────────────────
alter table public.crm_proposals add column if not exists pricing_status text
  not null default 'missing'
  check (pricing_status in ('missing', 'catalog', 'manual', 'approved'));
comment on column public.crm_proposals.pricing_status is
  'C3/§5.1: missing (algum item sem preço, PDF mostra "a definir", envio recusado), '
  'catalog (todo item veio do catálogo), manual (algum item com preço digitado). '
  '"approved" é reservado para fluxo de aprovação fora desta onda — nunca escrito aqui.';

-- Backfill idempotente: toda linha que já existe é recalculada a partir dos
-- próprios itens (genérico — nenhum id de tenant hardcoded, doutrina de
-- migrations item 4). Antes desta migration TODO item tinha preço obrigatório,
-- então o resultado aqui só pode ser 'catalog', 'manual' ou 'missing' (proposta
-- sem item nenhum).
with computo as (
  select p.id,
         case
           when count(i.id) = 0 then 'missing'
           when bool_or(i.preco_unitario_cents is null) then 'missing'
           when bool_and(i.product_id is not null) then 'catalog'
           else 'manual'
         end as status_calculado
  from public.crm_proposals p
  left join public.crm_proposal_items i on i.proposal_id = p.id
  group by p.id
)
-- `pricing_status <> 'approved'` protege um fluxo que ainda não existe: o
-- baseline é reaplicado em TODO update.sh, e este backfill roda de novo a
-- cada vez. No dia em que uma onda futura gravar 'approved' (aprovação
-- manual de uma proposta), uma atualização de VPS sem essa guarda
-- desfaria a aprovação em silêncio, recalculando a partir dos itens.
update public.crm_proposals p
   set pricing_status = c.status_calculado
  from computo c
 where p.id = c.id
   and p.pricing_status is distinct from c.status_calculado
   and p.pricing_status <> 'approved';

-- ── §5.3 — um rascunho aberto por negócio ───────────────────────────────────
-- Dedupe ANTES do índice (doutrina de migrations item 8): mantém só o
-- rascunho mais recente por (organization_id, lead_id); os demais viram
-- 'cancelada' — NUNCA apagados, o histórico continua na timeline/auditoria.
-- `lead_id` nulo (proposta órfã, D10) nunca colide aqui: a trigger
-- `fn_cancelar_propostas_rascunho_do_lead` (migration 0466) já vira
-- 'cancelada' TODO rascunho antes do lead ser apagado, então nenhuma linha
-- com status='rascunho' e lead_id nulo pode existir.
with ranking as (
  select id,
         row_number() over (
           partition by organization_id, lead_id
           order by created_at desc, id desc
         ) as posicao
  from public.crm_proposals
  where status = 'rascunho'
)
update public.crm_proposals p
   set status = 'cancelada'
  from ranking r
 where p.id = r.id
   and r.posicao > 1;

create unique index if not exists crm_proposals_rascunho_unico_por_negocio_uidx
  on public.crm_proposals (organization_id, lead_id)
  where status = 'rascunho';

notify pgrst, 'reload schema';

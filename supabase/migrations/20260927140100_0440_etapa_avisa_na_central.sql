-- 0440 — a etapa que AVISA a equipe na Central quando um negócio entra nela.
--
-- Numa operação de pagamento na entrega, o fechamento que importa para a equipe
-- não é o `is_won` (o dinheiro só entra quando o pedido é entregue): é o cliente
-- confirmar o pedido com todos os dados, porque é aí que alguém precisa separar
-- e despachar. Esse momento é uma ETAPA do funil, e quem sabe qual é a
-- organização — não o código. Daí uma marca por etapa, desligada por padrão.
--
-- Quem lê: `lib/leads/aviso-de-etapa.handler.ts` (evento `lead.stage_changed`),
-- que abre um item na Central apontando para o negócio.
--
-- Idempotente e aditiva: coluna com default, nada a corrigir antes.
alter table public.crm_stages
  add column if not exists avisar_na_central boolean not null default false;

comment on column public.crm_stages.avisar_na_central is
  'Negócio que entra nesta etapa abre um aviso na Central de avisos (0440).';

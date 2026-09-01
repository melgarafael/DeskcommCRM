-- 0161 — MOEDA PADRÃO DO NEGÓCIO PASSA DE BRL PARA MZN.
--
-- Esta instalação opera em Moçambique; leads criados sem moeda explícita
-- devem nascer em Metical (MZN), não em Real (BRL). `crm_leads.currency`
-- é NULLABLE e só tem CHECK de FORMA (`^[A-Z]{3}$`, `crm_leads_currency_iso`
-- no baseline) — nenhuma constraint de conjunto amarra o valor a 'BRL', então
-- não há lista para editar, só o DEFAULT da coluna.
--
-- `orders.currency` (alimentada pela integração Nuvemshop, plataforma
-- brasileira) FICA de fora de propósito: aquele valor normalmente vem do
-- payload real do pedido, e o default só cobre o caso raro de o webhook não
-- informar moeda — mudar o default ali arriscaria rotular pedido em BRL como
-- MZN quando a Nuvemshop falhar em mandar o campo.
--
-- Não altera nenhuma linha existente: lead antigo que já tem 'BRL' gravado
-- continua 'BRL' (é o valor real do negócio na época). Só o piso para
-- linha NOVA muda. `alter column ... set default` é idempotente por
-- natureza — reaplicar não tem efeito colateral.

alter table public.crm_leads alter column currency set default 'MZN';

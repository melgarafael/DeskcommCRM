-- ============================================================================
-- 0214 — EMBARQUE CERTO: quem já foi sai da fila, e devolvido pode voltar
--
-- Dois defeitos da 0212, achados no uso:
--
-- 1. O pedido embarcado CONTINUAVA na lista de "aguardando embarque": o
--    status não mudava, e a tela filtrava por status. Efeito: o expedidor
--    embarcava o mesmo pedido duas vezes (a segunda morria no unique com
--    mensagem técnica) ou, pior, duvidava da lista inteira.
--
-- 2. O `unique(order_id)` TOTAL impedia reembarque para sempre: pedido
--    devolvido não podia entrar em outra carga, porque a linha histórica
--    (devolvido) ainda ocupava a unicidade. Histórico e trava eram a mesma
--    coisa — e não podiam ser.
--
-- O conserto separa as duas coisas:
-- - a TRAVA vira índice parcial: só uma linha ATIVA (na_carga/em_rota) por
--   pedido. Entregue/devolvido é história, e história não trava reembarque;
-- - a ROTA avança o pedido para `expedido` ao embarcar (e a tela de
--   expedição passa a listar só aprovado/faturado — o texto do ATT.txt,
--   não o conjunto largo da 0212 que incluía em_analise).
-- ============================================================================

drop index if exists public.shipment_orders_order_unico;

-- Uma carga ativa por vez; história (entregue/devolvido) não trava reembarque.
create unique index if not exists shipment_orders_order_ativo_unico
  on public.shipment_orders (order_id)
  where status in ('na_carga', 'em_rota');

comment on index public.shipment_orders_order_ativo_unico is
  'Um pedido, uma carga ATIVA por vez. Entregue/devolvido é história e não ocupa a trava — devolvido pode embarcar de novo.';

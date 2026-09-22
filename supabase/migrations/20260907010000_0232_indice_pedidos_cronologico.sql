-- ============================================================================
-- 0232 — ÍNDICE DA ORDEM CRONOLÓGICA DOS PEDIDOS (radar de recompra)
--
-- O radar lê commercial_orders ordenado por created_at em páginas de 1000.
-- Sem índice composto, cada página varria + ordenava as linhas do tenant
-- (11 páginas ≈ 10s → o frontend abortava e a tela mentia "base em dia";
-- em paralelo, a contenção derrubava uma página com 500).
-- Índice idempotente, sem RLS nova (só coluna, mesma política).
-- ============================================================================

create index if not exists commercial_orders_org_created_idx
  on public.commercial_orders (organization_id, created_at);

/**
 * PORTAS DE TOKEN — LEITURA E ANÁLISE (Spec 33, fatia R3).
 *
 * Rotas de leitura e análise (métricas, relatórios, auditoria…). O token precisa de `mcp:read`/`mcp:write`, e do papel da tool MCP da mesma ação quando ela exige mais (`tokenRole`).
 */
import type { ModeloDePorta } from "./porta";

// Cada modelo é o caminho de uma pasta de `app/` cuja `route.ts` chama
// `resolveAuthDual` em pelo menos um método. Método que continua só de sessão
// na mesma rota segue recusando o token com 401 no `requireRole`, porque o
// proxy filtra por caminho e não por método. A cerca
// `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts` reprova porta sem rota
// com token e rota com token sem porta.
export const MODELOS_DA_LEITURA: readonly ModeloDePorta[] = [];

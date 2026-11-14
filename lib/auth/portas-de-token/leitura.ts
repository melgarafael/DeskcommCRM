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
export const MODELOS_DA_LEITURA: readonly ModeloDePorta[] = [
  // EXPORTAR A LISTA DA CAMPANHA (issue #4360). Rota de LEITURA — dois `select`
  // e o CSV — que aceita sessão OU Bearer `dsk_…` com `mcp:read`, resolvidos
  // por `resolveAuthDual` DENTRO do handler. Sem esta porta o `proxy.ts`
  // devolve 401 a quem chama com token e o ramo do Bearer fica inalcançável
  // (mesma classe medida em `drafts/consume`). O segmento dinâmico é FORMA DE
  // UUID, nunca `[^/]+`; `exportar` é literal e a expressão é ancorada nos dois
  // lados — o irmão `/prospecting/[id]` (só-sessão) não nasce público de
  // carona.
  "/api/v1/prospecting/[id]/exportar",
];

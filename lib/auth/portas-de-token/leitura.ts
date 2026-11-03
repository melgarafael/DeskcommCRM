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
  // ads, audit, imports (R3, tarefa 2). Quem autentica é a própria rota, por
  // `resolveAuthDual` (a organização sai da linha do token). Escopo `mcp:read`
  // nos GET e `mcp:write` no POST de `imports`; papel do token = papel da sessão
  // (manager em `ads`, `audit` e no POST; viewer nos GET de `imports`), sem
  // `tokenRole` porque nenhuma tool MCP faz estas ações. `audit/export` segue só
  // de sessão e não entra.
  "/api/v1/ads/meta/accounts",
  "/api/v1/ads/meta/campaigns",
  "/api/v1/audit",
  "/api/v1/imports",
  "/api/v1/imports/[id]",

  // metrics, reports (R3, tarefa 1). Quem autentica é a própria rota, por
  // `resolveAuthDual` (a organização sai da linha do token). Escopo `mcp:read`
  // nos GET e `mcp:write` no PATCH de `metrics/atrito`; papel do token = papel da
  // sessão (agent em `attendants` e `serie`, manager em `lost` e no PATCH de
  // `atrito`, viewer em `reports/*`), sem `tokenRole` porque nenhuma tool MCP faz
  // estas ações. O GET de `metrics/atrito` segue só de sessão (401 sem cookie);
  // `metrics/channels`, `metrics/funil`, `metrics/metas` e `reports/activities`
  // não entram.
  "/api/v1/metrics/atrito",
  "/api/v1/metrics/attendants",
  "/api/v1/metrics/lost",
  "/api/v1/metrics/serie",
  "/api/v1/reports/financeiro",
  "/api/v1/reports/tags",
];

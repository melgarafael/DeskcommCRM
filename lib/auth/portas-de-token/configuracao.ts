/**
 * PORTAS DE TOKEN — CONFIGURAÇÃO (Spec 33, fatia R1).
 *
 * Rotas de configuração. O token precisa de `config:read`/`config:write` e de papel admin (`tokenRole`, precedentes #2194 e #2824); a sessão continua com o papel de sempre.
 */
import type { ModeloDePorta } from "./porta";

// Cada modelo é o caminho de uma pasta de `app/` cuja `route.ts` chama
// `resolveAuthDual` em pelo menos um método. Método que continua só de sessão
// na mesma rota segue recusando o token com 401 no `requireRole`, porque o
// proxy filtra por caminho e não por método. A cerca
// `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts` reprova porta sem rota
// com token e rota com token sem porta.
export const MODELOS_DA_CONFIGURACAO: readonly ModeloDePorta[] = [
  // ai/agents. Quem autentica é a própria rota, por `resolveAuthDual`: token
  // com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). O `[id]` e o `[pid]` são forma de UUID (as rotas validam com
  // `UUID_RX`/`z.uuid()`), então nenhum irmão literal de `[id]` entra de
  // carona; `assignable` é um desses irmãos e tem a entrada própria, exata.
  "/api/v1/ai/agents/assignable",
  "/api/v1/ai/agents/[id]/duplicate",
  "/api/v1/ai/agents/[id]/pause",
  "/api/v1/ai/agents/[id]/proposals",
  "/api/v1/ai/agents/[id]/proposals/[pid]/apply",
  "/api/v1/ai/agents/[id]/reconcile",
  "/api/v1/ai/agents/[id]/runs",
  "/api/v1/ai/agents/[id]/tool-usage",

  // ai/cases e ai/routing-results. Quem autentica é a própria rota, por
  // `resolveAuthDual`: token com `config:read` (GET) ou `config:write` (PATCH) e
  // papel admin (`tokenRole`). `[id]` é forma de UUID; `alerta` (irmão literal de
  // `[id]` em ai/cases) segue só de sessão e não entra de carona. `chat`, `close`
  // e `reply` seguem só de sessão.
  "/api/v1/ai/cases",
  "/api/v1/ai/cases/[id]",
  "/api/v1/ai/routing-results",
  "/api/v1/ai/routing-results/[id]",

  // ai/followup-flows. Quem autentica é a própria rota, por `resolveAuthDual`:
  // token com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). `[id]` é forma de UUID; `publish`, `rollback` e `from-model`
  // continuam só de sessão e não entram de carona.
  "/api/v1/ai/followup-flows/[id]/disable",
  "/api/v1/ai/followup-flows/[id]/duplicate",
  "/api/v1/ai/followup-flows/[id]/export",
  "/api/v1/ai/followup-flows/[id]",
  "/api/v1/ai/followup-flows/import",
  "/api/v1/ai/followup-flows/modelos-aprovados",

  // ai/followups. Quem autentica é a própria rota, por `resolveAuthDual`:
  // token com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). `[id]` é forma de UUID; `resume` e `skip` continuam só de
  // sessão e não entram de carona.
  "/api/v1/ai/followups/enrollments/[id]/cancel",
  "/api/v1/ai/followups/enrollments/[id]/pause",
  "/api/v1/ai/followups/enrollments/[id]",
  "/api/v1/ai/followups/enrollments/[id]/snooze",
  "/api/v1/ai/followups/enrollments",
  "/api/v1/ai/followups/promises/[id]/cancel",
  "/api/v1/ai/followups/queue",














];

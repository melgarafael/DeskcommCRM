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

  // ai/knowledge. Quem autentica é a própria rota, por `resolveAuthDual`: token
  // com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). `[id]` é forma de UUID. `chave` e `provedor` seguem só de
  // sessão e não entram de carona.
  "/api/v1/ai/knowledge/busca",
  "/api/v1/ai/knowledge/reindex-all",
  "/api/v1/ai/knowledge/sources/[id]/conteudo",
  "/api/v1/ai/knowledge/sources/[id]/reindex",
  "/api/v1/ai/knowledge/sources/[id]",
  "/api/v1/ai/knowledge/sources/[id]/trechos",
  "/api/v1/ai/knowledge/sources",
  "/api/v1/ai/knowledge/sources/upload",

  // ai/memory. Quem autentica é a própria rota, por `resolveAuthDual`: token
  // com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). `[id]` é forma de UUID.
  "/api/v1/ai/memory",
  "/api/v1/ai/memory/entries",
  "/api/v1/ai/memory/entries/[id]",
  "/api/v1/ai/memory/versions/[id]",

  // ai/skills. Quem autentica é a própria rota, por `resolveAuthDual`: token
  // com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). `[name]` é o nome da skill (kebab-case `[a-z0-9][a-z0-9-]{0,119}`
  // — os nomes do catálogo seguem `objecao-preco`/`agendamento` no baseline) — não é
  // UUID, então declara classe e amostra. `import`, `[name]/install`,
  // `[name]/restore` e o PUT de `[name]` aceitam token também (usam `getSkillsPool`,
  // pg Pool cru, mas a organização entra como parâmetro, vinda da linha do token).
  //
  // DECISAO: a classe do segmento e o Zod da rota (`nameSchema`) são apertados para
  // `[a-z0-9][a-z0-9-]{0,119}` porque todos os nomes de skill no baseline e na
  // lib seguem esse formato kebab-case (ex.: `objecao-preco`, `agendamento`). Assim
  // irmãos literais como `import`, `install`, `restore` e `upload` não caem de
  // carona na porta do `[name]` por engano.
  "/api/v1/ai/skills",
  "/api/v1/ai/skills/import",
  { caminho: "/api/v1/ai/skills/[name]", segmentos: { name: "[a-z0-9][a-z0-9-]{0,119}" }, amostras: { name: "minha-skill" } },
  { caminho: "/api/v1/ai/skills/[name]/install", segmentos: { name: "[a-z0-9][a-z0-9-]{0,119}" }, amostras: { name: "minha-skill" } },
  { caminho: "/api/v1/ai/skills/[name]/restore", segmentos: { name: "[a-z0-9][a-z0-9-]{0,119}" }, amostras: { name: "minha-skill" } },
  { caminho: "/api/v1/ai/skills/[name]/versions", segmentos: { name: "[a-z0-9][a-z0-9-]{0,119}" }, amostras: { name: "minha-skill" } },

  // ai (demais). Quem autentica é a própria rota, por `resolveAuthDual`: token com
  // `config:read` (GET) ou `config:write` (escrita) e papel admin (`tokenRole`),
  // com o papel de sempre da tabela (manager/agent/admin) como mínimo. Caminhos
  // literais, sem `[nome]`. Métodos que seguem só de sessão na mesma rota (`pacing`
  // PUT) recusam o token com 401 no `requireRole`. `jev` e `voz/preview` seguem só de sessão e não entram de carona.
  "/api/v1/ai/automatico-ativo",
  "/api/v1/ai/budget",
  "/api/v1/ai/evolution",
  "/api/v1/ai/guardrail-layers",
  "/api/v1/ai/mapas",
  "/api/v1/ai/mapas/testar",
  "/api/v1/ai/operator-metrics",
  "/api/v1/ai/pacing",
  "/api/v1/ai/runs",
  "/api/v1/ai/style-adjustments",
  "/api/v1/ai/turn-traces",
  "/api/v1/ai/usage",
  "/api/v1/ai/voz",










];

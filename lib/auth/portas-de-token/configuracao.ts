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

  // pipelines. Quem autentica é a própria rota, por `resolveAuthDual`: token com
  // `config:read` (GET) ou `config:write` (escrita) e papel admin (`tokenRole`).
  // `[id]` é forma de UUID. `forecast` aceita token também (no token a previsão
  // é da organização inteira, sem o recorte por pessoa da sessão). O POST de
  // `stages` também (GET e POST dividem a mesma porta). `stages/[stageId]` (PATCH
  // e DELETE da etapa) também; `[stageId]` é forma de UUID, então o irmão literal
  // `win-rates` não cai de carona.
  "/api/v1/pipelines",
  "/api/v1/pipelines/default",
  "/api/v1/pipelines/[id]",
  "/api/v1/pipelines/[id]/agent-mapping",
  "/api/v1/pipelines/[id]/board",
  "/api/v1/pipelines/[id]/forecast",
  "/api/v1/pipelines/[id]/leads",
  "/api/v1/pipelines/[id]/stages",
  "/api/v1/pipelines/[id]/stages/[stageId]",
  "/api/v1/pipelines/[id]/stages/win-rates",

  // products e tags. Quem autentica é a própria rota, por `resolveAuthDual`: token
  // com `config:read` (GET) ou `config:write` (escrita) e papel admin (`tokenRole`).
  // `[id]` é forma de UUID; `import` é irmão literal de `[id]` e tem entrada
  // própria, exata. `tags/vocabulario` POST segue só de sessão (a função de escrita
  // exige `auth.uid()`) e não entra de carona: ali o token leva 401 do `requireRole`.
  "/api/v1/products",
  "/api/v1/products/[id]",
  "/api/v1/products/[id]/fotos",
  "/api/v1/products/import",
  "/api/v1/tags/cores",
  "/api/v1/tags/vocabulario",

  // settings. Quem autentica é a própria rota, por `resolveAuthDual`: token com
  // `config:read` (GET) ou `config:write` (escrita) e papel admin (`tokenRole`).
  // `routing/channels` aceita token só no GET (a sessão mantém `allowPlatformAdmin`
  // e `mfaEmDivida`; o ramo do token é à parte). O PATCH segue só de sessão
  // (`fn_set_channel_routing` exige `auth.uid()`) e recusa o token com 401 no
  // `requireRole`. `proposal-templates/importar` (POST) segue só de sessão
  // (`getSkillsPool`, pg Pool cru). `[slug]` é a classe do regex da rota (`[a-z0-9_]{1,100}`): o
  // irmão literal `importar` cai nessa classe, e a rota responde 401 pelo
  // `requireRole` de sessão.
  "/api/v1/settings/agenda-apresentacao",
  "/api/v1/settings/campanhas",
  { caminho: "/api/v1/settings/proposal-templates/[slug]", segmentos: { slug: "[a-z0-9_]{1,100}" }, amostras: { slug: "empresa_minha_proposta" } },
  "/api/v1/settings/proposal-templates",
  "/api/v1/settings/proposals",
  "/api/v1/settings/prospeccao",
  "/api/v1/settings/routing",
  "/api/v1/settings/routing/channels",
  "/api/v1/settings/sons",
  "/api/v1/settings/task-plans",

  // message-templates e message-template-groups. Quem autentica é a própria
  // rota, por `resolveAuthDual`: token com `config:read` (GET) ou `config:write`
  // (escrita) e papel admin (`tokenRole`). `[id]` é forma de UUID. `[indice]` da
  // mídia é número inteiro não negativo (a rota recusa o resto com 404). O token
  // só alcança a resposta COMPARTILHADA (`owner_user_id` nulo): o POST de criação
  // recusa `shared: false`, e o PATCH e o DELETE de `[id]` e o POST de `[id]/midias`
  // e o PUT de `[id]/ordem` (renumeração só entre as compartilhadas) filtram o
  // compartilhado.
  "/api/v1/message-templates",
  "/api/v1/message-templates/[id]",
  "/api/v1/message-templates/[id]/midias",
  "/api/v1/message-templates/[id]/ordem",
  { caminho: "/api/v1/message-templates/[id]/midias/[indice]", segmentos: { indice: "[0-9]+" }, amostras: { indice: "0" } },
  "/api/v1/message-template-groups",
  "/api/v1/message-template-groups/[id]",
  "/api/v1/message-template-groups/[id]/ordem",

  // automation-rules (R1). Quem autentica é a própria rota, por `resolveAuthDual`:
  // token com `config:read` (GET) ou `config:write` (POST e DELETE) e papel admin
  // (`tokenRole`). `[id]` é forma de UUID. O POST com token confere, antes de gravar, cada id que a
  // regra carrega (`lib/automation/validar-ids-das-acoes.ts`). O PATCH de `[id]` segue só de sessão
  // (`authz.org.role` na autoria) e não entra de carona: o `[id]` ganha porta pelo DELETE.
  "/api/v1/automation-rules",
  "/api/v1/automation-rules/[id]",
  "/api/v1/automation-rules/[id]/runs",
  "/api/v1/automation-rules/runs",

  // channel-schedules (R1). Quem autentica é a própria rota, por `resolveAuthDual`:
  // token com `config:read` (GET) ou `config:write` (escrita) e papel admin
  // (`tokenRole`). `[id]` é forma de UUID.
  "/api/v1/channel-schedules",
  "/api/v1/channel-schedules/[id]",

  // attendants/availability e team/assignable (só GET, leitura). Quem autentica é a
  // própria rota, por `resolveAuthDual`: token com `config:read` e papel admin
  // (`tokenRole`). Caminhos literais, sem segmento dinâmico, então nenhum irmão entra
  // de carona: `availability/[user_id]` (PATCH de pessoa) e `presence` seguem só de
  // sessão, e `team` (lista com e-mail de login) também.
  "/api/v1/attendants/availability",
  "/api/v1/team/assignable",

  // attendants/sector (R1). Quem autentica é a própria rota, por `resolveAuthDual`:
  // token com `config:write` e papel admin (`tokenRole`). `[user_id]` é forma de
  // UUID (a rota recusa o resto com 404).
  "/api/v1/attendants/sector/[user_id]",

  // attendants/sectors/[id] (R1). Quem autentica é a própria rota, por
  // `resolveAuthDual`: token com `config:write` e papel admin (`tokenRole`)
  // no PATCH e no DELETE. `[id]` é forma de UUID (a rota recusa o resto com 404).
  "/api/v1/attendants/sectors/[id]",

  // attendants/sectors (R1). Quem autentica é a própria rota, por `resolveAuthDual`:
  // token com `config:read` (GET) ou `config:write` (POST) e papel admin
  // (`tokenRole`). Caminho literal, sem segmento dinâmico.
  "/api/v1/attendants/sectors",
];

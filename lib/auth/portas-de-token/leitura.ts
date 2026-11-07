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

  // metrics, reports (R3, tarefa 1 e conversão dos GET de análise). Quem autentica
  // é a própria rota, por `resolveAuthDual` (a organização sai da linha do token).
  // Escopo `mcp:read` nos GET e `mcp:write` no PATCH de `metrics/atrito`. Papel da
  // sessão: agent em `attendants`, `serie`, `atrito` GET, `channels`, `funil` e
  // `metas` GET; manager em `lost` e no PATCH de `atrito`; viewer em `reports/*`. Papel
  // do TOKEN: igual ao da sessão, exceto `atrito` GET, `channels`, `funil`,
  // `metas` e `reports/activities`, que exigem `manager` (`tokenRole`): o token lê a
  // organização inteira, e na sessão um agent só vê as conversas dele. Nenhuma
  // tool MCP faz estas ações, então não há `tokenRole` por causa de tool.
  "/api/v1/metrics/atrito",
  "/api/v1/metrics/attendants",
  "/api/v1/metrics/channels",
  "/api/v1/metrics/funil",
  "/api/v1/metrics/lost",
  "/api/v1/metrics/metas",
  "/api/v1/metrics/serie",
  "/api/v1/reports/activities",
  "/api/v1/reports/financeiro",
  "/api/v1/reports/tags",

  // channel-sessions e voice, leitura (R3, tarefa 3, e follow-up). Quem autentica
  // é a própria rota, por `resolveAuthDual` (a organização sai da linha do token).
  // Escopo `mcp:read` nos GET; papel do token = papel da sessão: viewer em
  // `channel-sessions`, `channel-sessions/[id]` e `voice/sessions/status`; agent em
  // `voice/calls/history`; manager em `voice/opt-in` e `channel-sessions/[id]/groups`;
  // admin em `channel-sessions/[id]/acervo`, `ai-access`, `disabled` e `historico`.
  // Sem `tokenRole`, porque nenhuma tool MCP faz estas ações. Os métodos de escrita
  // dessas rotas (acervo PATCH, ai-access PATCH, disabled PATCH, groups PUT,
  // historico POST, DELETE de `[id]`, `voice/opt-in` PUT) e as demais rotas de
  // `channel-sessions` (qr, pairing-code, reconnect, name) e de `voice/*` de escrita
  // seguem só de sessão e não entram.
  "/api/v1/channel-sessions",
  "/api/v1/channel-sessions/[id]",
  "/api/v1/channel-sessions/[id]/acervo",
  "/api/v1/channel-sessions/[id]/ai-access",
  "/api/v1/channel-sessions/[id]/disabled",
  "/api/v1/channel-sessions/[id]/groups",
  "/api/v1/channel-sessions/[id]/historico",
  "/api/v1/voice/calls/history",
  "/api/v1/voice/opt-in",
  "/api/v1/voice/sessions/status",

  // messages e modulos (R3, tarefa 4). Quem autentica é a própria rota, por
  // `resolveAuthDual` (a organização sai da linha do token). Escopo `mcp:write`
  // no POST/DELETE de `messages/[id]/hide`, `mcp:read` no GET de
  // `messages/[id]/media` e no GET de `modulos/[modulo]/[objeto]`; papel do
  // token = papel da sessão (manager em `hide`, viewer em `media` e `modulos`),
  // sem `tokenRole` porque nenhuma tool MCP faz estas ações (conferido: nenhuma
  // tool MCP exige papel maior para ocultar mensagem nem para ler módulos).
  // `messages` (listagem) e `modulos` (listagem) seguem só de sessão e não entram.
  "/api/v1/messages/[id]/hide",
  "/api/v1/messages/[id]/media",
  {
    caminho: "/api/v1/modulos/[modulo]/[objeto]",
    segmentos: {
      modulo: "[a-z0-9][a-z0-9-]{0,62}[a-z0-9]",
      objeto: "[a-z0-9][a-z0-9-]{0,62}[a-z0-9]",
    },
    amostras: {
      modulo: "meu-modulo",
      objeto: "meu-objeto",
    },
  },
];

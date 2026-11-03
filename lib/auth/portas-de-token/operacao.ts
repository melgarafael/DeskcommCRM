/**
 * PORTAS DE TOKEN — OPERAÇÃO (Spec 33, fatia R2).
 *
 * Rotas de operação (contatos, conversas, negócios, agenda…). O token precisa de `mcp:read`/`mcp:write`, e do papel da tool MCP da mesma ação quando ela exige mais (`tokenRole`).
 */
import type { ModeloDePorta } from "./porta";

// Cada modelo é o caminho de uma pasta de `app/` cuja `route.ts` chama
// `resolveAuthDual` em pelo menos um método. Método que continua só de sessão
// na mesma rota segue recusando o token com 401 no `requireRole`, porque o
// proxy filtra por caminho e não por método. A cerca
// `tests/unit/rotas-bearer-tem-porta-no-proxy.test.ts` reprova porta sem rota
// com token e rota com token sem porta.
export const MODELOS_DA_OPERACAO: readonly ModeloDePorta[] = [
  // TAREFAS, DEMANDAS E CHAMADAS (tarefa 9 da R2). Quem autentica é a própria
  // rota, por `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização vinda
  // da linha do token): `mcp:read` no GET e `mcp:write` na escrita, com o papel
  // que a sessão já exige (`viewer` lê tarefas, `agent` escreve tarefas e
  // demandas, `manager` lê as chamadas). Segmento `[id]` em forma de UUID: nenhum
  // desses diretórios tem irmão literal que daria carona.
  //
  // `/api/v1/calls` abre o caminho inteiro, mas só o GET aceita token: o POST
  // (originar ligação) segue com `requireRole`, que recusa o Bearer sem cookie
  // com 401.
  "/api/v1/tasks",
  "/api/v1/tasks/[id]",
  "/api/v1/demandas/[id]",
  "/api/v1/calls",
];

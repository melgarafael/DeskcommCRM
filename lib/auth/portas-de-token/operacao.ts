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
  // CONTATOS E TAGS DE CONTATO (tarefa 1 da R2). Quem autentica é a própria
  // rota, por `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização vinda
  // da linha do token): `mcp:read` no GET e `mcp:write` na escrita, com o papel
  // que a sessão já exige. Segmentos `[id]` e `[proposal_id]`/`[enrollmentId]`
  // em forma de UUID: nenhum desses diretórios tem irmão literal que dê carona
  // além de `proposals/[proposal_id]` (não convertido: fica só de sessão).
  "/api/v1/contact-tags",
  "/api/v1/contacts/[id]",
  "/api/v1/contacts/[id]/always-human",
  "/api/v1/contacts/[id]/carteira",
  "/api/v1/contacts/[id]/compras",
  "/api/v1/contacts/[id]/crm-summary",
  "/api/v1/contacts/[id]/hierarquia-do-anuncio",
  "/api/v1/contacts/[id]/person",
  "/api/v1/contacts/[id]/personal",
  "/api/v1/contacts/[id]/proposals",
  "/api/v1/contacts/[id]/proposals/[proposal_id]",
  "/api/v1/contacts/[id]/roteiros",
  "/api/v1/contacts/[id]/roteiros/[enrollmentId]/negocio",
  "/api/v1/contacts/[id]/timeline",
  "/api/v1/contacts/[id]/vinculos",
  "/api/v1/contacts/bulk",
  "/api/v1/contacts/compare",
  "/api/v1/contacts/duplicates",
  "/api/v1/contacts/import/agenda",
  "/api/v1/contacts/import",
  "/api/v1/contacts/merge",
  // CONVERSAS E TAGS DE CONVERSA (tarefa 2 da R2). Quem autentica é a própria
  // rota, por `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização vinda
  // da linha do token): `mcp:read` no GET e `mcp:write` na escrita, com o papel
  // que a sessão já exige (`viewer` lê, `agent` escreve). Segmento `[id]` em
  // forma de UUID: nenhum desses diretórios tem irmão literal que dê carona
  // além dos que não ganharam porta (`claim`, `mark-read`, `release`, `export`,
  // `drafts`, e as rotas que ficaram só de sessão: ver o plano R2), listados na borda do teste da área.
  "/api/v1/conversation-tags",
  "/api/v1/conversations/[id]/messages",
  "/api/v1/conversations/[id]/notes",
  "/api/v1/conversations/[id]/passagens",
  "/api/v1/conversations/[id]/retention",
  "/api/v1/conversations/[id]/sector",
  "/api/v1/conversations/[id]/snooze",
  "/api/v1/conversations/[id]/usable-for-rag",
  // LEADS (tarefa 3 da R2). Quem autentica é a própria rota, por `resolveAuthDual`
  // (sessão OU Bearer `dsk_…`, a organização vinda da linha do token): `mcp:read`
  // no GET e `mcp:write` na escrita, com o papel que a sessão já exige
  // (`viewer` lê, `agent` escreve). Segmentos `[id]`, `[attachmentId]` e `[pid]`
  // em forma de UUID: nenhum desses diretórios tem irmão literal que dê carona
  // além dos que ficaram só de sessão (`leads/[id]/conversion/retry` e
  // `leads/at-risk`), listados na borda do teste da área.
  "/api/v1/leads",
  "/api/v1/leads/[id]/attachments",
  "/api/v1/leads/[id]/attachments/[attachmentId]/media",
  "/api/v1/leads/[id]/clone",
  "/api/v1/leads/[id]/contatos-relacionados",
  "/api/v1/leads/[id]/eventos",
  "/api/v1/leads/[id]/field-proposals",
  "/api/v1/leads/[id]/field-proposals/[pid]",
  "/api/v1/leads/[id]/lose",
  "/api/v1/leads/[id]/move",
  "/api/v1/leads/[id]/next-action",
  "/api/v1/leads/[id]/reactivation",
  "/api/v1/leads/[id]/retomar",
  "/api/v1/leads/[id]/timeline",
  "/api/v1/leads/[id]/win",
  "/api/v1/leads/bulk",
  "/api/v1/leads/import",
  "/api/v1/leads/proposals",
  "/api/v1/leads/reactivations",
  // EMPRESAS, PESSOAS, VÍNCULOS E NÚMEROS DE VOZ (R2, tarefa 7). Quem autentica é a
  // própria rota, por `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização
  // vinda da linha do token): `mcp:read` no GET e `mcp:write` na escrita, com o
  // papel que a sessão já exige. Nenhuma tool MCP faz estas ações, então sem
  // `tokenRole`. Segmentos `[id]` em forma de UUID; o único irmão literal,
  // `companies/lookup`, ganhou porta por ser método convertido.
  "/api/v1/companies",
  "/api/v1/companies/lookup",
  "/api/v1/companies/[id]",
  "/api/v1/companies/[id]/enrich",
  "/api/v1/company-people",
  "/api/v1/company-people/[id]",
  "/api/v1/people",
  "/api/v1/people/[id]",
  "/api/v1/phone-numbers",
  "/api/v1/phone-numbers/[id]",
];

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
  // `duplicates/dismiss` (POST, `mcp:write`, `manager`): literal irmão de `duplicates`,
  // com porta própria e a mesma regra do pool `pg` filtrado por organização.
  "/api/v1/contacts/duplicates/dismiss",
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
  "/api/v1/conversations",
  "/api/v1/conversations/[id]",
  "/api/v1/conversations/[id]/messages",
  "/api/v1/conversations/[id]/notes",
  // Leituras que ganharam o token depois (o resto dessas rotas segue só de
  // sessão: transferir, convidar e remover participante, apagar nota).
  "/api/v1/conversations/[id]/notes/[noteId]/media",
  "/api/v1/conversations/[id]/participants",
  "/api/v1/conversations/[id]/transfer",
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
  // `at-risk` (GET, `mcp:read`, `agent`): o radar de risco da organização, pela mesma
  // montagem da tool MCP. Receita B: a sessão segue com `requireRole`.
  "/api/v1/leads/at-risk",
  "/api/v1/leads/proposals",
  "/api/v1/leads/reactivations",

  // PROPOSTAS (fatia R2, ordem R2-05). Quem autentica é a própria rota, por
  // `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização vinda da linha do
  // token): `mcp:read` no GET e `mcp:write` na escrita, com o papel que a sessão
  // já exige (`viewer` lê, `agent` cria e ajusta, `manager` troca o modelo, edita
  // o documento, revisa e descarta). Segmento `[id]` em forma de UUID. `send`
  // (envia ao cliente final), `assistant` e `preencher-com-conversa` (ambos com
  // o pool do Postgres e a IA) seguem só de sessão: não ganham porta.
  "/api/v1/proposals",
  "/api/v1/proposals/[id]",
  "/api/v1/proposals/[id]/assistant/apply",
  "/api/v1/proposals/[id]/assistant/disponibilidade",
  "/api/v1/proposals/[id]/decide",
  "/api/v1/proposals/[id]/documento",
  "/api/v1/proposals/[id]/modelo",
  "/api/v1/proposals/[id]/previa",
  "/api/v1/proposals/[id]/revise",

  // CAMPANHAS, MODELOS DE TEXTO E EXCLUSÕES (tarefa 6 da R2). Quem autentica é a
  // própria rota, por `resolveAuthDual` (sessão OU Bearer `dsk_…`, a organização
  // vinda da linha do token): `mcp:read` no GET e `mcp:write` na escrita e no
  // POST de prévia, com o papel `manager` que a sessão já exige. Nenhuma tool do
  // catálogo MCP faz ação de campanha, então não há `tokenRole`.
  // Segmento `[id]` em forma de UUID. FICA SÓ DE SESSÃO: `campaigns/[id]/[acao]`
  // (inicia, retoma e testa envio a cliente final) — sem porta aqui.
  "/api/v1/campaign-suppressions",
  "/api/v1/campaign-suppressions/[id]",
  "/api/v1/campaign-templates",
  "/api/v1/campaign-templates/[id]",
  "/api/v1/campaigns",
  "/api/v1/campaigns/[id]",
  "/api/v1/campaigns/[id]/metrics",
  "/api/v1/campaigns/[id]/recipients",
  "/api/v1/campaigns/modelos",
  "/api/v1/campaigns/preview",

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

  {
    caminho: "/api/v1/financeiro/catalogo/[tipo]",
    segmentos: {
      tipo: "contas|formas_de_pagamento|planos_de_conta|regras_de_comissao|recorrencias",
    },
    amostras: { tipo: "contas" },
  },
];

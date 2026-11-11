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

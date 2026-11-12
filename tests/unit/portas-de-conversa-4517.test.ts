import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

/**
 * AS PORTAS DE TOKEN DE #4517, DO LADO DO PROXY.
 *
 * `PUBLIC_PATHS` responde uma pergunta só: "o proxy deixa passar sem cookie?".
 * Errar PARA MAIS abre rota ao anônimo; errar PARA MENOS faz o Bearer receber
 * 401 do proxy antes de a rota — que está correta — rodar. As duas falhas são
 * silenciosas em desenvolvimento (onde o proxy não está na frente), e por isso
 * esta régua é explícita.
 *
 * O padrão tem de casar FORMA DE UUID e âncora `$`: `/api/v1/conversations/` tem
 * irmãos literais e sub-rotas que NÃO ganharam porta de token nesta issue
 * (`transfer`, `assign`, `sector`). Um `[^/]+` no meio os tornaria públicos por
 * carona.
 *
 * `drafts` NÃO é uma delas: aquela porta é da #1611 (criação de rascunho
 * sugerido por token), medida em `rotas-bearer-tem-porta-no-proxy`. O que a
 * #4517 aperta ali é a FORMA do id (UUID, com `$`) — `/conversations/abc/drafts`
 * deixa de entrar de carona.
 */
const UUID = "01234567-89ab-4cde-8f01-234567890abc";

describe("#4517 — as portas novas são públicas para o Bearer", () => {
  it.each([
    `/api/v1/contacts/${UUID}`,
    `/api/v1/conversations/${UUID}/pause-ai`,
    `/api/v1/conversations/${UUID}/reactivate-bot`,
    `/api/v1/conversations/${UUID}/close`,
    `/api/v1/conversations/${UUID}/reopen`,
    // Porta da #1611, não desta issue: continua aberta, e o id agora é UUID.
    `/api/v1/conversations/${UUID}/drafts`,
  ])("%s passa pelo proxy (a rota cobra o escopo)", (caminho) => {
    expect(isPublicPath(caminho)).toBe(true);
  });
});

describe("#4517 — e NADA além delas", () => {
  it.each([
    // Irmãos literais de `/contacts/` — nenhum tem porta de token.
    "/api/v1/contacts/import",
    "/api/v1/contacts/bulk",
    "/api/v1/contacts/merge",
    // Id que não é UUID: forma livre não é id do Postgres.
    "/api/v1/contacts/abc",
    "/api/v1/conversations/abc/pause-ai",
    // Sub-rotas de conversa que NÃO ganharam escopo nesta issue.
    `/api/v1/conversations/${UUID}/transfer`,
    `/api/v1/conversations/${UUID}/assign`,
    `/api/v1/conversations/${UUID}/sector`,
    // Id inventado na porta da #1611: forma livre não é id do Postgres.
    "/api/v1/conversations/abc/drafts",
    // Sub-path inventado debaixo de uma porta que existe.
    `/api/v1/conversations/${UUID}/pause-ai/extra`,
    `/api/v1/contacts/${UUID}/avatar/extra`,
  ])("%s continua fechado", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});

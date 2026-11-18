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
 * irmãos literais e sub-rotas, e um `[^/]+` no meio tornaria públicas por carona
 * as que NÃO passam por esta porta. As que hoje TÊM porta de token por outra
 * fatia — `transfer`, `sector`, `assign`, `drafts` e os irmãos de `/contacts/`
 * (`import`, `bulk`, `merge`) — são abertas por `lib/auth/portas-de-token/`
 * (Spec 33 R2) e pela #1611, com escopo próprio resolvido DENTRO da rota; esta
 * régua não as cobre nem as fecha.
 *
 * O que a #4517 aperta é a FORMA do id nas SUAS quatro rotas: id inventado
 * (`/conversations/abc/close`) e sub-path (`/pause-ai/extra`) continuam fechados.
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
    // Id que não é UUID: forma livre não é id do Postgres.
    "/api/v1/contacts/abc",
    "/api/v1/conversations/abc/pause-ai",
    "/api/v1/conversations/abc/reactivate-bot",
    "/api/v1/conversations/abc/close",
    "/api/v1/conversations/abc/reopen",
    // Sub-rotas de conversa que NÃO ganharam escopo nesta issue.
    `/api/v1/conversations/${UUID}/assign`,
    // Sub-path inventado debaixo de uma porta que existe.
    `/api/v1/conversations/${UUID}/pause-ai/extra`,
    `/api/v1/conversations/${UUID}/reopen/extra`,
    `/api/v1/contacts/${UUID}/avatar/extra`,
  ])("%s continua fechado", (caminho) => {
    expect(isPublicPath(caminho)).toBe(false);
  });
});

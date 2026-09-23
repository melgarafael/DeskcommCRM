/**
 * PUBLIC_PATHS decide quem atravessa o proxy sem sessão em toda a aplicação
 * (`proxy.ts`). Sem teste, uma âncora `$` trocada por prefixo, ou uma entrada
 * larga demais, some em silêncio do CI — foi exatamente o bug achado provando
 * a Task 6 (heartbeat do agente bloqueado por faltar aqui).
 */
import { describe, it, expect } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

describe("isPublicPath", () => {
  it("libera o heartbeat do agente do host (bearer, sem cookie)", () => {
    expect(isPublicPath("/api/v1/system/agent")).toBe(true);
  });

  it("libera o tick do relógio Hobby (bearer, sem cookie)", () => {
    expect(isPublicPath("/api/v1/system/relogio/tick")).toBe(true);
    expect(isPublicPath("/api/v1/system/relogio")).toBe(false);
    expect(isPublicPath("/api/v1/system/relogio/tick/extra")).toBe(false);
  });

  it("a âncora `$` impede que um sub-path passe de carona", () => {
    expect(isPublicPath("/api/v1/system/agent/qualquer")).toBe(false);
  });

  it("não libera a rota de pedido de atualização (exige sessão do dono)", () => {
    expect(isPublicPath("/api/v1/system/update")).toBe(false);
  });

  it("não libera a rota de estado da versão (exige sessão)", () => {
    expect(isPublicPath("/api/v1/system/version")).toBe(false);
  });

  /**
   * Os documentos legais são linkados do checkbox OBRIGATÓRIO da primeira tela
   * do produto (`/onboarding/welcome`). Fora daqui, `proxy.ts` manda o visitante
   * para `/login?next=/legal/terms` — e um aceite de termos que só se lê depois
   * de ter conta é um aceite que ninguém pode conferir antes de aceitar.
   */
  it("libera os documentos legais — o aceite acontece antes de existir conta", () => {
    expect(isPublicPath("/legal/terms")).toBe(true);
    expect(isPublicPath("/legal/privacy")).toBe(true);
  });

  it("e só esses dois: /legal não é um portão aberto", () => {
    // Entrada larga aqui é furo de auth em toda a aplicação, não só nesta tela.
    expect(isPublicPath("/legal")).toBe(false);
    expect(isPublicPath("/legal/terms/interno")).toBe(false);
    expect(isPublicPath("/legal/qualquer-outra")).toBe(false);
  });

  /**
   * `PATCH /api/v1/leads/[id]` aceita Bearer (auth-dual, monitoramento
   * processual). O que este bloco prova é a forma exata do segmento: UUID, não
   * `[^/]+` — `/api/v1/leads/` tem irmãos LITERAIS no mesmo nível (`bulk`,
   * `at-risk`, `import`, `proposals`, `reactivations`), nenhum deles com
   * suporte a Bearer, que um padrão largo tornaria público por engano.
   */
  it("libera PATCH /api/v1/leads/[id] (bearer, forma de UUID)", () => {
    expect(isPublicPath("/api/v1/leads/11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("mas NÃO os irmãos literais de /api/v1/leads/, que não têm Bearer", () => {
    expect(isPublicPath("/api/v1/leads/bulk")).toBe(false);
    expect(isPublicPath("/api/v1/leads/at-risk")).toBe(false);
    expect(isPublicPath("/api/v1/leads/import")).toBe(false);
    expect(isPublicPath("/api/v1/leads/proposals")).toBe(false);
    expect(isPublicPath("/api/v1/leads/reactivations")).toBe(false);
  });

  it("nem um sub-path do lead (clone, move, lose, win, …) passa de carona", () => {
    expect(
      isPublicPath("/api/v1/leads/11111111-1111-4111-8111-111111111111/clone"),
    ).toBe(false);
  });
});

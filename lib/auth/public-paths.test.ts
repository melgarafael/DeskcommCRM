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
    expect(isPublicPath("/api/v1/leads/11111111-1111-4111-8111-111111111111/clone")).toBe(false);
  });

  /**
   * `GET /api/v1/contacts/{id}/avatar` aceita Bearer (auth-dual, #3420) — mas
   * só o avatar. Os mesmos cuidados do bloco de `/api/v1/leads/` acima: forma
   * de UUID no id e âncora `$`, porque `/api/v1/contacts/` tem irmãos LITERAIS
   * (`bulk`, `duplicates`, `export`, `import`, `merge`) e nenhum deles com
   * suporte a Bearer.
   */
  it("libera só o avatar do contato (bearer, forma de UUID, âncora $)", () => {
    const contato = "11111111-1111-4111-8111-111111111111";
    expect(isPublicPath(`/api/v1/contacts/${contato}/avatar`)).toBe(true);
    expect(isPublicPath(`/api/v1/contacts/${contato}/avatar/extra`)).toBe(false);
    expect(isPublicPath("/api/v1/contacts/qualquer-id/avatar")).toBe(false);
    expect(isPublicPath(`/api/v1/contacts/${contato}/person`)).toBe(false);
    expect(isPublicPath("/api/v1/contacts/bulk/avatar")).toBe(false);
  });

  it("libera somente as portas de routers que autenticam sessão ou Bearer no handler", () => {
    const router = "11111111-1111-4111-8111-111111111111";
    expect(isPublicPath("/api/v1/ai/routers")).toBe(true);
    expect(isPublicPath(`/api/v1/ai/routers/${router}`)).toBe(true);
    expect(isPublicPath(`/api/v1/ai/routers/${router}/members`)).toBe(true);
    expect(isPublicPath(`/api/v1/ai/routers/${router}/test`)).toBe(true);
  });

  it("não dá carona a ids inválidos nem a sub-paths futuros de routers", () => {
    const router = "11111111-1111-4111-8111-111111111111";
    expect(isPublicPath("/api/v1/ai/routers/qualquer")).toBe(false);
    expect(isPublicPath(`/api/v1/ai/routers/${router}/members/extra`)).toBe(false);
    expect(isPublicPath(`/api/v1/ai/routers/${router}/test/extra`)).toBe(false);
    expect(isPublicPath(`/api/v1/ai/routers/${router}/publish`)).toBe(false);
  });

  /**
   * `/account-suspended` NÃO é mais rota pública (issue #2016). Quem cai nela
   * vem do redirect do layout de `/app` quando a organização está suspensa —
   * já com sessão. Ser pública fazia o `proxy` sair ANTES do `getUser()`, que é
   * quem renova o cookie da sessão; e o refresh que a própria página tenta no
   * Server Component é ignorado (`lib/supabase/server.ts`: `setAll` é no-op em
   * Server Component). Resultado: sessão que expira com a pessoa nessa tela não
   * é renovada e ela cai deslogada. Fora da lista, o `proxy` revalida e
   * renova a sessão como em qualquer outra rota da árvore logada.
   */
  it("libera a ponte da volta do provedor de pagamento, e nenhum sub-path dela", () => {
    expect(isPublicPath("/cobranca/volta")).toBe(true);
    expect(isPublicPath("/cobranca/volta/x")).toBe(false);
    expect(isPublicPath("/cobranca")).toBe(false);
  });

  it("NÃO libera /account-suspended — o proxy precisa renovar a sessão nela", () => {
    expect(isPublicPath("/account-suspended")).toBe(false);
  });

  it("e não libera nenhum sub-path dela de carona", () => {
    expect(isPublicPath("/account-suspended/qualquer")).toBe(false);
  });
});

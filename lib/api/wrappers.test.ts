/**
 * `fail()` — o ID que sai no header é o ID que existe no log (#3971).
 *
 * O aviso de erro da tela mostra `ID: <uuid>`, que é o `X-Request-Id` desta
 * função, e manda quem pede ajuda procurar esse ID no log do servidor. Até
 * aqui o ID só aparecia no log quando a ROTA resolvia gravar — e quando ela não
 * passava `requestId`, `fail()` inventava um UUID que não existia em lugar
 * nenhum.
 *
 * O que esta suíte prova:
 *
 *  1. `fail(..., 500)` SEM `requestId`: o UUID gerado sai no header E numa
 *     linha de log, o MESMO UUID (comparação literal de string).
 *  2. `fail(..., 500)` COM `requestId`: idem, com o ID do chamador.
 *  3. 4xx não gera linha: recusa esperada não enche o log.
 *  4. Rota que já grava o `requestId` antes de chamar `fail()` continua com
 *     UMA linha, não duas — o log da rota carrega mais contexto (causa, org) e
 *     é ele que fica.
 *  5. Envelope, status e corpo não mudam: a correção é no log.
 *
 * O `logger` fala por `console.error`/`console.warn` com uma linha JSON por
 * chamada (lib/logger.ts), então é daí que a asserção lê — não da
 * implementação do logger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { fail } from "./wrappers";

type Linha = { level: string; msg: string; requestId?: string; code?: string; status?: number };

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

/** Todas as linhas JSON que o logger escreveu nesta janela. */
function linhas(): Linha[] {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls].map((c) => JSON.parse(String(c[0])) as Linha);
}

/** As linhas cujo `requestId` é LITERALMENTE este id. */
function linhasDoId(id: string): Linha[] {
  return linhas().filter((l) => l.requestId === id);
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("fail() e o X-Request-Id", () => {
  it("⭐ 500 sem requestId: o UUID do header aparece no log, uma vez, com código e status", () => {
    const res = fail("internal_error", "Não foi possível carregar.", 500);
    const id = res.headers.get("X-Request-Id");

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const doId = linhasDoId(id!);
    expect(doId).toHaveLength(1);
    expect(doId[0]).toMatchObject({ level: "error", code: "internal_error", status: 500 });
    expect(String(id)).toBe(doId[0]?.requestId); // literal, não "parece"
  });

  it("⭐ 500 com requestId do chamador: loga exatamente esse ID, uma vez", () => {
    const id = "req-do-chamador-3971";
    const res = fail("internal_error", "Falhou.", 500, { requestId: id });

    expect(res.headers.get("X-Request-Id")).toBe(id);
    const doId = linhasDoId(id);
    expect(doId).toHaveLength(1);
    expect(doId[0]).toMatchObject({ level: "error", code: "internal_error", status: 500 });
  });

  it("4xx não grava linha: recusa esperada não enche o log", () => {
    const res = fail("validation_error", "Dados inválidos.", 400, { requestId: "req-400" });

    expect(res.headers.get("X-Request-Id")).toBe("req-400");
    expect(linhas()).toHaveLength(0);
  });

  it("rota que já logou o requestId não ganha segunda linha do fail()", () => {
    const id = "req-ja-logado-3971";
    // O que as rotas da lista fazem antes de responder: gravam a causa com o id.
    logger.error("contact-tags: leitura das tags do contato falhou", { requestId: id, cause: "boom" });

    const res = fail("internal_error", "Não foi possível carregar as tags.", 500, { requestId: id });

    expect(res.headers.get("X-Request-Id")).toBe(id);
    const doId = linhasDoId(id);
    expect(doId).toHaveLength(1);
    expect(doId[0]?.msg).toBe("contact-tags: leitura das tags do contato falhou");
  });

  it("sucesso não ganha log de erro", async () => {
    const { ok } = await import("./wrappers");
    const res = ok({ a: 1 }, { requestId: "req-ok-3971" });

    expect(res.status).toBe(200);
    expect(linhas()).toHaveLength(0);
  });

  it("envelope, status e corpo continuam iguais (a mudança é no log)", async () => {
    const antes = fail("internal_error", "Erro interno.", 500, { requestId: "req-corpo" });

    expect(antes.status).toBe(500);
    expect(antes.headers.get("content-type")).toContain("application/json");
    expect(await antes.text()).toBe(
      JSON.stringify({ error: { code: "internal_error", message: "Erro interno." } }),
    );

    const comDetalhes = fail("validation_error", "Confira.", 422, {
      requestId: "req-corpo-2",
      details: { campo: "nome" },
      headers: { "Retry-After": "5" },
    });
    expect(comDetalhes.status).toBe(422);
    expect(comDetalhes.headers.get("Retry-After")).toBe("5");
    expect(await comDetalhes.text()).toBe(
      JSON.stringify({ error: { code: "validation_error", message: "Confira.", details: { campo: "nome" } } }),
    );
  });

  it("5xx vindo de dentro de um catch continua 5xx, com o mesmo corpo", () => {
    let res!: ReturnType<typeof fail>;
    try {
      throw new Error("estourou");
    } catch {
      res = fail("internal_error", "Erro interno.", 503);
    }

    expect(res.status).toBe(503);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(linhasDoId(res.headers.get("X-Request-Id")!)).toHaveLength(1);
  });
});

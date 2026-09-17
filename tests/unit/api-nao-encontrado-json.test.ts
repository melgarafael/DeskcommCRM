// @vitest-environment node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  corpoPareceHtml,
  diagnosticoDeCorpoNaoJson,
  ehTimeoutDeRequisicao,
  mensagemEhSeguraParaToast,
  mensagemSeguraDeHttp,
  mensagemVisivelDeApiError,
} from "@/lib/api/erro-http";

describe("catch-all /api/[...naoEncontrado] não pode existir", () => {
  it("não intercepta POST /dry-run — medido: 404 JSON 'Rota não encontrada' em 16ms com o handler compilado", () => {
    expect(
      existsSync(join(process.cwd(), "app/api/[...naoEncontrado]/route.ts")),
    ).toBe(false);
  });
});

describe("mensagem de erro HTTP sanitizada", () => {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head></head><body>404</body></html>`;

  it("reconhece HTML e recusa no toast", () => {
    expect(corpoPareceHtml(html)).toBe(true);
    expect(mensagemEhSeguraParaToast(html)).toBe(false);
    expect(diagnosticoDeCorpoNaoJson(html)).toEqual({
      kind: "html",
      length: html.length,
    });
  });

  it("não inclui DOCTYPE nem cookie na mensagem visível", () => {
    const msg = mensagemVisivelDeApiError(
      { status: 404, message: html },
      "executar o teste",
    );
    expect(msg).toBe("Não foi possível executar o teste (HTTP 404).");
    expect(msg).not.toContain("<!DOCTYPE");
    expect(msg).not.toMatch(/cookie|sk-/i);
  });

  it("preserva mensagem curta e segura do envelope JSON", () => {
    expect(
      mensagemVisivelDeApiError(
        { status: 422, message: "Version não encontrada." },
        "executar o teste",
      ),
    ).toBe("Version não encontrada.");
  });

  it("mensagem genérica do cliente não carrega body", () => {
    expect(mensagemSeguraDeHttp(404, "completar a solicitação")).toBe(
      "Não foi possível completar a solicitação (HTTP 404).",
    );
  });

  it("reconhece TimeoutError/DOMException e recusa AbortError genérico", () => {
    expect(
      ehTimeoutDeRequisicao(new DOMException("A requisição não respondeu em 120000ms.", "TimeoutError")),
    ).toBe(true);
    expect(ehTimeoutDeRequisicao(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(ehTimeoutDeRequisicao(new Error("boom"))).toBe(false);
    expect(ehTimeoutDeRequisicao({ name: "TimeoutError" })).toBe(true);
  });
});

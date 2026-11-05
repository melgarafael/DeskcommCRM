// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";

import {
  comIdDaRequisicao,
  idDaRequisicao,
  rotaComIdDaRequisicao,
} from "@/lib/api/id-da-requisicao";

/**
 * O id de UMA requisição — e o carimbo que o leva até a resposta.
 *
 * O contrato que estes casos prendem é o da issue #4107: o `X-Request-Id` da
 * resposta tem de ser o MESMO id que a rota grava no registro. Por isso o id
 * nasce no cabeçalho da requisição (uma vez) e quem monta a resposta o carimba
 * — inclusive nas respostas que não passam por `ok()`/`fail()`.
 */

const ID_DO_CLIENTE = "11111111-1111-4111-8111-111111111111";

function pedido(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://crm.exemplo.com.br/api/v1/health", { headers });
}

describe("idDaRequisicao", () => {
  it("honra o UUID de quem chamou — é o id que a outra ponta já conhece", () => {
    expect(idDaRequisicao(pedido({ "x-request-id": ID_DO_CLIENTE }))).toBe(ID_DO_CLIENTE);
  });

  it("não confia em texto livre: valor fora do formato é descartado e um id novo é cunhado", () => {
    // Cabeçalho válido (sem quebra de linha — o `Headers` recusa), mas que não
    // é UUID: é assim que um id inventado à mão tenta entrar no log.
    const forjado = "sesao-do-cliente-123";
    const id = idDaRequisicao(pedido({ "x-request-id": forjado }));

    expect(id).not.toBe(forjado);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("é idempotente na MESMA requisição: quem chamar depois recebe o mesmo id", () => {
    const req = pedido();
    const primeiro = idDaRequisicao(req);

    expect(idDaRequisicao(req)).toBe(primeiro);
    // O id é gravado na própria requisição — é assim que a rota e o wrapper
    // chegam ao mesmo valor sem passá-lo adiante à mão.
    expect(req.headers.get("x-request-id")).toBe(primeiro);
  });
});

describe("comIdDaRequisicao", () => {
  it("carimba uma Response montada à mão, sem tocar no corpo", async () => {
    const res = comIdDaRequisicao(
      new Response(JSON.stringify({ data: { status: "healthy" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      ID_DO_CLIENTE,
    );

    expect(res.headers.get("X-Request-Id")).toBe(ID_DO_CLIENTE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: "healthy" } });
  });

  it("não sobrescreve o id que a resposta já declara — `ok()`/`fail()` continuam mandando no seu", () => {
    const doWrapper = NextResponse.json({ ok: true });
    doWrapper.headers.set("X-Request-Id", "22222222-2222-4222-8222-222222222222");

    const res = comIdDaRequisicao(doWrapper, ID_DO_CLIENTE);

    // Um valor só no cabeçalho: nada de duplicata com dois ids na mesma resposta.
    expect(res.headers.get("X-Request-Id")).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("carimba redirect sem mexer no Location", () => {
    const res = comIdDaRequisicao(NextResponse.redirect("https://crm.exemplo.com.br/app"), ID_DO_CLIENTE);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://crm.exemplo.com.br/app");
    expect(res.headers.get("X-Request-Id")).toBe(ID_DO_CLIENTE);
  });
});

describe("rotaComIdDaRequisicao", () => {
  it("carimba a resposta binária/stream e o corpo continua idêntico byte a byte", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
    const GET = rotaComIdDaRequisicao(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "image/png" } });
    });

    const res = await GET(pedido({ "x-request-id": ID_DO_CLIENTE }), undefined);
    const recebido = new Uint8Array(await res.arrayBuffer());

    expect(res.headers.get("X-Request-Id")).toBe(ID_DO_CLIENTE);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Array.from(recebido)).toEqual(Array.from(bytes));
  });

  it("carimba também a resposta de ERRO montada à mão", async () => {
    const GET = rotaComIdDaRequisicao(async () => new Response(null, { status: 503 }));

    const res = await GET(pedido({ "x-request-id": ID_DO_CLIENTE }), undefined);

    expect(res.status).toBe(503);
    expect(res.headers.get("X-Request-Id")).toBe(ID_DO_CLIENTE);
  });

  it("cunha o id quando a requisição chega sem cabeçalho (fora do Next, sem proxy)", async () => {
    const visto: string[] = [];
    const GET = rotaComIdDaRequisicao(async (req) => {
      visto.push(idDaRequisicao(req));
      return new Response(null, { status: 204 });
    });

    const res = await GET(pedido(), undefined);

    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/i);
    // O handler registra o MESMO id que a resposta leva.
    expect(visto).toEqual([res.headers.get("X-Request-Id")]);
  });
});

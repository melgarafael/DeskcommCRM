import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { argumentos, bancoFalso, operacao } from "@/tests/helpers/banco-falso-da-cobranca";

import { cabecalhosDoAviso, registrarAviso } from "./aviso-cru";

const headers = (pares: Record<string, string>) => new Headers(pares);
/** O dublê do PostgREST não é um `SupabaseClient` inteiro; a função só usa `from`. */
const comoAdmin = (cliente: unknown) => cliente as SupabaseClient;

describe("cabeçalhos do aviso", () => {
  it("guarda o que serve ao diagnóstico e derruba credencial, sessão e assinatura", () => {
    expect(
      cabecalhosDoAviso(
        headers({
          "X-Correlation-Id": "corr-1",
          "content-type": "application/json",
          authorization: "Bearer segredo",
          cookie: "sessao=1",
          "asaas-access-token": "token_do_aviso",
          "stripe-signature": "t=1,v1=ab",
          "x-api-key": "chave",
        }),
        true,
      ),
    ).toEqual({ "x-correlation-id": "corr-1", "content-type": "application/json" });
  });

  it("origem que não se autenticou não grava cabeçalho nenhum", () => {
    expect(cabecalhosDoAviso(headers({ "x-correlation-id": "corr-1" }), false)).toBeNull();
  });
});

describe("registrarAviso", () => {
  const aviso = {
    provedor: "stripe",
    corpo: '{"id":"evt_1", "nome":"João"}',
    valida: true,
    headers: headers({ "x-correlation-id": "corr-1", "stripe-signature": "t=1,v1=ab" }),
    assinatura: "t=1,v1=ab",
    externalId: "evt_1",
    eventType: "invoice.paid",
    status: "received" as const,
  };

  it("grava o corpo recebido sem tocá-lo, com os cabeçalhos filtrados", async () => {
    const banco = bancoFalso(() => ({ data: { id: "linha-1", status: "received" } }));
    expect(await registrarAviso(comoAdmin(banco.cliente), aviso)).toEqual({ id: "linha-1", status: "received" });
    expect(argumentos(banco.cadeias[0]!, "insert")?.[0]).toEqual({
      organization_id: null,
      provider: "stripe",
      raw_body: '{"id":"evt_1", "nome":"João"}',
      headers: { "x-correlation-id": "corr-1" },
      signature_header: "t=1,v1=ab",
      valid_signature: true,
      external_id: "evt_1",
      event_type: "invoice.paid",
      status: "received",
      error_message: null,
    });
  });

  it("recusa: sem cabeçalho, sem assinatura e com o motivo nomeado", async () => {
    const banco = bancoFalso(() => ({ data: { id: "linha-2", status: "error" } }));
    await registrarAviso(comoAdmin(banco.cliente), {
      ...aviso,
      valida: false,
      assinatura: null,
      externalId: null,
      eventType: null,
      status: "error",
      erro: "corpo_vazio",
    });
    expect(argumentos(banco.cadeias[0]!, "insert")?.[0]).toMatchObject({
      raw_body: '{"id":"evt_1", "nome":"João"}',
      headers: null,
      signature_header: null,
      valid_signature: false,
      error_message: "corpo_vazio",
    });
  });

  it("reentrega (23505): devolve a linha existente e NÃO regrava o corpo dela", async () => {
    const banco = bancoFalso((c) =>
      operacao(c) === "insert" ? { error: { code: "23505", message: "dup" } } : { data: { id: "linha-1", status: "processed" } },
    );
    expect(await registrarAviso(comoAdmin(banco.cliente), aviso)).toEqual({ id: "linha-1", status: "processed" });
    expect(banco.cadeias.map(operacao)).toEqual(["insert", "select"]);
    const filtros = banco.cadeias[1]?.passos.filter((p) => p.metodo === "eq").map((p) => p.args);
    expect(filtros).toEqual([["provider", "stripe"], ["external_id", "evt_1"]]);
  });

  it("erro que não é reentrega devolve 'erro' (quem chamou decide o HTTP)", async () => {
    const banco = bancoFalso(() => ({ error: { code: "42P01", message: "sem tabela" } }));
    expect(await registrarAviso(comoAdmin(banco.cliente), aviso)).toBe("erro");
  });
});

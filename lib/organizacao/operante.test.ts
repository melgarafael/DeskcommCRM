import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/types";

import {
  OrgNaoOperanteError,
  STATUS_OPERANTE,
  TIPOS_DE_SUSPENSAO,
  assertOrgOperante,
  ehOperante,
  idsDeOrgsParadas,
} from "./operante";

/** Dublê do PostgREST: registra a cadeia e resolve no resultado (thenable + maybeSingle). */
function banco(resultado: { data: unknown; error: { message: string } | null }) {
  const chamadas: unknown[][] = [];
  const cadeia: Record<string, unknown> = {
    then: (resolver: (v: unknown) => unknown) => Promise.resolve(resultado).then(resolver),
    maybeSingle: async () => resultado,
  };
  for (const metodo of ["select", "eq", "neq"]) {
    cadeia[metodo] = (...args: unknown[]) => {
      chamadas.push([metodo, ...args]);
      return cadeia;
    };
  }
  const db = {
    from: (tabela: string) => {
      chamadas.push(["from", tabela]);
      return cadeia;
    },
  } as unknown as SupabaseClient;
  return { db, chamadas };
}

describe("ehOperante — a régua única", () => {
  it("só 'active' opera", () => {
    expect(STATUS_OPERANTE).toBe("active");
    expect(ehOperante("active")).toBe(true);
  });
  it.each(["suspended", "redacted", "archived", "status_que_ainda_nao_existe", "ACTIVE", "", null, undefined])(
    "%s não opera (falha fechada)",
    (status) => expect(ehOperante(status as string | null | undefined)).toBe(false),
  );
  it("os tipos de suspensão são os do CHECK de organizations.suspended_kind", () => {
    expect([...TIPOS_DE_SUSPENSAO]).toEqual(["administrativa", "cobranca"]);
  });
});

describe("idsDeOrgsParadas", () => {
  it("pede as orgs com status diferente de 'active' e devolve só os ids", async () => {
    const { db, chamadas } = banco({ data: [{ id: "o1" }, { id: "o2" }], error: null });
    await expect(idsDeOrgsParadas(db)).resolves.toEqual(["o1", "o2"]);
    expect(chamadas).toEqual([["from", "organizations"], ["select", "id"], ["neq", "status", "active"]]);
  });
  it("erro de leitura LANÇA — nunca vira 'nenhuma org parada'", async () => {
    const { db } = banco({ data: null, error: { message: "timeout" } });
    await expect(idsDeOrgsParadas(db)).rejects.toThrow(/idsDeOrgsParadas: timeout/);
  });
});

describe("assertOrgOperante", () => {
  it("org ativa passa", async () => {
    const { db } = banco({ data: { status: "active" }, error: null });
    await expect(assertOrgOperante(db, "o1")).resolves.toBeUndefined();
  });
  it("org suspensa lança OrgNaoOperanteError: ApiError 403 org_suspended, terminal", async () => {
    const { db } = banco({ data: { status: "suspended" }, error: null });
    const erro = await assertOrgOperante(db, "o1").catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(OrgNaoOperanteError);
    // A rota /messages só traduz ApiError em resposta; o agent-worker só cancela
    // sem retry quem tem `terminal === true`. `status` é o HTTP, nunca o da org.
    expect(erro).toBeInstanceOf(ApiError);
    expect(erro).toMatchObject({
      status: 403,
      code: "org_suspended",
      terminal: true,
      organizationId: "o1",
      orgStatus: "suspended",
    });
  });
  it("org que não aparece é não operante (falha fechada)", async () => {
    const { db } = banco({ data: null, error: null });
    await expect(assertOrgOperante(db, "o1")).rejects.toMatchObject({ code: "org_suspended", orgStatus: null });
  });
  it("erro de leitura lança erro COMUM, não OrgNaoOperanteError", async () => {
    const { db } = banco({ data: null, error: { message: "boom" } });
    const erro = await assertOrgOperante(db, "o1").catch((e: unknown) => e);
    expect(erro).not.toBeInstanceOf(OrgNaoOperanteError);
    expect(String(erro)).toMatch(/assertOrgOperante: boom/);
  });
});

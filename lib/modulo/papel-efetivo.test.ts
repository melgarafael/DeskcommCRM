/**
 * Papel efetivo do token de módulo (Spec 33, F3, tarefa 4): min(teto, papel ATUAL da pessoa).
 */
import { describe, expect, it } from "vitest";

import type { Role } from "@/lib/auth/types";

import { lerPapelAtualDaPessoa, menorPapel, papelEfetivoDoModulo } from "./papel-efetivo";

describe("papelEfetivoDoModulo", () => {
  it("com pessoa: admin vale admin (o limite é o papel de quem clica, ADR-0005 D4)", () => {
    expect(papelEfetivoDoModulo({ papelDoToken: "viewer", papelDaPessoa: "admin" })).toBe("admin");
  });

  it("com pessoa: manager fica manager; agent e viewer ficam como são (rebaixada vira menos)", () => {
    expect(papelEfetivoDoModulo({ papelDoToken: "viewer", papelDaPessoa: "manager" })).toBe("manager");
    expect(papelEfetivoDoModulo({ papelDoToken: "viewer", papelDaPessoa: "agent" })).toBe("agent");
    expect(papelEfetivoDoModulo({ papelDoToken: "viewer", papelDaPessoa: "viewer" })).toBe("viewer");
  });

  it("com pessoa: ai_operator (entre agent e manager) também vale como está", () => {
    expect(papelEfetivoDoModulo({ papelDoToken: "viewer", papelDaPessoa: "ai_operator" })).toBe("ai_operator");
  });

  it("sem pessoa: nunca passa de agent nem do papel do token", () => {
    for (const token of ["manager", "admin"] as Role[]) {
      expect(papelEfetivoDoModulo({ papelDoToken: token })).toBe("agent");
      expect(papelEfetivoDoModulo({ papelDoToken: token, papelDaPessoa: null })).toBe("agent");
    }
    expect(papelEfetivoDoModulo({ papelDoToken: "viewer" })).toBe("viewer");
  });

  it("menorPapel é simétrico", () => {
    expect(menorPapel("admin", "viewer")).toBe("viewer");
    expect(menorPapel("viewer", "admin")).toBe("viewer");
  });
});

/** Dublê mínimo de `from().select().eq().eq().is().maybeSingle()` que anota os filtros. */
function banco(resposta: { data: unknown; error: unknown } | "lanca") {
  const filtros: Array<[string, unknown]> = [];
  let tabela = "";
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = (col: string, v: unknown) => (filtros.push([col, v]), c);
  c.is = (col: string, v: unknown) => (filtros.push([col, v]), c);
  c.maybeSingle = async () => {
    if (resposta === "lanca") throw new Error("boom");
    return resposta;
  };
  return {
    filtros,
    tabela: () => tabela,
    client: {
      from: (t: string) => {
        tabela = t;
        return c;
      },
    } as never,
  };
}

describe("lerPapelAtualDaPessoa", () => {
  it("filtra organização, pessoa e vínculo não revogado, na tabela de vínculos", async () => {
    const b = banco({ data: { role: "agent" }, error: null });
    expect(await lerPapelAtualDaPessoa(b.client, "org-1", "user-1")).toBe("agent");
    expect(b.tabela()).toBe("user_organizations");
    expect(b.filtros).toEqual([
      ["organization_id", "org-1"],
      ["user_id", "user-1"],
      ["revoked_at", null],
    ]);
  });

  it("pessoa removida (sem linha), erro, exceção e papel desconhecido dão null", async () => {
    expect(await lerPapelAtualDaPessoa(banco({ data: null, error: null }).client, "o", "u")).toBeNull();
    expect(await lerPapelAtualDaPessoa(banco({ data: null, error: { message: "x" } }).client, "o", "u")).toBeNull();
    expect(await lerPapelAtualDaPessoa(banco("lanca").client, "o", "u")).toBeNull();
    expect(await lerPapelAtualDaPessoa(banco({ data: { role: "owner" }, error: null }).client, "o", "u")).toBeNull();
    expect(await lerPapelAtualDaPessoa(banco({ data: { role: "toString" }, error: null }).client, "o", "u")).toBeNull();
  });
});

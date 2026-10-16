import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { conferirResponsavel } from "./responsavel";

/**
 * Um client de mentira que GUARDA os filtros recebidos: o teste confere a
 * régua (organização, revogado, papel) e não só o desfecho — senão um filtro
 * esquecido passaria verde enquanto a consulta de mentira devolvesse a linha.
 */
function clienteFalso(resposta: { data: unknown; error: unknown }) {
  const filtros: Array<[string, string, unknown]> = [];
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => (filtros.push(["eq", coluna, valor]), consulta),
    is: (coluna: string, valor: unknown) => (filtros.push(["is", coluna, valor]), consulta),
    neq: (coluna: string, valor: unknown) => (filtros.push(["neq", coluna, valor]), consulta),
    maybeSingle: async () => resposta,
  };
  const tabelas: string[] = [];
  const db = {
    from: (tabela: string) => (tabelas.push(tabela), consulta),
  } as unknown as SupabaseClient;
  return { db, filtros, tabelas };
}

describe("conferirResponsavel — quem pode receber uma tarefa", () => {
  it("⭐ membro ativo da organização é aceito, e a régua é a da lista de responsáveis", async () => {
    const { db, filtros, tabelas } = clienteFalso({ data: { user_id: "u1" }, error: null });

    expect(await conferirResponsavel(db, "org-1", "u1")).toBe("aceito");
    expect(tabelas).toEqual(["user_organizations"]);
    expect(filtros).toEqual([
      ["eq", "organization_id", "org-1"],
      ["eq", "user_id", "u1"],
      ["is", "revoked_at", null],
      ["neq", "role", "viewer"],
    ]);
  });

  it("quem não aparece na equipe (outra organização, revogado, viewer) é recusado", async () => {
    const { db } = clienteFalso({ data: null, error: null });
    expect(await conferirResponsavel(db, "org-1", "u-de-fora")).toBe("fora_da_equipe");
  });

  it("erro do banco não vira aceite", async () => {
    const { db } = clienteFalso({ data: null, error: { message: "timeout" } });
    expect(await conferirResponsavel(db, "org-1", "u1")).toBe("falha_na_consulta");
  });
});

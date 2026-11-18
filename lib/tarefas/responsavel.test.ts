import { describe, expect, it } from "vitest";

import type { Db } from "@/lib/db";

import { conferirResponsavel } from "./responsavel";

/**
 * A RÉGUA de quem pode ser responsável, agora sobre a porta SQL (#3715).
 *
 * Antes este arquivo montava a CADEIA do PostgREST (`from().select().eq()…`) e
 * conferia os filtros recebidos. A cadeia morreu com o cliente; o que a função
 * manda para o banco agora é SQL com parâmetros, e o teste passa a conferir
 * duas coisas no `Db` falso: os PARÂMETROS vinculados (organização e pessoa — o
 * isolamento entre tenants) e as cláusulas que a régua exige (`revoked_at is
 * null`, `role <> 'viewer'`). A prova contra Postgres de verdade — membro
 * aceito, viewer recusado, revogado recusado, gente de outra organização
 * recusada — vive em `tests/invariants/tarefas-piloto-pg.test.ts`, porque banco
 * de mentira nunca provou isolamento.
 */
function bancoFalso(resposta: { linha?: unknown; erro?: Error }): {
  db: Db;
  consultas: Array<{ sql: string; parametros: readonly unknown[] }>;
} {
  const consultas: Array<{ sql: string; parametros: readonly unknown[] }> = [];
  const db: Db = {
    async query() {
      throw new Error("conferirResponsavel lê UMA linha — não deveria chamar query()");
    },
    async queryOne(sql, parametros = []) {
      consultas.push({ sql, parametros });
      if (resposta.erro) throw resposta.erro;
      return (resposta.linha ?? null) as never;
    },
  };
  return { db, consultas };
}

describe("conferirResponsavel — quem pode receber uma tarefa", () => {
  it("⭐ membro ativo da organização é aceito, e a régua é a da lista de responsáveis", async () => {
    const { db, consultas } = bancoFalso({ linha: { user_id: "u1" } });

    expect(await conferirResponsavel(db, "org-1", "u1")).toBe("aceito");
    expect(consultas).toHaveLength(1);
    const { sql, parametros } = consultas[0]!;
    // A organização vai por PARÂMETRO ($1), nunca interpolada: é o que impede
    // um id vindo da requisição de virar outra cláusula.
    expect(parametros).toEqual(["org-1", "u1"]);
    expect(sql).toContain("from user_organizations");
    expect(sql).toContain("organization_id = $1");
    expect(sql).toContain("user_id = $2");
    expect(sql).toContain("revoked_at is null");
    expect(sql).toContain("role <> 'viewer'");
    expect(sql).toContain("limit 1");
  });

  it("quem não aparece na equipe (outra organização, revogado, viewer) é recusado", async () => {
    const { db } = bancoFalso({ linha: null });
    expect(await conferirResponsavel(db, "org-1", "u-de-fora")).toBe("fora_da_equipe");
  });

  it("erro do banco não vira aceite", async () => {
    const { db } = bancoFalso({ erro: new Error("timeout") });
    expect(await conferirResponsavel(db, "org-1", "u1")).toBe("falha_na_consulta");
  });
});

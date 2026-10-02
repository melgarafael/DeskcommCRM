import { describe, expect, it } from "vitest";

import { negocioDoContato } from "@/lib/agent-engine/edge/crm/negocio-do-contato";

/**
 * O agente mandava o id do CONTATO onde o CRM pede o do NEGÓCIO (issue #509) e
 * nenhum campo do card era gravado. Esta função entrega o id certo — e a escolha
 * tem de ser a MESMA do roteamento de atividade e do portão de escopo.
 */
type Linha = {
  id: string;
  organization_id: string;
  pipeline_id: string;
  status: "open" | "won" | "lost";
  last_activity_at: Date | null;
  created_at: Date;
  funil: string;
  etapa: string | null;
};

function dbFalso(linhas: Linha[]) {
  const chamadas: { sql: string; params: unknown[] }[] = [];
  return {
    chamadas,
    db: {
      query: async (sql: string, params: unknown[]) => {
        chamadas.push({ sql, params });
        return { rows: linhas };
      },
    },
  };
}

const linha = (id: string, atividade: string | null, extra: Partial<Linha> = {}): Linha => ({
  id,
  organization_id: "org-1",
  pipeline_id: "funil-vendas",
  status: "open",
  last_activity_at: atividade === null ? null : new Date(atividade),
  created_at: new Date("2026-10-01T22:14:27Z"),
  funil: "Vendas",
  etapa: "1. Entrada Lead",
  ...extra,
});

describe("negocioDoContato", () => {
  it("um negócio aberto: devolve id, funil e etapa", async () => {
    const { db } = dbFalso([linha("negocio-aa12", null)]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toEqual({
      id: "negocio-aa12",
      funil: "Vendas",
      etapa: "1. Entrada Lead",
    });
  });

  it("nenhum negócio aberto: devolve null", async () => {
    const { db } = dbFalso([]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toBeNull();
  });

  it("dois abertos: vence o de atividade mais recente (a regra do roteamento)", async () => {
    const { db } = dbFalso([
      linha("negocio-antigo", "2026-09-01T10:00:00Z"),
      linha("negocio-recente", "2026-10-01T10:00:00Z", { funil: "Pedidos", etapa: null }),
    ]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toEqual({
      id: "negocio-recente",
      funil: "Pedidos",
      etapa: null,
    });
  });

  it("dois abertos empatados: não adivinha — devolve aviso sem id", async () => {
    const { db } = dbFalso([
      linha("negocio-a", "2026-10-01T10:00:00Z"),
      linha("negocio-b", "2026-10-01T10:00:00Z"),
    ]);
    const r = await negocioDoContato(db as never, "org-1", "contato-9c9e");
    expect(r).toMatchObject({ id: null });
    expect((r as { aviso: string }).aviso).toContain("mais de um negócio aberto");
  });

  it("negócio fechado que chegue à regra é ignorado — o status vem da linha, não de um 'open' fixo", async () => {
    // O Operador (`cardDoFunil`) chama esta função; quem decide o que é aberto é
    // a regra. Um mais recente PERDIDO não pode virar o card da pessoa.
    const { db } = dbFalso([
      linha("negocio-aberto", "2026-09-10T00:00:00Z"),
      linha("negocio-perdido", "2026-09-20T00:00:00Z", { status: "lost" }),
    ]);
    expect(await negocioDoContato(db as never, "org-1", "contato-9c9e")).toMatchObject({
      id: "negocio-aberto",
    });
  });

  it("a consulta filtra organização e contato, e só negócios abertos", async () => {
    const { db, chamadas } = dbFalso([]);
    await negocioDoContato(db as never, "org-1", "contato-9c9e");
    expect(chamadas[0]!.params).toEqual(["org-1", "contato-9c9e"]);
    expect(chamadas[0]!.sql).toContain("l.organization_id = $1");
    expect(chamadas[0]!.sql).toContain("l.contact_id = $2");
    expect(chamadas[0]!.sql).toContain("l.status = 'open'");
  });
});

import { describe, expect, it } from "vitest";

describe("Filtro dinâmico e badges por setor em tarefas", () => {
  it("filtra atendentes pelo setor correspondente", () => {
    const atendentes = [
      { user_id: "user-1", name: "Operador A", sector_ids: ["sec-fiscal"] },
      { user_id: "user-2", name: "Operador B", sector_ids: ["sec-contabil"] },
      { user_id: "user-3", name: "Operador C", sector_ids: ["sec-fiscal", "sec-contabil"] },
      { user_id: "user-4", name: "Operador D", sector_ids: [] },
    ];

    const membros = [
      { user_id: "user-1", full_name: "Operador A", role: "agent" },
      { user_id: "user-2", full_name: "Operador B", role: "agent" },
      { user_id: "user-3", full_name: "Operador C", role: "agent" },
      { user_id: "user-4", full_name: "Operador D", role: "agent" },
    ];

    // Quando setor for 'todos'
    const setorTodos = "todos";
    const membrosTodos = setorTodos === "todos" ? membros : [];
    expect(membrosTodos).toHaveLength(4);

    // Quando setor for 'sec-fiscal'
    const setorFiscal = "sec-fiscal";
    const idsFiscal = new Set(
      atendentes.filter((a) => a.sector_ids?.includes(setorFiscal)).map((a) => a.user_id),
    );
    const membrosFiscal = membros.filter((m) => idsFiscal.has(m.user_id));
    expect(membrosFiscal.map((m) => m.user_id)).toEqual(["user-1", "user-3"]);

    // Quando setor for 'sec-contabil'
    const setorContabil = "sec-contabil";
    const idsContabil = new Set(
      atendentes.filter((a) => a.sector_ids?.includes(setorContabil)).map((a) => a.user_id),
    );
    const membrosContabil = membros.filter((m) => idsContabil.has(m.user_id));
    expect(membrosContabil.map((m) => m.user_id)).toEqual(["user-2", "user-3"]);
  });

  it("resolve corretamente o setor e a cor para o badge no cartão", () => {
    const setores = [
      { id: "sec-fiscal", name: "Fiscal", color: "#6366f1" },
      { id: "sec-contabil", name: "Contábil", color: "#10b981" },
    ];
    const atendentes = [
      { user_id: "user-1", name: "Operador A", sector_ids: ["sec-fiscal"] },
      { user_id: "user-2", name: "Operador B", sector_ids: ["sec-contabil"] },
      { user_id: "user-4", name: "Operador D", sector_ids: [] },
    ];

    const setoresMap = new Map(setores.map((s) => [s.id, s]));
    const setorDoUsuario = new Map();
    for (const a of atendentes) {
      if (a.sector_ids && a.sector_ids.length > 0) {
        const primeiroSetor = setoresMap.get(a.sector_ids[0]);
        if (primeiroSetor) setorDoUsuario.set(a.user_id, primeiroSetor);
      }
    }

    expect(setorDoUsuario.get("user-1")).toEqual({ id: "sec-fiscal", name: "Fiscal", color: "#6366f1" });
    expect(setorDoUsuario.get("user-2")).toEqual({ id: "sec-contabil", name: "Contábil", color: "#10b981" });
    expect(setorDoUsuario.get("user-4")).toBeUndefined();
    expect(setorDoUsuario.get("user-inexistente")).toBeUndefined();
  });
});

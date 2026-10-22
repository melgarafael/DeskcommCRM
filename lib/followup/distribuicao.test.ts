import { describe, expect, it } from "vitest";

import {
  escolherSaidaDoDivisor,
  hashEstavel,
  indicePorPeso,
  ordemDeEscolha,
  type CandidatoDaDistribuicao,
} from "./distribuicao";
import {
  DISTRIBUTE_ASSIGNED_BRANCH_ID,
  flowGraphSchema,
  nodeBranches,
  type FlowEdge,
  type FlowNode,
} from "./graph-schema";
import { processNode, type EnrollmentRow, type LeadFacts } from "./node-handlers";

const c = (userId: string, currentLoad: number, lastAssignedAt: number | null, peso?: number): CandidatoDaDistribuicao => ({
  userId,
  currentLoad,
  lastAssignedAt,
  ...(peso !== undefined ? { peso } : {}),
});

describe("hashEstavel / indicePorPeso", () => {
  it("é determinístico para a mesma chave", () => {
    expect(hashEstavel("inscricao-1:no-2")).toBe(hashEstavel("inscricao-1:no-2"));
    expect(indicePorPeso([1, 1, 1], "x")).toBe(indicePorPeso([1, 1, 1], "x"));
  });

  it("respeita a proporção dos pesos numa amostra grande", () => {
    const contagem = [0, 0];
    for (let i = 0; i < 4000; i++) contagem[indicePorPeso([75, 25], `chave-${i}`)]!++;
    const fatia = contagem[0]! / 4000;
    expect(fatia).toBeGreaterThan(0.7);
    expect(fatia).toBeLessThan(0.8);
  });

  it("lista vazia não escolhe nada", () => {
    expect(indicePorPeso([], "x")).toBe(-1);
  });
});

describe("escolherSaidaDoDivisor", () => {
  const saidas = [
    { id: "sp_a", label: "A", peso: 50 },
    { id: "sp_b", label: "B", peso: 50 },
  ];

  it("a mesma inscrição sai sempre pela mesma saída (replay do tick)", () => {
    const primeira = escolherSaidaDoDivisor(saidas, "insc-9:no-1");
    for (let i = 0; i < 5; i++) expect(escolherSaidaDoDivisor(saidas, "insc-9:no-1")).toBe(primeira);
  });

  it("usa as duas saídas ao longo de muitas inscrições", () => {
    const vistas = new Set<string | null>();
    for (let i = 0; i < 200; i++) vistas.add(escolherSaidaDoDivisor(saidas, `insc-${i}:no-1`));
    expect(vistas).toEqual(new Set(["sp_a", "sp_b"]));
  });
});

describe("ordemDeEscolha", () => {
  it("rodízio: quem está há mais tempo sem receber vem primeiro", () => {
    const ordem = ordemDeEscolha("rodizio", [c("ana", 0, 2_000), c("bia", 5, 1_000), c("caio", 0, null)], "k");
    expect(ordem).toEqual(["caio", "bia", "ana"]);
  });

  it("menor carga: quem tem menos conversas abertas vem primeiro", () => {
    const ordem = ordemDeEscolha("carga", [c("ana", 3, null), c("bia", 1, null), c("caio", 2, null)], "k");
    expect(ordem[0]).toBe("bia");
    expect(ordem).toHaveLength(3);
  });

  it("aleatório e percentual: determinísticos e cobrem todos os candidatos", () => {
    const candidatos = [c("ana", 0, null, 80), c("bia", 0, null, 20)];
    for (const modo of ["aleatorio", "percentual"] as const) {
      const a = ordemDeEscolha(modo, candidatos, "insc-1:no-1");
      expect(ordemDeEscolha(modo, [...candidatos].reverse(), "insc-1:no-1")).toEqual(a);
      expect([...a].sort()).toEqual(["ana", "bia"]);
    }
  });

  it("percentual respeita os pesos como primeira escolha", () => {
    let ana = 0;
    for (let i = 0; i < 2000; i++) {
      if (ordemDeEscolha("percentual", [c("ana", 0, null, 80), c("bia", 0, null, 20)], `k-${i}`)[0] === "ana") ana++;
    }
    expect(ana / 2000).toBeGreaterThan(0.74);
    expect(ana / 2000).toBeLessThan(0.86);
  });

  it("sem candidatos não escolhe ninguém", () => {
    expect(ordemDeEscolha("rodizio", [], "k")).toEqual([]);
  });
});

describe("blocos de distribuição no grafo", () => {
  const pos = { x: 0, y: 0 };
  const distribute: FlowNode = {
    id: "dist",
    type: "distribute",
    label: "Distribuir",
    position: pos,
    config: { destino: { tipo: "equipe", modo: "rodizio", membros: [] }, so_disponiveis: true },
  };
  const split: FlowNode = {
    id: "div",
    type: "split",
    label: "Dividir",
    position: pos,
    config: {
      saidas: [
        { id: "sp_a", label: "A", peso: 1 },
        { id: "sp_b", label: "B", peso: 1 },
      ],
    },
  };

  it("o schema aceita os dois nós num grafo", () => {
    const parsed = flowGraphSchema.safeParse({
      nodes: [
        { id: "t", type: "trigger", label: "Início", position: pos, config: {} },
        distribute,
        split,
      ],
      edges: [],
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("o distribute tem as saídas Distribuído e Ninguém disponível", () => {
    const ramos = nodeBranches(distribute);
    expect(ramos.map((r) => r.id)).toEqual([DISTRIBUTE_ASSIGNED_BRANCH_ID, "else"]);
    expect(ramos.map((r) => r.label)).toEqual(["Distribuído", "Ninguém disponível"]);
  });

  const enrollment = { id: "insc-1", steps_taken: 0 } as unknown as EnrollmentRow;
  const lead: LeadFacts = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null };
  const clock = () => new Date("2026-10-22T12:00:00Z");
  const edges: FlowEdge[] = [
    { id: "e1", source: "dist", target: "ok", priority: 0, condition: { type: "branch", branch_id: "assigned" } },
    { id: "e2", source: "dist", target: "aviso", priority: 0, condition: { type: "always" } },
  ];

  it("quem recebeu segue por Distribuído; quem não recebeu, por Ninguém disponível", () => {
    const sim = processNode({ node: distribute, edges, enrollment, lead, clock, distribuido: true });
    const nao = processNode({ node: distribute, edges, enrollment, lead, clock, distribuido: false });
    expect(sim).toMatchObject({ kind: "advance", next_node_id: "ok" });
    expect(nao).toMatchObject({ kind: "advance", next_node_id: "aviso" });
  });

  it("quem recebeu NUNCA cai no caminho de Ninguém disponível quando a seta de Distribuído falta", () => {
    const soEscape = edges.filter((e) => e.condition.type === "always");
    const r = processNode({ node: distribute, edges: soEscape, enrollment, lead, clock, distribuido: true });
    expect(r.kind).toBe("complete");
  });

  it("o divisor manda a inscrição por uma das saídas ligadas", () => {
    const e: FlowEdge[] = [
      { id: "a", source: "div", target: "na", priority: 0, condition: { type: "branch", branch_id: "sp_a" } },
      { id: "b", source: "div", target: "nb", priority: 0, condition: { type: "branch", branch_id: "sp_b" } },
    ];
    const r = processNode({ node: split, edges: e, enrollment, lead, clock });
    expect(r.kind).toBe("advance");
    expect(["na", "nb"]).toContain((r as { next_node_id: string }).next_node_id);
  });
});

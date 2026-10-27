import { describe, expect, it } from "vitest";

import { ACOES_DA_IA, INSTRUCAO_DA_ACAO, ROTULO_DA_ACAO_DA_IA, ehAcaoDaIa, minutosParaLiberar } from "@/lib/agencia/ia/catalogo";
import { normalizarProposta, problemaNaProposta, propostaSchema, type Proposta } from "@/lib/agencia/ia/proposta";

const bloco = (chave: string, extra: Partial<Proposta["blocos"][number]> = {}): Proposta["blocos"][number] => ({
  chave,
  titulo: `Etapa ${chave}`,
  descricao: null,
  tipo: "tarefa",
  executor: "humano",
  acao_ia: null,
  prazo_em_dias: null,
  ...extra,
});

describe("IA da agência — catálogo", () => {
  it("toda ação tem rótulo e instrução", () => {
    for (const a of ACOES_DA_IA) {
      expect(ROTULO_DA_ACAO_DA_IA[a]).toBeTruthy();
      expect(INSTRUCAO_DA_ACAO[a].length).toBeGreaterThan(40);
    }
    expect(ehAcaoDaIa("roteiro")).toBe(true);
    expect(ehAcaoDaIa("criar_campanha_de_verdade")).toBe(false);
  });

  it("campanha é só texto: a instrução não pede para criar nada (I5)", () => {
    expect(INSTRUCAO_DA_ACAO.plano_de_campanha).toMatch(/RASCUNHO/);
    expect(ROTULO_DA_ACAO_DA_IA.plano_de_campanha).toMatch(/só texto/);
  });

  it("limite por hora: libera quando a mais antiga da janela completa uma hora (I8)", () => {
    const agora = new Date("2026-11-10T12:00:00Z");
    const horas = (n: number, min: number) => Array.from({ length: n }, (_, i) => new Date(agora.getTime() - (min - i) * 60_000).toISOString());
    expect(minutosParaLiberar(horas(29, 50), agora)).toBeNull();
    expect(minutosParaLiberar(horas(30, 50), agora)).toBe(10);
    expect(minutosParaLiberar(horas(3, 50), agora, 3)).toBe(10);
  });
});

describe("IA da agência — proposta do mapa", () => {
  it("o formato fecha o tamanho e o catálogo (I2)", () => {
    expect(propostaSchema.safeParse({ blocos: [], ligacoes: [], resumo: "x" }).success).toBe(false);
    expect(propostaSchema.safeParse({ blocos: Array.from({ length: 26 }, (_, i) => bloco(`b${i}`)), ligacoes: [], resumo: "x" }).success).toBe(false);
    expect(propostaSchema.safeParse({ blocos: [bloco("b1", { executor: "ia", acao_ia: "publicar_sem_perguntar" as never })], ligacoes: [], resumo: "x" }).success).toBe(false);
    expect(propostaSchema.safeParse({ blocos: [bloco("b1")], ligacoes: [], resumo: "Plano" }).success).toBe(true);
  });

  it("marco nunca é da IA, e IA sem ação ganha a padrão", () => {
    const p = normalizarProposta({
      blocos: [bloco("m", { tipo: "marco", executor: "ia", acao_ia: "legenda" }), bloco("i", { executor: "ia" }), bloco("h", { acao_ia: "roteiro" })],
      ligacoes: [],
      resumo: "",
    });
    expect(p.blocos.map((b) => [b.executor, b.acao_ia])).toEqual([
      ["humano", null],
      ["ia", "roteiro"],
      ["humano", null],
    ]);
  });

  it("recusa chave repetida, seta para o nada, laço e círculo — inclusive com blocos que já existem (I3)", () => {
    const base = { resumo: "", blocos: [bloco("b1"), bloco("b2")] };
    expect(problemaNaProposta({ ...base, blocos: [bloco("b1"), bloco("b1")], ligacoes: [] }, [], [])).toMatch(/repetiu/);
    expect(problemaNaProposta({ ...base, ligacoes: [{ de: "b1", para: "b9" }] }, [], [])).toMatch(/não existe/);
    expect(problemaNaProposta({ ...base, ligacoes: [{ de: "b1", para: "b1" }] }, [], [])).toMatch(/ele mesmo/);
    expect(problemaNaProposta({ ...base, ligacoes: [{ de: "b1", para: "b2" }, { de: "b2", para: "b1" }] }, [], [])).toMatch(/círculo/);
    const existentes = [{ id: "11111111-1111-4111-8111-111111111111", titulo: "Reunião" }];
    expect(problemaNaProposta({ ...base, ligacoes: [{ de: existentes[0]!.id, para: "b1" }, { de: "b1", para: "b2" }] }, existentes, [])).toBeNull();
    expect(
      problemaNaProposta({ ...base, ligacoes: [{ de: "b2", para: existentes[0]!.id }] }, [...existentes, { id: "22222222-2222-4222-8222-222222222222", titulo: "X" }], [
        { de_id: existentes[0]!.id, para_id: "22222222-2222-4222-8222-222222222222" },
      ]),
    ).toBeNull();
  });
});

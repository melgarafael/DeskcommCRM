import { describe, expect, it } from "vitest";

import { concluiAMao, contaNoCaminho, ESPECIES, ESPECIES_DE_BLOCO, especieDe } from "@/lib/agencia/mapas/blocos";
import { blocosDoModelo, MODELOS_DE_MAPA, profundidades } from "@/lib/agencia/mapas/modelos";
import { problemaNoMapa } from "@/lib/agencia/mapas/regras";

describe("mapas — paleta de blocos", () => {
  it("espécies únicas, cada uma com rótulo, frase do que faz e cor", () => {
    expect(new Set(ESPECIES).size).toBe(ESPECIES.length);
    for (const e of ESPECIES_DE_BLOCO) {
      expect(e.rotulo.length).toBeGreaterThan(2);
      expect(e.faz.length).toBeGreaterThan(10);
      expect(e.cor).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("os blocos da IA levam a ação do catálogo; a espécie desconhecida vira tarefa livre", () => {
    expect(especieDe("legenda_ia")).toMatchObject({ executor: "ia", acaoIa: "legenda" });
    expect(especieDe("nao_existe").especie).toBe("tarefa");
  });

  it("nota fica fora do caminho; só o marco se conclui à mão", () => {
    expect(contaNoCaminho("nota")).toBe(false);
    expect(contaNoCaminho("espera")).toBe(true);
    expect(concluiAMao("marco")).toBe(true);
    expect(concluiAMao("tarefa")).toBe(false);
  });
});

describe("mapas — modelos prontos", () => {
  it("cobre as três etapas do recorrente e os avulsos", () => {
    const ids = MODELOS_DE_MAPA.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["recorrente_etapa_1", "recorrente_etapa_2", "recorrente_etapa_3", "avulso_gravacao", "avulso_trafego", "avulso_site"]));
  });

  it.each(MODELOS_DE_MAPA.map((m) => [m.id, m] as const))("%s: espécies válidas, setas entre blocos do modelo e sem círculo", (_id, m) => {
    const chaves = new Set(m.blocos.map((b) => b.chave));
    for (const b of m.blocos) expect(ESPECIES).toContain(b.especie);
    for (const [de, para] of m.setas) {
      expect(chaves.has(de)).toBe(true);
      expect(chaves.has(para)).toBe(true);
    }
    const noCaminho = m.blocos.filter((b) => contaNoCaminho(especieDe(b.especie).tipo));
    expect(problemaNoMapa(noCaminho.map((b) => ({ id: b.chave, titulo: "Bloco" })), m.setas.map(([de, para]) => ({ de_id: de, para_id: para })))).toBeNull();
    // Bloco sem seta chegando é liberado logo ao publicar — é o começo do caminho (ex.: "Acesso ao CRM" na Etapa 2).
    expect(m.setas.length).toBeGreaterThan(0);
  });

  it("layout de cima para baixo: cada bloco abaixo dos que vêm antes, sem dois no mesmo lugar", () => {
    const { blocos, setas } = blocosDoModelo("recorrente_etapa_2");
    const pos = new Map(blocos.map((b) => [b.chave, b.linha]));
    for (const [de, para] of setas) expect(pos.get(para)!.y).toBeGreaterThan(pos.get(de)!.y);
    expect(new Set(blocos.map((b) => `${b.linha.x},${b.linha.y}`)).size).toBe(blocos.length);
    expect(profundidades(["a", "b", "c"], [["a", "b"], ["b", "c"], ["a", "c"]]).get("c")).toBe(2);
  });
});

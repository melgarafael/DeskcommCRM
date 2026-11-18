/**
 * A PALETA DA COR DA ETAPA (#4802, item 2) — o que a tela oferece, o que o banco
 * aceita e o número de contraste que sustenta a escolha.
 *
 * Os três modos de falha vigiados:
 *
 *   1. **Segundo vocabulário de cor.** Uma lista de hex própria para a etapa
 *      daria dois tons diferentes para a mesma ideia — a etapa «Pago» verde e a
 *      etiqueta «vip» azul-esverdeada. A paleta é a referência de
 *      `PALETA_DE_ETIQUETAS`, não uma cópia.
 *   2. **Cor que o banco recusa.** O CHECK `crm_stages_color_format` só aceita
 *      `^#[0-9a-fA-F]{6}$`; um tom fora dessa forma viraria 23514 cru na cara de
 *      quem escolheu.
 *   3. **Texto ilegível sobre a cor.** A prévia pinta o NOME da etapa sobre o
 *      tom; a frente vem de `escolheAFrente` (piso 4,5). Se alguém trocar por
 *      `#ffffff` fixo, é este arquivo que reprova — tom por tom.
 */
import { describe, expect, it } from "vitest";

import { PISOS, razaoDeContraste } from "@/lib/branding/contraste";
import {
  NOME_DO_TOM_DA_ETAPA,
  PALETA_DE_ETAPAS,
  corDaEtapaValida,
  frenteSobreACor,
  normalizarCorDaEtapa,
} from "@/lib/leads/cor-da-etapa";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";

describe("a paleta da etapa é a paleta do produto", () => {
  it("são os MESMOS oito tons, na mesma ordem — não uma cópia", () => {
    expect(PALETA_DE_ETAPAS).toBe(PALETA_DE_ETIQUETAS);
    expect([...PALETA_DE_ETAPAS]).toEqual([
      "#ffe629",
      "#ffb224",
      "#cf3716",
      "#00655a",
      "#0091ff",
      "#3e63dd",
      "#ab4aba",
      "#6f6f6f",
    ]);
  });

  it("todo tom tem NOME — escolher por «Âmbar» chega ao mesmo lugar que o círculo", () => {
    expect(Object.keys(NOME_DO_TOM_DA_ETAPA).sort()).toEqual([...PALETA_DE_ETAPAS].sort());
    expect(NOME_DO_TOM_DA_ETAPA).toEqual(NOME_DO_TOM);
  });

  it("todo tom passa pela forma que o banco aceita (CHECK crm_stages_color_format)", () => {
    for (const tom of PALETA_DE_ETAPAS) {
      expect(tom, tom).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(normalizarCorDaEtapa(tom), tom).toBe(tom.toLowerCase());
    }
  });
});

describe("o texto sobre a cor é escolhido pela régua, nunca a olho", () => {
  /**
   * A prévia desta tela pinta o nome da etapa SOBRE o tom. O piso é o de texto
   * do repo (4,5) e o pior par da paleta tem 4,75 — medido, não estimado.
   */
  it("o nome da etapa sobre cada tom passa do piso de texto em todos os oito", () => {
    const medidas = PALETA_DE_ETAPAS.map((tom) => ({
      tom,
      frente: frenteSobreACor(tom),
      razao: razaoDeContraste(frenteSobreACor(tom), tom),
    }));
    for (const { tom, frente, razao } of medidas) {
      expect(razao, `${tom} com frente ${frente}`).toBeGreaterThanOrEqual(PISOS.texto);
    }
    // O pior par é o roxo, com branco: 4,75. Se a régua mudar de lado num tom
    // claro, o número abaixo muda e este teste avisa antes da tela.
    const pior = medidas.reduce((a, b) => (a.razao <= b.razao ? a : b));
    expect(pior.tom).toBe("#ab4aba");
    expect(pior.frente).toBe("#ffffff");
    expect(pior.razao).toBeCloseTo(4.75, 2);
  });

  it("o amarelo recebe frente PRETA — branco sobre ele tem 1,26 e seria o defeito da #2373", () => {
    expect(frenteSobreACor("#ffe629")).toBe("#000000");
    expect(razaoDeContraste("#ffffff", "#ffe629")).toBeLessThan(PISOS.texto);
  });
});

describe("normalizarCorDaEtapa — a forma do banco, sem derrubar a tela", () => {
  it("aceita o hex de seis dígitos e devolve minúsculo", () => {
    expect(normalizarCorDaEtapa("#0091FF")).toBe("#0091ff");
  });

  it("o valor de hoje (`null`) e o vazio continuam sendo «sem cor»", () => {
    expect(normalizarCorDaEtapa(null)).toBeNull();
    expect(normalizarCorDaEtapa(undefined)).toBeNull();
    expect(normalizarCorDaEtapa("")).toBeNull();
    expect(normalizarCorDaEtapa("   ")).toBeNull();
  });

  it("a forma curta é EXPANDIDA — `#abc` vira `#aabbcc`, que é o que o banco aceita", () => {
    // A leitura tolera o que já estiver gravado à mão (mesma doutrina de
    // `normalizarCorDeEtiqueta`); o que sai daqui é sempre `#rrggbb`, a única
    // forma que o CHECK `crm_stages_color_format` aprova.
    expect(normalizarCorDaEtapa("#abc")).toBe("#aabbcc");
  });

  it("a forma sem cerquilha também é tolerada — o que sai daqui é sempre `#rrggbb`", () => {
    expect(normalizarCorDaEtapa("0091ff")).toBe("#0091ff");
  });

  it("lixo degrada para «sem cor» em vez de lançar", () => {
    for (const lixo of ["vermelho", "#0091ff00", "zzzzzz", 42, {}, []]) {
      expect(normalizarCorDaEtapa(lixo), JSON.stringify(lixo)).toBeNull();
    }
  });

  it("`corDaEtapaValida` é a guarda que a tela usa para pintar", () => {
    expect(corDaEtapaValida("#0091ff")).toBe(true);
    expect(corDaEtapaValida(null)).toBe(false);
    expect(corDaEtapaValida("nada")).toBe(false);
  });
});

/**
 * A PALETA E A LEITURA DA COR — medido, não escolhido a olho (issue #1271).
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * Três coisas aqui quebram em silêncio se ninguém medir:
 *
 *  1. **A paleta pode perder separação.** Trocar um tom por outro "mais bonito"
 *     não quebra nada visível para quem enxerga todas as cores e deixa duas
 *     etiquetas indistinguíveis para quem tem dicromacia — ~8% dos homens. A
 *     régua já existia no repo (`lib/branding/contraste.ts`), escrita para a cor
 *     da marca; esta fatia a aplica à paleta de etiquetas, e o caso abaixo é o
 *     que reprova quando alguém mexer nela.
 *  2. **O nome do tom pode se descolar da paleta.** A fileira da tela renderiza
 *     `PALETA_DE_ETIQUETAS` e rotula com `NOME_DO_TOM`; acrescentar um tom à
 *     lista sem o nome deixa um círculo mudo (o `?? tom` cobre a tela, e o nome
 *     vai embora sem ninguém ver).
 *  3. **A leitura pode divergir da escrita.** `settings.tags` é JSON editável à
 *     mão: a leitura precisa tolerar o que estiver lá (string, cor em caixa
 *     alta, forma curta) sem quebrar a tela inteira por causa de decoração.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DICROMACIAS,
  PISO_DE_SEPARACAO_SIMULADA,
  deltaESimulado,
  melhorFrenteSobre,
  razaoDeContraste,
} from "@/lib/branding/contraste";
import { deltaEOklab } from "@/lib/branding/rampa";
import {
  PALETA_DE_ETIQUETAS,
  chaveDaEtiqueta,
  corDeEtiquetaValida,
  coresDoVocabulario,
  estiloDoChip,
  etiquetasComCor,
  normalizarCorDeEtiqueta,
} from "@/lib/tags/cor-da-etiqueta";

const raiz = process.cwd();
/** O piso a olho nu, o dobro do de dicromacia — a mesma proporção do design system. */
const PISO_A_OLHO_NU = 0.1;

describe("a paleta de etiquetas", () => {
  it("tem oito tons, todos na forma que o banco aceita e sem repetição", () => {
    expect(PALETA_DE_ETIQUETAS).toHaveLength(8);
    expect(new Set(PALETA_DE_ETIQUETAS).size).toBe(8);
    for (const tom of PALETA_DE_ETIQUETAS) {
      // Minúsculo e com seis dígitos: é a forma que o `check` da função grava, e
      // comparar cor por igualdade exige uma forma só.
      expect(tom, tom).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("⭐ o pior par continua separável — a olho nu E sob dicromacia", () => {
    // Escolher oito tons a olho reprova: a primeira tentativa desta fatia tinha
    // dois vermelhos (#e54d2e e #c62a2f) separáveis sob deuteranopia e iguais
    // para todo mundo — e verde × magenta a ΔE 0,019, três vezes abaixo do piso.
    let piorDicromacia = Infinity;
    let piorNormal = Infinity;
    for (let i = 0; i < PALETA_DE_ETIQUETAS.length; i++) {
      for (let j = i + 1; j < PALETA_DE_ETIQUETAS.length; j++) {
        const a = PALETA_DE_ETIQUETAS[i]!;
        const b = PALETA_DE_ETIQUETAS[j]!;
        piorNormal = Math.min(piorNormal, deltaEOklab(a, b));
        piorDicromacia = Math.min(
          piorDicromacia,
          ...DICROMACIAS.map((d) => deltaESimulado(a, b)),
        );
      }
    }
    expect(piorNormal).toBeGreaterThanOrEqual(PISO_A_OLHO_NU);
    expect(piorDicromacia).toBeGreaterThanOrEqual(PISO_DE_SEPARACAO_SIMULADA);
  });

  it("todo tom aceita o texto que `melhorFrenteSobre` escolhe (WCAG AA)", () => {
    // A cor do texto NUNCA é escolha de quem configura a etiqueta: se um tom
    // entrar com contraste abaixo de 4,5 o chip sai ilegível e quem paga é quem
    // atende.
    for (const tom of PALETA_DE_ETIQUETAS) {
      expect(razaoDeContraste(melhorFrenteSobre(tom), tom), tom).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("⭐ a tela não pode ganhar um tom sem nome (nem perder um)", () => {
    // A fileira renderiza a paleta da lib e rotula com o mapa do painel: um tom
    // novo sem entrada no mapa deixa um botão sem rótulo acessível.
    const painel = readFileSync(join(raiz, "app/app/settings/tags/_painel.tsx"), "utf8");
    const bloco = painel.slice(painel.indexOf("const NOME_DO_TOM"));
    const mapa = bloco.slice(0, bloco.indexOf("};"));
    const tonsNoMapa = [...mapa.matchAll(/"?(#[0-9a-f]{6})"?:/g)].map((m) => m[1]!);
    expect(tonsNoMapa.sort()).toEqual([...PALETA_DE_ETIQUETAS].sort());
  });

  it("a fileira da tela usa a paleta da lib, não uma cópia própria", () => {
    const painel = readFileSync(join(raiz, "app/app/settings/tags/_painel.tsx"), "utf8");
    expect(painel).toContain("PALETA_DE_ETIQUETAS.map");
    expect(painel).toContain('from "@/lib/tags/cor-da-etiqueta"');
  });
});

describe("normalizarCorDeEtiqueta / corDeEtiquetaValida", () => {
  it("normaliza para `#rrggbb` minúsculo e aceita a forma curta", () => {
    expect(normalizarCorDeEtiqueta("#AABBCC")).toBe("#aabbcc");
    expect(normalizarCorDeEtiqueta("aabbcc")).toBe("#aabbcc");
    expect(normalizarCorDeEtiqueta(" #f0a ")).toBe("#ff00aa");
  });

  it("devolve null — nunca lança — para o que não é cor", () => {
    for (const ruim of ["", "   ", "verde", "#12345", "#zzzzzz", "rgb(0,0,0)", null, 42, {}, []]) {
      expect(normalizarCorDeEtiqueta(ruim), JSON.stringify(ruim)).toBeNull();
      expect(corDeEtiquetaValida(ruim)).toBe(false);
    }
  });
});

describe("etiquetasComCor / coresDoVocabulario", () => {
  const SETTINGS = {
    tags: [
      "semente-antiga", // string: a forma da lista antes da 0264
      { tag: "vip", cor: "#0091ff" },
      { tag: "  Obra  ", cor: "#E35537" }, // nome com espaço + caixa alta
      { tag: "sem-cor" },
      { tag: "cor-torta", cor: "verde" },
      { cor: "#12a594" }, // sem nome
      null,
      42,
    ],
  };

  it("devolve só o que TEM cor válida, com o nome aparado e a cor normalizada", () => {
    expect(etiquetasComCor(SETTINGS)).toEqual([
      { tag: "vip", cor: "#0091ff" },
      { tag: "Obra", cor: "#e35537" },
    ]);
  });

  it("o mapa usa a MESMA chave canônica do filtro (minúscula, sem espaço)", () => {
    // "Obra" na conversa e "obra" no vocabulário são a mesma etiqueta: sem a
    // chave canônica uma delas sairia cinza.
    expect(coresDoVocabulario(SETTINGS)).toEqual({ vip: "#0091ff", obra: "#e35537" });
    expect(chaveDaEtiqueta("  VIP  ")).toBe("vip");
  });

  it("settings ausente, torto ou sem a lista não derruba a tela", () => {
    for (const entrada of [null, undefined, {}, { tags: "vip" }, { tags: {} }, 42]) {
      expect(etiquetasComCor(entrada)).toEqual([]);
      expect(coresDoVocabulario(entrada)).toEqual({});
    }
  });
});

describe("estiloDoChip", () => {
  it("pinta fundo e borda na cor, e o texto pelo contraste", () => {
    expect(estiloDoChip("#ffe629")).toEqual({
      backgroundColor: "#ffe629",
      borderColor: "#ffe629",
      color: melhorFrenteSobre("#ffe629"),
    });
    // Âmbar claro pede texto preto; índigo, branco — o par vem da régua, não do
    // gosto de quem escolheu a etiqueta.
    expect(estiloDoChip("#ffb224")?.color).toBe("#000000");
    expect(estiloDoChip("#3e63dd")?.color).toBe("#ffffff");
  });

  it("sem cor (ou cor torta) não pinta nada — o chip sai como sempre foi", () => {
    for (const nada of [null, undefined, "", "verde"]) {
      expect(estiloDoChip(nada)).toBeUndefined();
    }
  });
});

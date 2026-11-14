import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { razaoDeContraste, PISOS } from "@/lib/branding/contraste";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";

import {
  AJUSTES_PADRAO,
  aparenciaDeSettings,
  atributosDaAparencia,
  cssDaCorSecundaria,
} from "./ajustes";
import { TEMPLATES, templatePorId } from "./catalogo";
import { cssDoTemplate, escopoDaAmostra, escopoDoTemplate } from "./css";
import { CHAVES_DE_FONTE, FONTES } from "./fontes";

/**
 * A APARÊNCIA É SÓ ESTÉTICA — e cada teste aqui vigia uma promessa disso.
 *
 *  - Quem nunca escolheu template recebe ZERO atributo e ZERO CSS: a tela é a
 *    de hoje, byte a byte.
 *  - `settings` é jsonb livre: nada que esteja lá derruba o layout de `/app`.
 *  - Nenhum template pinta o que não é dele: todo seletor carrega o id.
 *  - Os 10 passam no piso de contraste da WCAG nos DOIS modos.
 */

/** As partes de uma lista de seletores, sem quebrar a vírgula de dentro de `:is(...)`. */
function partesDoSeletor(lista: string): string[] {
  const partes: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const ch of lista) {
    if (ch === "(") profundidade += 1;
    if (ch === ")") profundidade -= 1;
    if (ch === "," && profundidade === 0) {
      partes.push(atual.trim());
      atual = "";
    } else atual += ch;
  }
  return [...partes, atual.trim()];
}

describe("aparenciaDeSettings — ler o jsonb sem confiar nele", () => {
  it("organização que nunca abriu a tela fica no padrão do produto", () => {
    expect(aparenciaDeSettings(null)).toEqual(AJUSTES_PADRAO);
    expect(aparenciaDeSettings({})).toEqual(AJUSTES_PADRAO);
    expect(aparenciaDeSettings({ branding: { accent_hex: "#123456" } })).toEqual(AJUSTES_PADRAO);
  });

  it("forma errada em qualquer nível degrada para o padrão, nunca lança", () => {
    for (const lixo of ["texto", 7, [], { aparencia: "aurora" }, { aparencia: [1, 2] }]) {
      expect(() => aparenciaDeSettings(lixo)).not.toThrow();
      expect(aparenciaDeSettings(lixo)).toEqual(AJUSTES_PADRAO);
    }
  });

  it("lê o que foi gravado e ignora chave desconhecida (versão futura)", () => {
    const lida = aparenciaDeSettings({
      aparencia: {
        template: "aurora",
        fonte: "manrope",
        raio: "arredondado",
        densidade: "compacta",
        efeitos: "sutil",
        cor_secundaria: "#7C3AED",
        chave_do_futuro: true,
      },
    });
    expect(lida).toEqual({
      template: "aurora",
      fonte: "manrope",
      raio: "arredondado",
      densidade: "compacta",
      efeitos: "sutil",
      cor_secundaria: "#7c3aed",
    });
  });

  it("valor fora da lista vira o padrão daquele campo, sem levar os outros junto", () => {
    const lida = aparenciaDeSettings({
      aparencia: { template: "nao-existe", fonte: "comic-sans", raio: "medio", cor_secundaria: "azul" },
    });
    expect(lida.template).toBeNull();
    expect(lida.fonte).toBeNull();
    expect(lida.raio).toBe("medio");
    expect(lida.cor_secundaria).toBeNull();
  });
});

describe("atributosDaAparencia — o que o marcador de /app carrega", () => {
  it("sem template e sem ajuste: nenhum atributo (a tela de hoje)", () => {
    expect(atributosDaAparencia(AJUSTES_PADRAO)).toEqual({});
  });

  it("com template e ajustes: um atributo por escolha", () => {
    expect(
      atributosDaAparencia({
        ...AJUSTES_PADRAO,
        template: "safira",
        fonte: "plex",
        raio: "compacto",
        densidade: "compacta",
        efeitos: "desligado",
      }),
    ).toEqual({
      "data-aparencia": "safira",
      "data-aparencia-fonte": "plex",
      "data-aparencia-raio": "compacto",
      "data-aparencia-densidade": "compacta",
      "data-aparencia-efeitos": "desligado",
    });
  });

  it("os valores padrão dos ajustes não viram atributo", () => {
    expect(
      atributosDaAparencia({ ...AJUSTES_PADRAO, template: "aurora", densidade: "confortavel", efeitos: "completo" }),
    ).toEqual({ "data-aparencia": "aurora" });
  });
});

describe("cssDaCorSecundaria", () => {
  it("hex válido vira uma única custom property no escopo da organização", () => {
    const css = cssDaCorSecundaria("#7c3aed");
    expect(css).toContain("--aparencia-secundaria: #7c3aed;");
    expect(css).toContain("body:has([data-marca-org])");
  });

  it("sem cor, ou com algo que não é hex, não emite nada", () => {
    expect(cssDaCorSecundaria(null)).toBeNull();
    expect(cssDaCorSecundaria("red;} body{display:none")).toBeNull();
  });
});

describe("catálogo — os 10 templates", () => {
  it("são dez, com id único no formato de atributo", () => {
    expect(TEMPLATES).toHaveLength(10);
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(10);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
  });

  it("templatePorId só conhece o catálogo", () => {
    expect(templatePorId("aurora")?.nome).toBe("Aurora");
    expect(templatePorId("__proto__")).toBeNull();
    expect(templatePorId(null)).toBeNull();
  });

  for (const t of TEMPLATES) {
    for (const modo of ["claro", "escuro"] as const) {
      describe(`${t.nome} · ${modo}`, () => {
        const c = t.cores[modo];
        it("texto principal passa 4,5:1 sobre fundo, superfície e superfície elevada", () => {
          for (const fundo of [c.fundo, c.superficie, c.elevada]) {
            expect(razaoDeContraste(c.texto, fundo)).toBeGreaterThanOrEqual(PISOS.texto);
          }
        });
        it("texto secundário passa 4,5:1 sobre fundo e superfície", () => {
          for (const fundo of [c.fundo, c.superficie]) {
            expect(razaoDeContraste(c.textoSuave, fundo)).toBeGreaterThanOrEqual(PISOS.texto);
          }
        });
        it("texto terciário passa 3:1 sobre a superfície", () => {
          expect(razaoDeContraste(c.textoSutil, c.superficie)).toBeGreaterThanOrEqual(PISOS.componente);
        });
        it("o menu é legível: item e item ativo passam 4,5:1", () => {
          expect(razaoDeContraste(c.menu.texto, c.menu.fundoSolido)).toBeGreaterThanOrEqual(PISOS.texto);
          expect(razaoDeContraste(c.menu.ativoTexto, c.menu.ativoFundoSolido)).toBeGreaterThanOrEqual(PISOS.texto);
          // Os rótulos de grupo do menu são texto pequeno: piso de TEXTO, não de componente.
          expect(razaoDeContraste(c.menu.textoSuave, c.menu.fundoSolido)).toBeGreaterThanOrEqual(PISOS.texto);
        });
      });
    }
  }
});

describe("app/app/aparencia.css — o consumidor", () => {
  const folha = readFileSync(join(process.cwd(), "app/app/aparencia.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("toda regra exige um atributo de aparência (sem escolha, nada casa)", () => {
    const seletores = [...folha.matchAll(/([^{}@;]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim());
    expect(seletores.length).toBeGreaterThan(10);
    for (const sel of seletores) {
      for (const parte of partesDoSeletor(sel)) expect(parte).toMatch(/\[data-marca-org\]\[data-aparencia/);
    }
  });

  it("cada fonte do catálogo tem a sua regra, com a MESMA pilha de lib/aparencia/fontes.ts", () => {
    for (const chave of CHAVES_DE_FONTE) {
      const regra = new RegExp(
        `\\[data-aparencia-fonte="${chave}"\\]\\)\\s*\\{\\s*--aparencia-fonte-texto: ([^;]+);`,
      ).exec(folha);
      expect(regra?.[1], chave).toBe(FONTES[chave].pilha);
    }
  });
});

describe("cssDoTemplate — o CSS que pinta a organização", () => {
  it("sem template, nenhum CSS", () => {
    expect(cssDoTemplate(null, { escopo: escopoDoTemplate("aurora") })).toBeNull();
  });

  it("emite um bloco claro e um escuro, cada um no seu seletor", () => {
    const t = templatePorId("obsidiana")!;
    const css = cssDoTemplate(t, { escopo: escopoDoTemplate(t.id) })!;
    const [[seletorClaro], [seletorEscuro]] = escopoDoTemplate(t.id) as unknown as [[string, string], [string, string]];
    expect(css).toContain(`${seletorClaro} {`);
    expect(css).toContain(`${seletorEscuro} {`);
    expect(css).toContain(`--color-bg: ${t.cores.claro.fundo};`);
    expect(css).toContain(`--color-bg: ${t.cores.escuro.fundo};`);
  });

  it("a cor de ação do template entra só quando pedida (a cor da empresa vence)", () => {
    const t = templatePorId("safira")!;
    const com = cssDoTemplate(t, { escopo: escopoDoTemplate(t.id), incluirAcento: true })!;
    const sem = cssDoTemplate(t, { escopo: escopoDoTemplate(t.id), incluirAcento: false })!;
    expect(com).toMatch(/--color-accent:/);
    expect(sem).not.toMatch(/--color-accent/);
  });

  it("a cor de ação de cada template é a dele, e não a de fábrica (semente sem cor é recusada pelo gerador)", () => {
    const fabrica = REGUA_DO_PRODUTO.rampaDoProduto[6];
    for (const t of TEMPLATES) {
      const css = cssDoTemplate(t, { escopo: escopoDoTemplate(t.id) })!;
      const acentos = [...css.matchAll(/--color-accent: (#[0-9a-f]{6});/g)].map((m) => m[1]);
      expect(acentos, t.id).toHaveLength(2);
      expect(acentos, t.id).not.toContain(fabrica);
    }
  });

  it("menu escuro em template claro troca o logo do revendedor (só nesses quatro)", () => {
    const comTroca = TEMPLATES.filter((t) =>
      cssDoTemplate(t, { escopo: escopoDoTemplate(t.id) })!.includes('[data-logo="escuro"]'),
    ).map((t) => t.id);
    expect(comTroca.sort()).toEqual(["neon", "obsidiana", "safira", "vinho"]);
  });

  it("nenhum template vaza: todo seletor carrega o id do próprio template", () => {
    for (const t of TEMPLATES) {
      for (const escopo of [escopoDoTemplate(t.id), escopoDaAmostra(t.id)]) {
        const css = cssDoTemplate(t, { escopo, incluirAcento: true })!;
        const seletores = [...css.matchAll(/^([^{}\n][^{}]*)\{/gm)].map((m) => m[1]!.trim());
        expect(seletores.length).toBeGreaterThan(0);
        for (const sel of seletores) {
          for (const parte of partesDoSeletor(sel)) expect(parte).toContain(`"${t.id}"`);
        }
      }
    }
  });

  it("os valores não carregam nada que feche a regra ou abra tag", () => {
    for (const t of TEMPLATES) {
      const css = cssDoTemplate(t, { escopo: escopoDoTemplate(t.id), incluirAcento: true })!;
      const corpos = [...css.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
      for (const corpo of corpos) {
        for (const linha of corpo.split("\n").filter((l) => l.trim())) {
          expect(linha.trim()).toMatch(
            /^(--[a-z0-9-]+|display|background-color|padding|box-shadow): [^;{}<>]+;$/,
          );
        }
      }
    }
  });
});

/**
 * A COR DA MARCA NO TEMA ESCURO — o par, do jeito que o logo já era (#2482).
 *
 * A issue mediu, com `derivarMarca` e a régua do `app/globals.css`, que uma
 * semente só força UM dos dois temas a um tom que a marca não usa:
 *
 *   | semente       | botão claro  | botão escuro                 |
 *   | `#1c261d`     | `#1c261d`    | `#8a948b` (fora da paleta)   |
 *   | `#d9ac62`     | `#655131`    | `#e9b762`                    |
 *
 * Este arquivo cobre os quatro critérios de aceite da issue:
 *
 *   1. SEM a segunda cor, o CSS é o de hoje — os dois casos da tabela acima
 *      são a régua: `#1c261d` no claro e `#8a948b` no escuro, que é
 *      EXATAMENTE o que a issue mediu antes do campo existir.
 *   2. COM as duas, o claro sai `#1c261d` e o escuro sai o tom derivado da
 *      segunda semente (`#d9ac62` ou o mais próximo que passe no piso — o
 *      valor sai da MESMA `derivarMarca`, nunca de uma literal aqui).
 *   3. A segunda cor serializa pelo mesmo caminho do `css.ts`, que é quem
 *      aplica a allowlist de forma de valor (um CSS `null` reprova aqui).
 *   4. Os DOIS escopos (instalação e organização) nos DOIS temas.
 *
 * A comparação é por BLOCO, e não pelo CSS inteiro: os dois blocos declaram o
 * mesmo conjunto de tokens (doutrina de `lib/branding/css.ts`), então o teste
 * também confere que a segunda semente não acrescenta nem remove token — ela
 * só muda o VALOR declarado no bloco escuro.
 */

import { describe, expect, it } from "vitest";

import { derivarMarca } from "@/lib/branding/contraste";
import { avisosDaMarca } from "@/lib/branding/linguagem";
import {
  cssDaMarca,
  ESCOPO_DA_INSTALACAO,
  ESCOPO_DA_ORGANIZACAO,
  type EscopoDaMarca,
} from "@/lib/branding/css";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import {
  camadaDaInstalacao,
  camadaDaOrganizacao,
  resolverMarca,
  type CamadaDeMarca,
} from "@/lib/branding/resolve";

/** Verde muito escuro — a semente CLARA da tabela da issue. */
const SEMENTE_CLARA = "#1c261d";
/** Âmbar — a semente ESCURA da tabela da issue. */
const SEMENTE_ESCURA = "#d9ac62";

/** O tom que o escuro tem HOJE quando só existe a semente verde. */
const ESCURO_DE_HOJE = "#8a948b";

/** O accent do tema escuro derivado da segunda semente, pela mesma régua. */
const ESCURO_DA_SEGUNDA = derivarMarca(SEMENTE_ESCURA, REGUA_DO_PRODUTO).escuro.accent;

type Caso = {
  readonly rotulo: string;
  readonly escopo: EscopoDaMarca;
  readonly camada: (linha: {
    accent_hex: string | null;
    accent_dark_hex: string | null;
  }) => CamadaDeMarca;
};

const CASOS: readonly Caso[] = [
  {
    rotulo: "escopo da instalação",
    escopo: ESCOPO_DA_INSTALACAO,
    camada: (linha) => camadaDaInstalacao(linha),
  },
  {
    rotulo: "escopo da organização",
    escopo: ESCOPO_DA_ORGANIZACAO,
    camada: (linha) => camadaDaOrganizacao(linha),
  },
];

/** Separa o CSS nos DOIS blocos que `cssDaMarca` emite, na ordem: claro, escuro. */
function blocos(css: string | null): { claro: string; escuro: string } {
  expect(css, "o CSS da marca foi recusado pela allowlist").not.toBeNull();
  const corte = (css as string).indexOf("\n}\n");
  expect(corte, "esperava exatamente dois blocos (claro e escuro)").toBeGreaterThan(0);
  return { claro: (css as string).slice(0, corte), escuro: (css as string).slice(corte) };
}

/** Os nomes de custom property declarados num bloco, em ordem. */
function tokens(bloco: string): string[] {
  return [...bloco.matchAll(/^\s{2}(--[\w-]+):/gm)].map((m) => m[1] ?? "");
}

function corDe(camada: CamadaDeMarca) {
  return resolverMarca([camada], REGUA_DO_PRODUTO).cor;
}

describe("cor da marca no tema escuro (#2482)", () => {
  for (const caso of CASOS) {
    describe(caso.rotulo, () => {
      it("sem a segunda cor, o CSS continua sendo o de hoje — os dois casos da tabela", () => {
        const css = cssDaMarca(corDe(caso.camada({ accent_hex: SEMENTE_CLARA, accent_dark_hex: null })), caso.escopo).css;
        const { claro, escuro } = blocos(css);

        // Tabela da issue, coluna "verde muito escuro": claro = a própria
        // semente; escuro = o verde acinzentado, que é o DEFEITO medido.
        expect(claro).toContain("--color-accent: #1c261d;");
        expect(escuro).toContain(`--color-accent: ${ESCURO_DE_HOJE};`);
        // `--color-brand` continua sendo a semente principal nos DOIS blocos.
        expect(claro).toContain("--color-brand: #1c261d;");
        expect(escuro).toContain("--color-brand: #1c261d;");
      });

      it("com as duas, o claro usa a primeira e o escuro deriva da segunda", () => {
        const css = cssDaMarca(corDe(caso.camada({ accent_hex: SEMENTE_CLARA, accent_dark_hex: SEMENTE_ESCURA })), caso.escopo).css;
        const { claro, escuro } = blocos(css);

        // Critério 2: claro `#1c261d` (o verde), escuro o tom da âmbar que
        // passa no piso — nunca mais o `#8a948b` de fora da paleta.
        expect(claro).toContain("--color-accent: #1c261d;");
        expect(escuro).toContain(`--color-accent: ${ESCURO_DA_SEGUNDA};`);
        expect(escuro).not.toContain(ESCURO_DE_HOJE);
        // A segunda semente é do escuro: o claro não pode ter sido contaminado.
        expect(claro).not.toContain(SEMENTE_ESCURA);
        // E `--color-brand` segue sendo a semente PRINCIPAL (e-mail e logo).
        expect(escuro).toContain("--color-brand: #1c261d;");
      });

      it("os dois blocos seguem declarando o MESMO conjunto de tokens", () => {
        const css = cssDaMarca(corDe(caso.camada({ accent_hex: SEMENTE_CLARA, accent_dark_hex: SEMENTE_ESCURA })), caso.escopo).css;
        const { claro, escuro } = blocos(css);
        expect(tokens(escuro)).toEqual(tokens(claro));
        expect(tokens(claro).length).toBeGreaterThan(0);
      });

      it("a segunda cor pinta igual à primeira quando as duas são a mesma", () => {
        // Controle: se o par só funcionasse para valores diferentes, o teste
        // acima provaria um caso e não a regra.
        const css = cssDaMarca(corDe(caso.camada({ accent_hex: SEMENTE_CLARA, accent_dark_hex: SEMENTE_CLARA })), caso.escopo).css;
        const { escuro } = blocos(css);
        expect(escuro).toContain("--color-accent: #8a948b;");
      });
    });
  }

  it("a segunda semente não muda a marca resolvida sem escuro nenhum", () => {
    const semSegunda = corDe(casoSemSegunda());
    expect(semSegunda?.corEscura ?? null).toBeNull();
  });
});

/**
 * "O que o sistema ajustou" com as DUAS cores — o critério 2 da issue pela
 * lista de motivos, que é o que a tela traduz, e não pelo CSS.
 *
 * Cada semente só fala do tema que pinta: a segunda não diz nada do claro, e a
 * principal deixa de falar do escuro. Sem o filtro, `#1c261d` + `#d9ac62`
 * avisava "parecida com erro e sucesso" (o erro vinha do claro da âmbar, que
 * nunca pinta; o sucesso, do escuro do verde, que deixou de pintar), e
 * `#7a5cd6` + `#333333` dizia que a cor PRINCIPAL "fica reservada ao logo".
 *
 * A distância vai nula de propósito: ela só decide a frase do `accent_deslocado`,
 * e o que este bloco vigia é QUAIS motivos entram, não como cada um é dito.
 */
describe("o que o sistema ajustou, com as duas cores (#2482)", () => {
  const sigla = (camada: CamadaDeMarca) =>
    resolverMarca([camada], REGUA_DO_PRODUTO).motivos.map((m) => `${m.codigo}|${m.tema}|${m.alvo}`);
  const textos = (camada: CamadaDeMarca) =>
    avisosDaMarca(resolverMarca([camada], REGUA_DO_PRODUTO).motivos, { claro: 0, escuro: 0 })
      .map((a) => a.texto)
      .join("\n");

  for (const caso of CASOS) {
    describe(caso.rotulo, () => {
      it("verde + âmbar: só o escuro da âmbar fala, e nenhum alerta de erro ou sucesso sobra", () => {
        const camada = caso.camada({ accent_hex: SEMENTE_CLARA, accent_dark_hex: SEMENTE_ESCURA });
        expect(sigla(camada)).toEqual(["accent_deslocado|escuro|--color-accent"]);
        expect(textos(camada)).not.toMatch(/erro|sucesso/);
      });

      it("roxo + cinza: o aviso de cor neutra é do MODO ESCURO, nunca da cor principal", () => {
        const camada = caso.camada({ accent_hex: "#7a5cd6", accent_dark_hex: "#333333" });
        expect(sigla(camada)).toEqual([
          "accent_deslocado|claro|--color-accent",
          "cor_escura_acromatica|escuro|--color-accent",
        ]);
        const texto = textos(camada);
        expect(texto).toContain("A cor do modo escuro é um tom neutro");
        expect(texto).not.toContain("reservada ao logo");
        expect(texto).not.toMatch(/atenção|erro|sucesso/);
      });

      it("controle: sem a segunda cor, os motivos são os da principal sozinha", () => {
        // Se o filtro alcançasse o caso de uma cor só, o verde perderia os
        // avisos do escuro que ele de fato pinta.
        expect(sigla(caso.camada({ accent_hex: SEMENTE_CLARA, accent_dark_hex: null }))).toEqual([
          "accent_deslocado|escuro|--color-accent",
          "redundancia_nao_cromatica_necessaria|escuro|success",
        ]);
      });
    });
  }
});

/** Camada legada (só `accent_hex`) — o formato de TODA linha gravada até hoje. */
function casoSemSegunda(): CamadaDeMarca {
  return camadaDaInstalacao({ accent_hex: SEMENTE_CLARA });
}

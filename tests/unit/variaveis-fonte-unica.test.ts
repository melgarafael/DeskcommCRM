import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderTemplate } from "@/lib/automation/template";
import { renderizar } from "@/lib/campanhas/renderizador";
import { interpolateTemplate } from "@/lib/inbox/template-vars";
import { MARCACAO_DE_VARIAVEL, marcacoesNoTexto } from "@/lib/variaveis/resolvedor";

/**
 * UMA LIGAÇÃO, NÃO QUATRO — conferido no FONTE, arquivo por arquivo.
 *
 * `variaveis-um-resolvedor.test.ts` prova que a SAÍDA é igual; este arquivo
 * prova que isso continua verdade amanhã, quando alguém "otimizar" uma tela e
 * reescrever o `replace` dentro dela. Um teste de saída sozinho não pega isso:
 * a saída fica igual até o dia em que a regra muda em um lugar só.
 *
 * As três regras:
 *   1. a marcação `{{...}}` é lida em UM lugar (`lib/variaveis/resolvedor.ts`);
 *   2. a lista de variáveis é UMA (`lib/variaveis/catalogo.ts`);
 *   3. o seletor de tela é UM (`components/variaveis/`), e as quatro telas o
 *      importam dizendo a fonte.
 *
 * O vocabulário ABERTO (proposta, campos do funil) fica de fora com o motivo
 * declarado no catálogo (`VOCABULARIOS_ABERTOS`) — a exceção é nomeada, não
 * silenciosa.
 */

const RAIZ = join(__dirname, "..", "..");
const fonte = (arquivo: string): string => readFileSync(join(RAIZ, arquivo), "utf8");

const RESOLVEDOR = "lib/variaveis/resolvedor.ts";
const CATALOGO = "lib/variaveis/catalogo.ts";
const SELETOR = "components/variaveis/SeletorDeVariavel.tsx";
const CAMPO = "components/variaveis/CampoComVariaveis.tsx";

/** As quatro telas e o caminho de ENTRADA de cada uma (o que o teste de saída chama). */
const TELAS: {
  nome: string;
  arquivo: string;
  entrada: string;
  fonteDoCatalogo: string;
}[] = [
  {
    nome: "resposta rápida",
    arquivo: "lib/inbox/template-vars.ts",
    entrada: "interpolateTemplate",
    fonteDoCatalogo: "inbox",
  },
  {
    nome: "automação",
    arquivo: "lib/automation/template.ts",
    entrada: "renderTemplate",
    fonteDoCatalogo: "automacao",
  },
  {
    nome: "follow-up de texto",
    arquivo: "lib/automation/texto-do-followup.ts",
    entrada: "renderizarTextoDeFollowup",
    fonteDoCatalogo: "automacao",
  },
  {
    nome: "campanha",
    arquivo: "lib/campanhas/renderizador.ts",
    entrada: "renderizar",
    fonteDoCatalogo: "campanha",
  },
];

describe("a marcação `{{...}}` tem um dono", () => {
  it("só o resolvedor declara a regex da marcação", () => {
    // A regex pode aparecer em quem a REUSA por import; o que não pode é cada
    // tela escrever a sua (`new RegExp("\\{\\{...")`), que foi o defeito: o
    // Inbox não casava ponto e a campanha casava outro tanto.
    const suspeitos = [
      "lib/inbox/template-vars.ts",
      "lib/automation/template.ts",
      "lib/automation/texto-do-followup.ts",
      "lib/campanhas/renderizador.ts",
      "lib/channels/meta/variaveis-do-fluxo.ts",
    ];
    for (const arquivo of suspeitos) {
      const texto = fonte(arquivo);
      expect(
        texto,
        `${arquivo} voltou a montar a própria regex de marcação — use MARCACAO_DE_VARIAVEL`,
      ).not.toMatch(/new RegExp\(\s*["'`][\s\S]{0,40}\\\{\\\\/);
    }
  });

  it("o resolvedor exporta a marcação E o leitor de marcação, um só cada", () => {
    const texto = fonte(RESOLVEDOR);
    expect(texto.match(/export const MARCACAO_DE_VARIAVEL/g)).toHaveLength(1);
    expect(texto.match(/export function marcacoesNoTexto/g)).toHaveLength(1);
    // `global`: sem `g`, `matchAll` estoura e a segunda marcação do texto some.
    expect(MARCACAO_DE_VARIAVEL.global).toBe(true);
  });

  it("as quatro telas importam o resolvedor único e delegam a ele", () => {
    for (const tela of TELAS) {
      const texto = fonte(tela.arquivo);
      expect(texto, `${tela.arquivo} não usa o resolvedor único`).toContain(
        "@/lib/variaveis/resolvedor",
      );
      expect(texto, `${tela.arquivo} usa o resolvedor único`).toContain("resolverVariaveis");
      // E não sobrou nenhum `replace(...{{...)` local.
      expect(
        texto,
        `${tela.arquivo} ainda substitui ` +
          "`{{...}}` por conta própria — a substituição é do resolvedor",
      ).not.toMatch(/\.replace\(\s*\/[^/]*\\\{\\\{/);
    }
  });

  it("a frase da issue resolve pelas quatro portas e por UMA regra", () => {
    // Prova curta de fumaça: se alguém trocar a ligação de uma tela, aqui cai.
    const frase = "{{saudacao}}, {{primeiro_nome}}!";
    const agora = { instante: new Date("2026-11-05T15:00:00.000Z"), fuso: "America/Sao_Paulo" };
    const contato = { id: "c1", name: "Ana Souza", display_name: null, custom_fields: {} };
    expect(interpolateTemplate(frase, { name: "Ana Souza" }, agora)).toBe("Boa tarde, Ana!");
    expect(
      renderTemplate(frase, { contact: contato, lead: { custom_fields: {} } }, undefined, agora),
    ).toBe("Boa tarde, Ana!");
    expect(
      renderizar(frase, { nome: "Ana Souza" }, { agora: agora.instante, fuso: agora.fuso }).texto,
    ).toBe("Boa tarde, Ana!");
  });
});

describe("a lista de variáveis tem um dono", () => {
  it("o catálogo é a única lista; nenhuma tela exporta a sua", () => {
    for (const tela of TELAS) {
      const texto = fonte(tela.arquivo);
      expect(
        texto,
        `${tela.arquivo} exporta uma lista de variáveis própria — isso é o defeito do #3687`,
      ).not.toMatch(/export const VARIAVEIS_DE_[A-Z_]*\s*=\s*\[/);
    }
    // A única lista literal é a do catálogo — e é o catálogo que diz quem serve
    // em cada tela (`disponivelEm`).
    expect(fonte(CATALOGO)).toMatch(/export const VARIAVEIS_DO_CATALOGO/);
  });

  it("cada tela declara a SUA fonte do catálogo, e não a de outra", () => {
    for (const tela of TELAS) {
      const texto = fonte(tela.arquivo);
      expect(
        texto,
        `${tela.arquivo} não diz de qual fonte do catálogo ele fala (${tela.fonteDoCatalogo})`,
      ).toContain(`"${tela.fonteDoCatalogo}"`);
    }
  });

  it("o seletor não tem lista: ele lê `entradasDe(fonte)`", () => {
    const texto = fonte(SELETOR);
    expect(texto).toContain("entradasDe(fonte)");
    expect(texto, "o seletor voltou a ter lista fixa de variáveis").not.toMatch(
      /\[[\s\S]{0,80}"\{\{/,
    );
    // E a prévia usa o mesmo resolvedor, com o contato de exemplo.
    expect(fonte("lib/variaveis/previa.ts")).toContain("resolverVariaveis");
    expect(fonte(CAMPO)).toContain("SeletorDeVariavel");
  });
});

describe("a leitura da marcação não muda de significado por tela", () => {
  it("`marcacoesNoTexto` lê caminho com ponto, número e reserva", () => {
    expect(marcacoesNoTexto('a {{nome}} b {{lead.campo_1}} c {{email|"x@y"}}')).toEqual([
      "nome",
      "lead.campo_1",
      "email",
    ]);
  });

  it("texto sem marcação não tem marcação (e nada é inventado)", () => {
    expect(marcacoesNoTexto("Oi! Tudo bem? { } { { } }")).toEqual([]);
  });
});

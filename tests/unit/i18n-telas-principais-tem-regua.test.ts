import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_DESTINATIONS } from "@/lib/navigation/registry";
import { REGISTRO_DE_IDIOMAS } from "@/lib/i18n/registro";
import {
  COBERTURA_MINIMA_DAS_TELAS_PRINCIPAIS,
  FRASES_MINIMAS_ESPERADAS,
  TELAS_PRINCIPAIS,
  avaliarCoberturaDasTelasPrincipais,
  idiomasQueNaoAtendem,
} from "@/lib/i18n/telas-principais";

import { coberturaDoCatalogo, medirFrasesDasTelasPrincipais } from "./helpers/regua-de-telas-principais";

/**
 * A RÉGUA DE `telas_principais` — o nível que faz um idioma aparecer sem
 * cobrar a tradução de toda frase do produto.
 *
 * ─── O que estava errado ───────────────────────────────────────────────────
 *
 * O registro (`lib/i18n/registro.ts`) tem três níveis, e `telas_principais`
 * aparecia para quem usa desde a fatia 1. Só que a régua dele "ainda não
 * existia", e o teste anterior a este arquivo REPROVAVA qualquer idioma que
 * declarasse o nível. O efeito prático: o único caminho para um idioma novo
 * aparecer era `completo`, que cobra aquele idioma em todo PR que acrescentar
 * uma frase em português — o contrário da decisão do dono (doc de decisão 18,
 * Decisão 2 b: do terceiro idioma em diante, frase sem tradução cai no
 * português e não reprova ninguém).
 *
 * ─── O que este arquivo faz ────────────────────────────────────────────────
 *
 * Mede as telas principais, e aprova quem atende a régua em vez de reprovar
 * quem declara o nível. As duas caras estão aqui, com idioma FICTÍCIO, porque
 * hoje nenhum idioma real declara `telas_principais` — uma régua que só é
 * exercitada no dia em que alguém a usa é uma régua não testada:
 *
 *   1. um idioma fictício que ATENDE passa (é o que o nível promete);
 *   2. um idioma fictício que NÃO atende é recusado, com o número do que falta.
 *
 * ─── O que este arquivo NÃO faz ────────────────────────────────────────────
 *
 * Não traduz nada, não promove idioma nenhum e não toca `catalogos.ts`. A
 * leitura do catálogo é `readFileSync` + `JSON.parse` — DADO, não `import`:
 * foi exatamente um `import` de `en.json` (1,61 MB) no caminho do type check
 * que derrubou `build-and-size`, as imagens e as 8 partes do e2e no #4721.
 * Este arquivo não acrescenta um byte ao programa do TypeScript.
 */

const RAIZ = join(__dirname, "..", "..");

/** O catálogo de um idioma, lido como dado — nunca importado (ver o cabeçalho). */
function catalogo(codigo: string): Record<string, string> {
  return JSON.parse(readFileSync(join(RAIZ, "lib", "i18n", "traducoes", `${codigo}.json`), "utf8")) as Record<
    string,
    string
  >;
}

/**
 * A medição é feita UMA vez e compartilhada: o fecho de imports das 16 rotas
 * custa uma varredura do AST do produto inteiro, e repetir por caso triplicaria
 * o tempo do gate sem medir nada de novo.
 */
const MEDICAO = medirFrasesDasTelasPrincipais(TELAS_PRINCIPAIS.map((tela) => tela.href));

/** Um catálogo FICTÍCIO com as `n` primeiras frases das telas principais. */
function catalogoFicticio(proporcao: number): Record<string, string> {
  const todas = [...MEDICAO.frases];
  const quantas = Math.round(todas.length * proporcao);
  return Object.fromEntries(todas.slice(0, quantas).map((frase, i) => [frase, `xx-${i}`]));
}

describe("a régua de telas principais vem do registro de navegação", () => {
  it("são os destinos do menu lateral — derivados, não digitados", () => {
    // A lista tem de ser EXATAMENTE o filtro do registro. Se alguém a escrever
    // à mão, uma tela nova no menu deixa de entrar na régua em silêncio e o
    // idioma passa a aparecer com a tela principal pela metade.
    const doMenu = NAV_DESTINATIONS.filter((destino) => destino.sidebar === true).map((destino) => ({
      href: destino.href,
      label: destino.label,
    }));
    expect(TELAS_PRINCIPAIS).toEqual(doMenu);
  });

  it("toda tela da régua tem uma pasta de rota de verdade", () => {
    const semPasta = TELAS_PRINCIPAIS.filter((tela) => {
      try {
        readFileSync(join(RAIZ, `app${tela.href}`, "page.tsx"), "utf8");
        return false;
      } catch {
        return true;
      }
    });
    expect(semPasta.map((tela) => tela.href), "rota da régua sem `page.tsx` em app/").toEqual([]);
  });

  it("a régua não está vazia — 8 telas é o piso que separa menu de lista paralela", () => {
    expect(TELAS_PRINCIPAIS.length).toBeGreaterThanOrEqual(8);
  });
});

describe("a medição alcança as telas, não só a pasta da rota", () => {
  it("achou frases de verdade — varredura vazia aprovaria todo mundo", () => {
    expect(MEDICAO.frases.size).toBeGreaterThanOrEqual(FRASES_MINIMAS_ESPERADAS);
    expect(MEDICAO.arquivosVarridos).toBeGreaterThan(100);
  });

  it("cada tela da régua contribui com frases", () => {
    const mudas = [...MEDICAO.porTela.entries()].filter(([, medida]) => medida.frases === 0);
    expect(mudas.map(([href]) => href)).toEqual([]);
  });

  it("o Inbox mede o Inbox, e não as duas frases do page.tsx", () => {
    // Controle positivo do fecho de imports: a pasta `app/app/inbox` tem duas
    // chaves próprias (o Inbox inteiro mora em `@/components/inbox/InboxLayout`).
    // Uma medição que devolvesse 2 aqui estaria medindo a casca, e a régua
    // inteira passaria a ser cumprível com uma tela traduzida.
    const inbox = MEDICAO.porTela.get("/app/inbox");
    expect(inbox, "o Inbox saiu do menu lateral — a régua mudou de assunto").toBeTruthy();
    expect(inbox?.frases ?? 0).toBeGreaterThan(100);
    expect(inbox?.arquivos ?? 0).toBeGreaterThan(50);
  });
});

describe("as duas caras, com idioma fictício", () => {
  it("um idioma que ATENDE é aceito — é o que o nível promete", () => {
    const ficticio = { codigo: "xx-atende", nivel: "telas_principais" as const };
    const cobertura = coberturaDoCatalogo(catalogoFicticio(0.8), MEDICAO.frases);
    const veredito = avaliarCoberturaDasTelasPrincipais(cobertura);

    expect(cobertura.traduzidas / cobertura.total).toBeGreaterThanOrEqual(
      COBERTURA_MINIMA_DAS_TELAS_PRINCIPAIS,
    );
    expect(veredito.atende).toBe(true);
    expect(veredito.faltam).toBe(0);
    expect(idiomasQueNaoAtendem([ficticio], () => cobertura)).toEqual([]);
  });

  it("um idioma que NÃO atende é recusado, com o número do que falta", () => {
    const ficticio = { codigo: "xx-pela-metade", nivel: "telas_principais" as const };
    const cobertura = coberturaDoCatalogo(catalogoFicticio(0.5), MEDICAO.frases);
    const veredito = avaliarCoberturaDasTelasPrincipais(cobertura);

    expect(veredito.atende).toBe(false);
    // "faltam" é a distância até o PISO, não a porcentagem que falta: é o que a
    // mensagem de falha precisa dizer para quem for traduzir.
    expect(veredito.faltam).toBeGreaterThan(0);
    expect(idiomasQueNaoAtendem([ficticio], () => cobertura).map((linha) => linha.codigo)).toEqual([
      "xx-pela-metade",
    ]);
  });

  it("medição vazia REPROVA em vez de passar — zero de zero não é cobertura", () => {
    // Esta é a sabotagem que o PR prova: esvaziar a lista de telas zera a
    // medição, e uma régua que dividisse 0/0 aprovaria todos os idiomas.
    expect(() => avaliarCoberturaDasTelasPrincipais({ traduzidas: 0, total: 0 })).toThrow(/medição vazia/);
  });
});

describe("os idiomas de verdade", () => {
  it("só quem declara `telas_principais` é cobrado pela régua", () => {
    const recusados = idiomasQueNaoAtendem(REGISTRO_DE_IDIOMAS, (codigo) =>
      coberturaDoCatalogo(catalogo(codigo), MEDICAO.frases),
    );
    expect(
      recusados.map((linha) => linha.codigo),
      "estes idiomas declaram `telas_principais` sem atender a régua: volte para `em_construcao` " +
        "ou complete as telas principais",
    ).toEqual([]);
  });

  it("o nível `completo` continua sem régua nenhuma — o espanhol não afrouxa", () => {
    // Esta fatia não toca o `completo`: o espanhol continua cobrando TODA frase
    // de tela em `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`. Um idioma
    // `completo` que estivesse abaixo de 2/3 aqui não é problema DESTA régua.
    const completos = REGISTRO_DE_IDIOMAS.filter((idioma) => idioma.nivel === "completo");
    expect(completos.map((idioma) => idioma.codigo)).toEqual(["pt-BR", "es"]);
  });
});

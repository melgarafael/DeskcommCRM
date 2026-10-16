/**
 * A ESPERA DA REVELAÇÃO COBRE TODA A NAVEGAÇÃO — e o sintoma da #884 é nominal.
 *
 * ═══ O defeito ══════════════════════════════════════════════════════════════
 *
 * O sintoma reportado na #884 é: "depois de navegar para a Agenda e voltar, o
 * DOM fica com uma segunda cópia oculta de `tela-agenda`", e o `getByTestId`
 * passa a casar dois. A tela da Agenda foi absolvida por MEDIÇÃO, e este
 * arquivo registra como:
 *
 *   · jsdom, `AgendaClient` real, montar → `unmount()` → remontar:
 *     **1 → 0 → 1**. Nenhum componente da Agenda monta sem desmontar;
 *   · nenhum `Activity`/`unstable_Activity`/`keep-alive`/`Offscreen` no app,
 *     nenhuma rota paralela ou interceptada sob `/app/agenda`, e o `AppShell`
 *     renderiza `{children}` uma vez.
 *
 * A cópia é a **caixa do streaming SSR** (`<div hidden id="S:N">`) que o
 * servidor manda e o React esvazia no cliente — já descrita na issue #1374,
 * cujo conserto (PR #1706) entrou em 2026-09-26, onze dias depois da #884.
 *
 * ─── O buraco que sobrou, e que este arquivo fecha ══════════════════════════
 *
 * O `test` da suíte embrulhava `page.goto` e `page.reload` (PR #1706) para só
 * devolverem quando a revelação termina. A spec vermelha citada na #884
 * (`agenda-ocupacao-do-google-no-historico`) navega só por `goto` e `reload`, e
 * esse vermelho o #1706 já fechou. O que sobrou foi `page.goBack()` e
 * `page.goForward()` — NÃO embrulhados: uma spec que volta ou avança por ali
 * (hoje, `central-avisos-destino`) lia o documento no meio da revelação.
 *
 * ⚠️ O PORQUÊ DE UM TESTE DE HARNESS E NÃO DE e2e. A cerca que existia
 * (`e2e-specs-usam-o-test-da-suite.test.ts`) só confere o IMPORT da spec — foi
 * por isso que a lacuna de `goBack` passou. Um e2e aqui exigiria navegador,
 * banco e duas contas para provar uma propriedade que é uma lista de nomes. O
 * que se prova aqui é a COBERTURA, e ela é o que quebrou — pelo embrulho REAL
 * (`embrulharANavegacao`, o mesmo que `test.ts` chama), mais uma cerca de texto
 * que reprova `test.ts` embrulhando algum método à mão, por fora dele.
 *
 * ⚠️ O dublê não é uma página de verdade. Ele existe para observar QUANTAS vezes
 * a espera foi exigida e se veio DEPOIS da navegação — as duas propriedades que
 * o embrulho promete. A revelação em página de verdade é de `goBack` na browser;
 * o dublê prova a ligação, e a spec `buffer-ssr-caixa-orfa` continua sendo a
 * que mede o streaming de fato.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  EVIDENCIA_DE_ERRO_VAZIA,
  embrulharANavegacao,
  METODOS_DE_NAVEGACAO_REVELADOS,
  digestDoErroDeServidor,
  mensagemDaCaixaNaoRevelada,
  type EvidenciaDoErroDeServidor,
} from "../e2e/helpers/revelacao-nas-cargas";

/** O que o dublê registra: a ordem das navegações e das esperas. */
class PaginaFalsa {
  /** Ordem dos eventos, para provar que a espera vem DEPOIS da navegação. */
  readonly registro: string[] = [];
  /** Quantas vezes a espera foi cobrada. */
  esperas = 0;

  async goto(url: string, opcoes?: { waitUntil?: string }): Promise<{ url: string }> {
    void opcoes;
    this.registro.push(`goto:${url}`);
    return { url };
  }

  async reload(opcoes?: { waitUntil?: string }): Promise<{ url: string }> {
    void opcoes;
    this.registro.push("reload");
    return { url: "" };
  }

  async goBack(opcoes?: { waitUntil?: string }): Promise<{ url: string }> {
    void opcoes;
    this.registro.push("goBack");
    return { url: "" };
  }

  async goForward(opcoes?: { waitUntil?: string }): Promise<{ url: string }> {
    void opcoes;
    this.registro.push("goForward");
    return { url: "" };
  }
}

/** Um dublê já embrulhado pelo embrulho REAL, com a espera observável. */
function paginaEmbrulhada(): PaginaFalsa {
  const pagina = new PaginaFalsa();
  embrulharANavegacao(pagina as unknown as Page, async () => {
    pagina.esperas += 1;
    pagina.registro.push("espera");
  });
  return pagina;
}

describe("a espera da revelação cobre toda a navegação (issue #884)", () => {
  it("a lista nomeia goto, reload, goBack e goForward — nenhum método de fora", () => {
    expect([...METODOS_DE_NAVEGACAO_REVELADOS].sort()).toEqual([
      "goBack",
      "goForward",
      "goto",
      "reload",
    ]);
  });

  it("goBack espera a revelação — é por ele que uma spec 'volta para a Agenda'", () => {
    const pagina = paginaEmbrulhada();
    return pagina.goBack().then(() => {
      expect(pagina.esperas).toBe(1);
      expect(pagina.registro).toEqual(["goBack", "espera"]);
    });
  });

  it("goForward espera a revelação", () => {
    const pagina = paginaEmbrulhada();
    return pagina.goForward().then(() => {
      expect(pagina.esperas).toBe(1);
    });
  });

  it("goto espera a revelação", () => {
    const pagina = paginaEmbrulhada();
    return pagina.goto("/app/agenda").then(() => {
      expect(pagina.esperas).toBe(1);
    });
  });

  it("reload espera a revelação", () => {
    const pagina = paginaEmbrulhada();
    return pagina.reload().then(() => {
      expect(pagina.esperas).toBe(1);
    });
  });

  it("a espera vem DEPOIS da navegação, nunca antes", () => {
    const pagina = paginaEmbrulhada();
    return pagina.goBack().then(() => {
      expect(pagina.registro.indexOf("goBack")).toBeLessThan(pagina.registro.indexOf("espera"));
    });
  });

  it("waitUntil: commit não espera — a caixa não existe ainda", () => {
    const pagina = paginaEmbrulhada();
    return pagina.goto("/app/agenda", { waitUntil: "commit" }).then(() => {
      expect(pagina.esperas).toBe(0);
    });
  });

  it("a volta de ida e volta cobre os DOIS sentidos da pilha de navegação", () => {
    const pagina = paginaEmbrulhada();
    return pagina
      .goForward()
      .then(() => pagina.goBack())
      .then(() => {
        expect(pagina.esperas).toBe(2);
        expect(pagina.registro).toEqual(["goForward", "espera", "goBack", "espera"]);
      });
  });

  it("goBack com waitUntil: commit também não espera — o guarda é do argumento", () => {
    const pagina = paginaEmbrulhada();
    return pagina.goBack({ waitUntil: "commit" }).then(() => {
      expect(pagina.esperas).toBe(0);
    });
  });
});

/**
 * A metade que nenhum caso acima vê: `test.ts` tem de PASSAR pelo embrulho
 * provado. Se ele voltar a embrulhar `goto`/`reload` à mão, com a lista intacta,
 * todos os casos acima seguem verdes e o `goBack` volta a ler a revelação pela
 * metade — exatamente a lacuna da #884.
 */
describe("o test da suíte usa o embrulho provado (issue #884)", () => {
  const fonte = readFileSync(join(__dirname, "../e2e/helpers/test.ts"), "utf8");

  it("test.ts chama embrulharANavegacao com a página", () => {
    expect(fonte).toMatch(/embrulharANavegacao\(\s*page\s*,/);
  });

  it("test.ts não embrulha método de navegação à mão", () => {
    const aMao = /\.(goto|reload|goBack|goForward)\s*=(?!=)|\[\s*metodo\s*\]\s*=(?!=)/;
    expect(
      fonte.match(aMao)?.[0] ?? null,
      "embrulhe só por `embrulharANavegacao` (revelacao-nas-cargas.ts) — é ele que este teste prova",
    ).toBeNull();
  });
});

/**
 * O DIAGNÓSTICO DO BOUNDARY QUE TERMINOU EM ERRO DE SERVIDOR (resto declarado no
 * #2351).
 *
 * A espera não podia continuar dizendo "caixa órfã" para um boundary que o
 * servidor não revelou porque FALHOU. O defeito está descrito no PR #2351: a
 * consulta do catálogo estourava o `statement_timeout`, `app/app/products/page.tsx:95`
 * lançava, e o diagnóstico mandava procurar caixa órfã onde havia erro de
 * servidor.
 *
 * ⚠️ AS EVIDÊNCIAS ABAIXO SÃO MEDIDAS, E O DIGEST É SINTÉTICO. O formato
 * `$RX("B:N","<digest>")` e o `data-dgst` que o `$RX` escreve saíram da execução
 * de `renderToPipeableStream` do react-dom 19.3 desta árvore (produção), com um
 * boundary que suspende e depois lança — e do fonte instalado
 * (`react-dom/cjs/react-dom-server.node.production.js`): o digest do stream é o
 * valor que o `onError` do servidor DEVOLVE (`logRecoverableError`), e o `$RX`
 * copia esse mesmo valor para o dataset do marcador (`a.dataset.dgst = c`). O
 * valor `DIGEST-SINTETICO-2351` é inventado; o formato, não.
 */
describe("a caixa que não revelou porque o boundary terminou em erro de servidor (#2351)", () => {
  const CAIXA = 'div[hidden][id^="S:"]';
  const TETO = 15_000;
  const URL = "http://localhost:3000/app/produtos";
  // Medido: o script de instrução do erro, como o react-dom 19.3 o escreve.
  const SCRIPT_COM_DIGEST = '$RX=function(b,c,d,e,f){…};;$RX("B:0","DIGEST-SINTETICO-2351")';
  // Medido: o mesmo script quando o `onError` do servidor não devolve digest —
  // é o caminho que NÃO pode virar "erro de servidor" na mensagem.
  const SCRIPT_SEM_DIGEST = '$RX=function(b,c,d,e,f){…};;$RX("B:0")';

  const evidencia = (parcial: Partial<EvidenciaDoErroDeServidor> = {}): EvidenciaDoErroDeServidor => ({
    ...EVIDENCIA_DE_ERRO_VAZIA,
    ...parcial,
  });

  const mensagem = (e: EvidenciaDoErroDeServidor): string =>
    mensagemDaCaixaNaoRevelada({ caixaPendente: CAIXA, tetoMs: TETO, url: URL, evidencia: e });

  it("o data-dgst do marcador faz a mensagem dizer ERRO DE SERVIDOR e citar o digest", () => {
    const texto = mensagem(evidencia({ digestsDoMarcador: ["DIGEST-SINTETICO-2351"] }));
    expect(texto).toContain("terminou em ERRO DE SERVIDOR");
    expect(texto).toContain("DIGEST-SINTETICO-2351");
    expect(texto).not.toContain("caixa órfã de verdade");
  });

  it("o digest também é lido do script $RX quando o marcador já saiu da página", () => {
    const texto = mensagem(evidencia({ scripts: ["requestAnimationFrame(…)", SCRIPT_COM_DIGEST] }));
    expect(texto).toContain("terminou em ERRO DE SERVIDOR");
    expect(texto).toContain("DIGEST-SINTETICO-2351");
  });

  it("a mensagem do servidor entra na mensagem quando o data-msg está à mão", () => {
    const texto = mensagem(
      evidencia({
        digestsDoMarcador: ["DIGEST-SINTETICO-2351"],
        mensagensDoMarcador: ["Nao consegui ler o catalogo: canceling statement due to statement timeout"],
      }),
    );
    expect(texto).toContain("canceling statement due to statement timeout");
  });

  it("a mensagem continua sendo a de SEMPRE quando o boundary apenas não revelou", () => {
    expect(mensagem(evidencia({ scripts: [SCRIPT_SEM_DIGEST] }))).toBe(
      `a caixa do streaming SSR (${CAIXA}) não foi revelada em ${TETO} ms depois da carga de ${URL} — ` +
        `caixa órfã de verdade (issue #1374).`,
    );
    expect(mensagem(evidencia())).toContain("caixa órfã de verdade (issue #1374).");
  });

  it("$RX sem digest não vira erro de servidor — o React não devolveu digest nenhum", () => {
    expect(digestDoErroDeServidor(evidencia({ scripts: [SCRIPT_SEM_DIGEST] }))).toBeNull();
  });

  it("o digest sai do marcador antes do script — é o que o navegador já resolveu", () => {
    expect(
      digestDoErroDeServidor(
        evidencia({ digestsDoMarcador: ["DO-MARCADOR"], scripts: [SCRIPT_COM_DIGEST] }),
      ),
    ).toBe("DO-MARCADOR");
  });

  /**
   * A metade que nenhum caso acima vê: a mensagem não pode voltar a ser escrita
   * à mão dentro de `test.ts` — quem a monta é a função pura provada aqui, e é
   * ela que recebe a evidência lida da página.
   */
  it("test.ts monta a mensagem pela função pura, com a evidência lida da página", () => {
    const fonte = readFileSync(join(__dirname, "../e2e/helpers/test.ts"), "utf8");
    expect(fonte).toMatch(/mensagemDaCaixaNaoRevelada\(\{/);
    expect(fonte).toMatch(/evidenciaDoErroDeServidor\(page\)/);
    expect(
      fonte.includes("caixa órfã de verdade"),
      "o texto do diagnóstico mora em revelacao-nas-cargas.ts, provado pelo teste unit",
    ).toBe(false);
  });
});

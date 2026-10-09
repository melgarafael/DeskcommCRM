/**
 * PONTO MARCADO COMO "DECISÃO RÁPIDA" TEM CHAMADOR DO JEV — e vice-versa.
 *
 * `decisaoRapida` no registro diz que o ponto tem uma pergunta para o Jev; a
 * tela oferece as TAREFAS (`TAREFAS_DO_JEV`, e todo ponto marcado tem uma —
 * `lib/ai/decisao/tarefas.test.ts`). Marcado sem chamador, é tarefa que não
 * controla nada: o dono liga o Jev, paga, e nada muda. Chamador sem marca é o
 * avesso: o Jev decide num ponto que a tela não mostra. Mesmo molde de `pontos-de-ia-completude.test.ts`, lendo o
 * CÓDIGO-FONTE de `lib/ai/decisao/`, onde mora todo chamador do Jev.
 *
 * Escrever `ponto: "x"` numa função que ninguém chama também é botão que não
 * controla nada. Por isso o módulo do chamador precisa ser IMPORTADO por alguém
 * fora de `lib/ai/decisao/` (o worker, a rota), e `decidirNoPonto` chamado de
 * qualquer outra raiz precisa de ponto marcado — senão a premissa "todo
 * chamador mora em lib/ai/decisao" seria só uma frase.
 *
 * A exceção é a chamada SEM ponto: a das tarefas que acompanham uma regra sem
 * IA (`lib/ai/decisao/pedidos.ts`). Ela não tem ponto para marcar, e o tipo de
 * `EntradaDoPonto` obriga cada pergunta dela a ser de uma tarefa do Jev, pelo
 * id — é assim que a tela (que deriva de `TAREFAS_DO_JEV`) a mostra. A cerca a
 * aceita só quando a chamada NÃO tem `ponto` nenhum, lido na árvore do código,
 * e cobra o consumidor fora da pasta como cobra o das outras.
 */
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { PONTOS_DE_IA } from "@/lib/ai/pontos/registro";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const CHAMADA = /ponto:\s*["']([a-z_]+)["']/g;

/** ponto → arquivos de `lib/ai/decisao/` que o passam a `decidirNoPonto`. */
function chamadores(): Map<string, { arquivo: string; fonte: string }[]> {
  const mapa = new Map<string, { arquivo: string; fonte: string }[]>();
  for (const abs of arquivosDeCodigo(["lib/ai/decisao"])) {
    const fonte = readFileSync(abs, "utf8");
    for (const m of fonte.matchAll(CHAMADA)) {
      const lista = mapa.get(m[1]!) ?? [];
      lista.push({ arquivo: caminhoRelativo(abs), fonte });
      mapa.set(m[1]!, lista);
    }
  }
  return mapa;
}

/**
 * Como cada `decidirNoPonto(...)` do arquivo diz o que pergunta: o `ponto`
 * literal, `null` quando a entrada não tem `ponto` (as perguntas são de tarefas
 * sem ponto — o tipo garante), ou `"?"` quando a cerca não enxerga (o ponto
 * numa variável, a entrada inteira numa variável).
 */
function pontosDasChamadas(fonte: string): Array<string | null> {
  const arvore = ts.createSourceFile("x.ts", fonte, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const achadas: Array<string | null> = [];
  const visitar = (no: ts.Node): void => {
    const nome = ts.isCallExpression(no)
      ? ts.isIdentifier(no.expression)
        ? no.expression.text
        : ts.isPropertyAccessExpression(no.expression)
          ? no.expression.name.text
          : null
      : null;
    if (ts.isCallExpression(no) && nome === "decidirNoPonto") {
      const entrada = no.arguments[0];
      if (entrada === undefined || !ts.isObjectLiteralExpression(entrada)) {
        achadas.push("?");
      } else {
        const ponto = entrada.properties.find(
          (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(arvore) === "ponto",
        );
        const espalha = entrada.properties.some((p) => ts.isSpreadAssignment(p));
        if (ponto === undefined) achadas.push(espalha ? "?" : null);
        else achadas.push(ts.isPropertyAssignment(ponto) && ts.isStringLiteralLike(ponto.initializer) ? ponto.initializer.text : "?");
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(arvore);
  return achadas;
}

const marcados = PONTOS_DE_IA.filter((p) => p.decisaoRapida !== undefined);
const porPonto = chamadores();

describe("decisão rápida: registro × chamador do Jev", () => {
  it("há ponto marcado e há chamador (controle positivo)", () => {
    expect(marcados.map((p) => p.id)).toContain("sentiment_classify");
    expect(porPonto.has("sentiment_classify")).toBe(true);
  });

  it("todo ponto marcado tem chamador, que pergunta na primitiva declarada", () => {
    const semChamador = marcados
      .filter((p) => {
        const quem = porPonto.get(p.id) ?? [];
        const tipo = new RegExp(`tipo:\\s*["']${p.decisaoRapida!.primitiva}["']`);
        return !quem.some((c) => tipo.test(c.fonte));
      })
      .map((p) => `${p.id} (${p.decisaoRapida!.primitiva})`);
    expect(semChamador, "ponto que a tela vai oferecer ao Jev sem ninguém chamá-lo").toEqual([]);
  });

  it("todo chamador do Jev está num ponto marcado", () => {
    const idsMarcados = new Set(marcados.map((p) => p.id));
    const orfaos = [...porPonto.entries()]
      .filter(([id]) => !idsMarcados.has(id))
      .map(([id, quem]) => `${id} (em ${quem.map((c) => c.arquivo).join(", ")})`);
    expect(orfaos, "o Jev decide num ponto que a tela não mostra").toEqual([]);
  });

  it("o módulo de cada chamador tem quem o use fora de lib/ai/decisao", () => {
    const fora = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"])
      .map(caminhoRelativo)
      .filter((c) => !c.startsWith("lib/ai/decisao/"))
      .map((c) => readFileSync(c, "utf8"));
    const semConsumidor = marcados.flatMap((p) =>
      (porPonto.get(p.id) ?? [])
        .map((c) => c.arquivo.replace(/\.tsx?$/, ""))
        // As duas aspas: o agent-engine importa com aspas simples.
        .filter((modulo) => !fora.some((fonte) => fonte.includes(`"@/${modulo}"`) || fonte.includes(`'@/${modulo}'`)))
        .map((modulo) => `${p.id} (${modulo})`),
    );
    expect(semConsumidor, "o Jev é chamado num módulo que nenhum worker ou rota importa").toEqual([]);
  });

  it("a cerca lê o ponto de cada chamada na árvore (sabotagem sintética)", () => {
    expect(pontosDasChamadas(`decidirNoPonto({ ponto: "sentiment_classify", perguntas })`)).toEqual(["sentiment_classify"]);
    expect(pontosDasChamadas(`decidirNoPonto({ organizationId, perguntas }, deps)`)).toEqual([null]);
    expect(pontosDasChamadas(`decidirNoPonto({ ponto: qual, perguntas })`)).toEqual(["?"]);
    expect(pontosDasChamadas(`decidirNoPonto(entrada)`)).toEqual(["?"]);
    expect(pontosDasChamadas(`seam.decidirNoPonto({ ponto: "intent_router" })`)).toEqual(["intent_router"]);
    expect(pontosDasChamadas(`decidirNoPonto({ ...base, perguntas })`)).toEqual(["?"]);
    // O comentário que cita a função não é chamada.
    expect(pontosDasChamadas(`// decidirNoPonto({ ponto: "x" })\nconst y = 1;`)).toEqual([]);
  });

  const raizes = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"])
    .map(caminhoRelativo)
    .filter((c) => c !== "lib/ai/decisao/ponto.ts")
    .map((c) => ({ arquivo: c, chamadas: pontosDasChamadas(readFileSync(c, "utf8")) }))
    .filter((c) => c.chamadas.length > 0);

  it("decidirNoPonto chamado de qualquer raiz cai num ponto marcado — ou, sem ponto, nas tarefas", () => {
    const idsMarcados = new Set(marcados.map((p) => p.id));
    const soltos = raizes
      .filter((r) => r.chamadas.some((ponto) => ponto !== null && !idsMarcados.has(ponto)))
      .map((r) => r.arquivo);
    expect(raizes.length, "a varredura não enxergou chamada nenhuma").toBeGreaterThan(2);
    expect(soltos, "chamada ao Jev sem ponto marcado (ou com o ponto numa variável)").toEqual([]);
  });

  it("o módulo que chama sem ponto tem quem o use fora de lib/ai/decisao", () => {
    const semPonto = raizes.filter((r) => r.chamadas.includes(null)).map((r) => r.arquivo);
    expect(semPonto, "a chamada sem ponto dos pedidos do cliente (controle positivo)").toContain("lib/ai/decisao/pedidos.ts");
    const fora = arquivosDeCodigo(["app", "lib", "workers", "components", "hooks"])
      .map(caminhoRelativo)
      .filter((c) => !c.startsWith("lib/ai/decisao/"))
      .map((c) => readFileSync(c, "utf8"));
    const semConsumidor = semPonto
      .map((c) => c.replace(/\.tsx?$/, ""))
      .filter((modulo) => !fora.some((fonte) => fonte.includes(`"@/${modulo}"`) || fonte.includes(`'@/${modulo}'`)));
    expect(semConsumidor, "o Jev é chamado num módulo que nenhum worker ou rota importa").toEqual([]);
  });

  it("o que a tela diz sobre o Jev está escrito para quem não é engenheiro", () => {
    const jargao = /\b(401|403|429|HTTP|timeout|token|prompt|API|score|provider)\b/i;
    const tecnicos = marcados
      .filter((p) => jargao.test(p.decisaoRapida!.oQueOJevFaz))
      .map((p) => p.id);
    expect(tecnicos).toEqual([]);
  });
});

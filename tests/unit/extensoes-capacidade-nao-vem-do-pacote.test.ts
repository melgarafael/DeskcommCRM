import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  CAPACIDADES_DE_EFEITO,
  CAPACIDADES_DE_PORTA,
  DESTINOS_PERMITIDOS,
  EFEITO_DA_CAPACIDADE,
  EXTENSION_CAPABILITIES,
  PORTA_DA_CAPACIDADE,
  destinoDaCapacidade,
} from "@/lib/extensions/capacidades";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";

/**
 * O PACOTE NOMEIA UMA PORTA; ELE NUNCA ESCOLHE O ENDEREÇO.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * Três testes já cobriam o destino das extensões
 * (`components/extensions/ExtensionGuide.test.tsx`, `lib/extensions/context-routes.test.ts`,
 * `tests/e2e/extensoes-declarativas.spec.ts`). Todos afirmam **o valor de hoje** —
 * `/app/tasks` — e nenhum afirma **a regra**. A diferença decide segurança: ao ampliar o
 * vocabulário de capacidades (ADR-0003), quem implementasse atualizaria os três de boa-fé,
 * e a propriedade sumiria sem um único vermelho.
 *
 * A saída barata seria `href.startsWith("/app/")`. Ela é verde em tudo e alcança
 * `/app/settings/api-tokens` e `/app/ai/credentials` — as duas telas onde a instalação
 * guarda segredo. Este arquivo reprova exatamente essa saída.
 *
 * ─── Por que três partes, e nenhuma basta sozinha ───────────────────────────
 *
 * A ESTÁTICA mede a classe: percorre o AST da rota e exige que todo `href` devolvido seja
 * literal do mapa ou venha de `destinoDaCapacidade`. Ela não sabe se o mapa aponta para um
 * lugar razoável.
 *
 * A do CONJUNTO mede o mapa: nenhuma porta sensível, e nenhuma porta morta — um destino que
 * não existe no catálogo de navegação levaria a pessoa a um 404 vindo de uma extensão.
 *
 * A de COMPORTAMENTO mede a função: valor fora da lista devolve recusa, e não um destino de
 * reserva. Sem ela, um `?? "/app"` passaria nas outras duas.
 */

const RAIZ = join(__dirname, "..", "..");
const ROTA_OPEN = join(RAIZ, "app", "api", "v1", "extensions", "[id]", "open", "route.ts");

/** Telas que uma extensão nunca pode abrir: é onde a instalação guarda segredo. */
const PROIBIDAS = [
  "/app/settings",
  "/app/ai/credentials",
  "/app/ai/providers",
  "/app/webhooks",
  "/admin",
];

function origemDaRota(): ts.SourceFile {
  return ts.createSourceFile(
    ROTA_OPEN,
    readFileSync(ROTA_OPEN, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

/**
 * Todo valor atribuído à propriedade `href` na rota, seja ele qual for.
 *
 * Cobre as DUAS formas, e a segunda me pegou: `ok({ href })` é abreviação e não é um
 * `PropertyAssignment` — a primeira versão desta função devolvia lista vazia para a rota
 * já consertada, e a guarda teria ficado cega justamente na forma que ESCONDE a origem do
 * valor. Na abreviação, seguimos até a declaração da variável e medimos o inicializador dela.
 */
function valoresDeHref(origem: ts.SourceFile): ts.Expression[] {
  const achados: ts.Expression[] = [];
  const declaracoes = new Map<string, ts.Expression>();

  const coletarDeclaracoes = (no: ts.Node) => {
    if (ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.initializer) {
      declaracoes.set(no.name.text, no.initializer);
    }
    ts.forEachChild(no, coletarDeclaracoes);
  };
  ts.forEachChild(origem, coletarDeclaracoes);

  const visitar = (no: ts.Node) => {
    if (
      ts.isPropertyAssignment(no) &&
      ts.isIdentifier(no.name) &&
      no.name.text === "href" &&
      no.initializer
    ) {
      achados.push(no.initializer);
    }
    if (ts.isShorthandPropertyAssignment(no) && no.name.text === "href") {
      const declarado = declaracoes.get("href");
      // Abreviação sem declaração visível no arquivo: não dá para afirmar a origem, então
      // conta como inaceitável em vez de sumir da medição.
      achados.push(declarado ?? no.name);
    }
    ts.forEachChild(no, visitar);
  };
  ts.forEachChild(origem, visitar);
  return achados;
}

describe("a capacidade não vem do pacote — guarda estática", () => {
  it("todo href devolvido pela rota sai de destinoDaCapacidade — nunca de literal", () => {
    const hrefs = valoresDeHref(origemDaRota());
    expect(hrefs.length).toBeGreaterThan(0);

    // A versão anterior aceitava TAMBÉM literal que estivesse em DESTINOS_PERMITIDOS, e esse foi
    // o ponto cego que deixou um defeito de produto chegar ao CI: a rota devolvia `/app/tasks`
    // FIXO, ignorando qual porta a pessoa clicou, e a guarda aprovava porque `/app/tasks` é um
    // destino permitido. Seis portas eram seis botões abrindo Tarefas, com esta guarda verde.
    //
    // A guarda provava que o destino é SEGURO. Nunca provou que ele DEPENDE do clique. São duas
    // propriedades, e literal no href satisfaz a primeira e viola a segunda por construção.
    //
    // O literal continua aceito onde ele é o desenho — o mapa em `capacidades.ts` —, porque esta
    // varredura só lê a ROTA. O que se proíbe aqui é a rota decidir o destino por conta própria.
    const inaceitaveis = hrefs.filter((valor) => {
      if (ts.isCallExpression(valor) && ts.isIdentifier(valor.expression)) {
        return valor.expression.text !== "destinoDaCapacidade";
      }
      return true;
    });

    expect(
      inaceitaveis.map((v) => v.getText()),
      "href montado, concatenado ou vindo do manifesto abre a porta que o mapa fecha",
    ).toEqual([]);
  });

  it("a rota não concatena nem interpola para formar um destino", () => {
    const texto = readFileSync(ROTA_OPEN, "utf8");
    // Template string contendo `/app` é a forma clássica de montar destino a partir de dado.
    expect(/`[^`]*\/app[^`]*\$\{/.test(texto), "destino montado por template").toBe(false);
    expect(/["']\/app["']\s*\+/.test(texto), "destino montado por concatenação").toBe(false);
    expect(
      /startsWith\(\s*["']\/app/.test(texto),
      "prefixo em vez de lista fechada: alcança as telas de segredo",
    ).toBe(false);
  });
});

describe("a capacidade não vem do pacote — o mapa", () => {
  it("nenhuma porta leva a tela de configuração, credencial ou administração", () => {
    const perigosas = DESTINOS_PERMITIDOS.filter((destino) =>
      PROIBIDAS.some((proibida) => destino === proibida || destino.startsWith(`${proibida}/`)),
    );
    expect(perigosas, "extensão orienta trabalho; não leva a quem guarda segredo").toEqual([]);
  });

  it("toda porta existe no catálogo de navegação — nenhuma leva a 404", () => {
    const conhecidos = new Set<string>(NAV_CATALOG.map((entrada) => entrada.href));
    const mortas = DESTINOS_PERMITIDOS.filter((destino) => !conhecidos.has(destino));
    expect(mortas, "porta de extensão apontando para tela inexistente").toEqual([]);
  });

  it("toda capacidade de PORTA tem destino, e nenhuma sobra no mapa", () => {
    // O vocabulário tem duas naturezas desde o #3076: o mapa de PORTAS cobre exatamente as
    // capacidades que navegam. As de EFEITO não entram nele de propósito — a linha seguinte
    // afirma a ausência, para que "dar uma porta vazia" não passe como solução.
    expect(Object.keys(PORTA_DA_CAPACIDADE).sort()).toEqual([...CAPACIDADES_DE_PORTA].sort());
    for (const capacidade of CAPACIDADES_DE_EFEITO) {
      expect(capacidade in PORTA_DA_CAPACIDADE, `${capacidade} ganhou porta`).toBe(false);
    }
  });

  it("toda capacidade de EFEITO tem efeito nomeado, e o mapa é exaustivo", () => {
    expect(Object.keys(EFEITO_DA_CAPACIDADE).sort()).toEqual([...CAPACIDADES_DE_EFEITO].sort());
    // As duas naturezas, juntas, são o vocabulário inteiro: nenhuma capacidade fica sem mapa.
    expect([...CAPACIDADES_DE_PORTA, ...CAPACIDADES_DE_EFEITO].sort()).toEqual(
      [...EXTENSION_CAPABILITIES].sort(),
    );
  });
});

describe("a capacidade não vem do pacote — comportamento do resolvedor", () => {
  it("resolve toda capacidade de PORTA da lista", () => {
    for (const capacidade of CAPACIDADES_DE_PORTA) {
      expect(destinoDaCapacidade(capacidade)).toBe(PORTA_DA_CAPACIDADE[capacidade].destino);
    }
  });

  it("uma capacidade de EFEITO não resolve destino, mesmo com o nome certo", () => {
    // A capacidade é do vocabulário, mas não navega: o resolvedor devolve `null`, e nenhum
    // caminho de clique chega a montar um href para ela.
    for (const capacidade of CAPACIDADES_DE_EFEITO) {
      expect(destinoDaCapacidade(capacidade)).toBeNull();
    }
  });

  const recusas: ReadonlyArray<readonly [unknown, string]> = [
    ["/app/settings/api-tokens", "endereço cru"],
    ["settings.open", "capacidade inventada"],
    ["tasks.open ", "espaço à direita"],
    ["TASKS.OPEN", "caixa trocada"],
    ["", "vazio"],
    [null, "nulo"],
    [{ toString: (): string => "tasks.open" }, "objeto que finge ser a capacidade"],
  ];
  it.each(recusas)("recusa (%s) sem destino de reserva — %s", (entrada) => {
    expect(destinoDaCapacidade(entrada)).toBeNull();
  });
});

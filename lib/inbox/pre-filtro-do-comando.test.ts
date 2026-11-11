/**
 * O PRÉ-FILTRO DO COMANDO — a tela pede menos linhas, o resultado não muda.
 *
 * ## O que este teste vigia
 *
 * `comando_da_conversa` é função `stable security definer`
 * (`supabase/baseline.sql:51746-51765`), então o Postgres a avalia LINHA A LINHA
 * antes do `LIMIT`: a lista da Fila e as duas contagens pagam a função em todo o
 * histórico fechado da organização, ainda que a função só devolva `aguardando` ou
 * `automatico` para conversa SEM DONO e com status fora de
 * `('closed','archived','resolved')` (`fn_comando_da_conversa`, baseline:42674-42699).
 *
 * O conserto é pedir isso como filtro ao banco — e o risco do conserto é o óbvio:
 * um filtro a mais no `WHERE` pode MUDAR a resposta. Por isso as duas provas aqui:
 *
 *   1. **equivalência** (caso d): o conjunto que passa por `pré-filtro + função` é
 *      idêntico ao que passa pela função sozinha, numa base que tem conversa
 *      fechada, arquivada, resolvida, com dono e sem dono;
 *   2. **estreiteza** (caso d, segunda metade): o pré-filtro RECUSA toda linha que
 *      a função jamais classificaria como `aguardando`/`automatico` — sem esta
 *      metade, apagar `resolved` da lista continuaria "equivalente" (seria só um
 *      filtro mais frouxo) e ninguém veria o desperdício voltar.
 *
 * E o caso (c) é o que impede o oposto: comando vazio ou fora do conjunto NÃO
 * ganha filtro nenhum — a consulta é byte a byte a de hoje.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  comandoDaConversa,
  comPreFiltroDoComando,
  preFiltroDoComando,
  type FatosDoComando,
} from "@/lib/inbox/comando-da-conversa";
import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { listConversationsQuerySchema } from "@/lib/schemas";

/**
 * Um builder de mentira que ANOTA cada predicado pedido, na ordem.
 *
 * É a mesma forma que o PostgREST devolve (`.is`, `.not`, `.in`, `.eq` encadeiam
 * sobre a própria consulta), então o que passa por aqui é o que a rota pediria ao
 * banco — sem subir banco.
 */
class ConsultaFalsa {
  readonly pedidos: string[] = [];

  is(coluna: string, valor: null): this {
    this.pedidos.push(`is(${coluna},${valor})`);
    return this;
  }

  not(coluna: string, operador: "in", valor: string): this {
    this.pedidos.push(`not(${coluna},${operador},${valor})`);
    return this;
  }

  in(coluna: string, valores: readonly string[]): this {
    this.pedidos.push(`in(${coluna},${valores.join("|")})`);
    return this;
  }

  eq(coluna: string, valor: string): this {
    this.pedidos.push(`eq(${coluna},${valor})`);
    return this;
  }
}

/** O `WHERE` que o pré-filtro acrescenta, do jeito que o PostgREST o recebe. */
const SEM_DONO = "is(assigned_to_user_id,null)";
const NAO_ENCERRADAS = "not(status,in,(closed,archived,resolved))";

/**
 * Os três pontos que pedem `comando_da_conversa` ao banco, e o pedido exato.
 *
 * O gate é textual porque o defeito seria textual também: um dos três ficar sem o
 * pré-filtro (ou recebê-lo com outro comando) é exatamente como a lista e o badge
 * passariam a divergir — a classe que os testes de espelho do inbox vigiam desde
 * a #923.
 */
function fonte(caminho: string): string {
  return readFileSync(join(__dirname, "..", "..", caminho), "utf8");
}

const TRES_PONTOS = [
  {
    arquivo: "app/api/v1/conversations/_handler.ts",
    // A lista: o pré-filtro entra na MESMA consulta, depois do `.in`, e recebe o
    // comando pedido — `q.comando` já é lista de valores válidos do schema.
    pedido: /comPreFiltroDoComando\(\s*query\.in\("comando_da_conversa", q\.comando\),\s*q\.comando,?\s*\)/,
  },
  {
    arquivo: "app/api/v1/conversations/counts/route.ts",
    // Contagem da Fila: o conjunto organizacional vem de `comandosDaFila` (o mesmo
    // que o `.in`), e é ele quem decide se o pré-filtro vale.
    pedido: /comPreFiltroDoComando\(\s*countExact\(\)\.in\("comando_da_conversa", comandosFila\),\s*comandosFila,?\s*\)/,
  },
  {
    arquivo: "app/api/v1/conversations/counts/route.ts",
    // Contagem do Automático: um comando só, sempre dentro do conjunto.
    pedido: /comPreFiltroDoComando\(\s*countExact\(\)\.eq\("comando_da_conversa", "automatico"\),\s*"automatico",?\s*\)/,
  },
] as const;

describe("o pré-filtro do comando", () => {
  it("a lista de status é a MESMA de fn_comando_da_conversa — com `resolved`", () => {
    // `CONVERSATION_TERMINAL_STATUSES` responde outra pergunta (o que o
    // `exclude_finished` esconde) e NÃO tem `resolved` (medido em
    // lib/schemas/messaging.ts). Copiar de lá daria um pré-filtro que deixa
    // passar conversa resolvida — o desperdício continuaria e a aba Fila
    // passaria a pagar a função para elas de novo.
    expect(preFiltroDoComando(["aguardando"])?.statusEncerrados).toEqual([
      "closed",
      "archived",
      "resolved",
    ]);
  });

  it.each([[["aguardando"]], [["automatico"]], [["aguardando", "automatico"]]])(
    "(a/b) comando %j pede dono nulo e os três status encerrados",
    (comando) => {
      const consulta = new ConsultaFalsa();
      const devolvida = comPreFiltroDoComando(consulta, comando);

      expect(devolvida).toBe(consulta); // o filtro entra NA MESMA consulta
      expect(consulta.pedidos).toEqual([SEM_DONO, NAO_ENCERRADAS]);
    },
  );

  it("(a/b) os três pontos do código pedem o pré-filtro, com o comando certo", () => {
    for (const ponto of TRES_PONTOS) {
      expect(fonte(ponto.arquivo), `${ponto.arquivo}: pré-filtro ausente`).toMatch(ponto.pedido);
    }
    // Duas contagens, dois pedidos: se um deles sumir, o `toMatch` acima já cai —
    // esta linha só garante que são DOIS pedidos no arquivo das contagens.
    const ocorrencias = fonte("app/api/v1/conversations/counts/route.ts").match(
      /comPreFiltroDoComando\(/g,
    );
    expect(ocorrencias).toHaveLength(2);
  });

  it.each([
    ["vazio (undefined)", undefined],
    ["lista vazia", [] as string[]],
    ["fora do conjunto: humano", ["humano"]],
    ["fora do conjunto: encerrada", ["encerrada"]],
    ["mistura: um dentro, um fora", ["aguardando", "humano"]],
  ])("(c) comando %s NÃO ganha filtro nenhum", (_nome, comando) => {
    const consulta = new ConsultaFalsa();
    const devolvida = comPreFiltroDoComando(consulta, comando);

    expect(devolvida).toBe(consulta);
    expect(consulta.pedidos).toEqual([]);
    expect(preFiltroDoComando(comando)).toBeNull();
  });

  it("(a) o pré-filtro não substitui a função: ela continua no WHERE", () => {
    // Um `comando_da_conversa.in.(...)` acompanhado do pré-filtro — a função
    // segue decidindo, o pré-filtro só reduz o que ela avalia.
    const consulta = comPreFiltroDoComando(
      new ConsultaFalsa().in("comando_da_conversa", ["aguardando"]),
      ["aguardando"],
    );

    expect(consulta.pedidos).toEqual([
      "in(comando_da_conversa,aguardando)",
      SEM_DONO,
      NAO_ENCERRADAS,
    ]);
  });
});

/**
 * A ROTA DE VERDADE: `listConversationsHandler` com um client de mentira que
 * anota o que ela pede ao banco (mesma técnica de
 * `painel-de-atendimento.test.ts`). É aqui que "o ponto 1 recebe o pré-filtro"
 * deixa de ser casamento de texto e passa a ser o `WHERE` montado pela rota.
 */
async function chamadasDaLista(comando: "aguardando" | "automatico" | "humano") {
  const chamadas: Array<{ metodo: string; args: unknown[] }> = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_alvo, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            return (...args: unknown[]) => {
              if (tabela === "conversations") chamadas.push({ metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  const ctx = {
    organization_id: "org-1",
    requestId: "req-1",
    actor: { type: "user", id: "user-1" },
  };
  await listConversationsHandler(
    client as never,
    ctx as never,
    listConversationsQuerySchema.parse({ comando }),
  );
  return chamadas;
}

describe("(a/b) a lista pede o pré-filtro — e só com o comando certo", () => {
  it.each(["aguardando", "automatico"] as const)(
    "comando=%s acrescenta os dois predicados à consulta da lista",
    async (comando) => {
      const chamadas = await chamadasDaLista(comando);

      expect(chamadas).toContainEqual({ metodo: "in", args: ["comando_da_conversa", [comando]] });
      expect(chamadas).toContainEqual({ metodo: "is", args: ["assigned_to_user_id", null] });
      expect(chamadas).toContainEqual({
        metodo: "not",
        args: ["status", "in", "(closed,archived,resolved)"],
      });
    },
  );

  it("(c) comando=humano pede a consulta de hoje, sem nenhum predicado a mais", async () => {
    const chamadas = await chamadasDaLista("humano");

    expect(chamadas).toContainEqual({ metodo: "in", args: ["comando_da_conversa", ["humano"]] });
    expect(chamadas.filter((c) => c.args[0] === "assigned_to_user_id")).toEqual([]);
    expect(chamadas.filter((c) => c.metodo === "not" && c.args[0] === "status")).toEqual([]);
  });
});

/**
 * O DUBLE DO BANCO: a base fixa e as duas regras rodando sobre ela.
 *
 * `comandoDaConversa` é o espelho TS da função SQL (casado por
 * `tests/invariants/comando-da-conversa-espelha-o-ts.test.ts`), então usá-la aqui
 * é rodar a MESMA pergunta que o Postgres faria — a diferença entre os dois
 * conjuntos é exatamente o que o pré-filtro poderia estragar.
 */
type LinhaDeConversa = FatosDoComando & { id: string };

const AGORA = new Date("2026-11-06T12:00:00.000Z");

const BASE: LinhaDeConversa[] = [
  // o histórico fechado: é ele que a função avaliava à toa
  { id: "fechada-sem-dono", status: "closed", assigned_to_user_id: null },
  { id: "arquivada-sem-dono", status: "archived", assigned_to_user_id: null },
  { id: "resolvida-sem-dono", status: "resolved", assigned_to_user_id: null },
  // ... e as que TÊM resultado, mais as iscas de cada ramo da função
  { id: "fechada-com-dono", status: "closed", assigned_to_user_id: "u-ana" },
  { id: "aberta-com-dono", status: "open", assigned_to_user_id: "u-ana" },
  { id: "aberta-com-trava", status: "open", assigned_to_user_id: null, force_human: true },
  { id: "aberta-sem-trava", status: "open", assigned_to_user_id: null },
  {
    id: "aberta-silenciada",
    status: "ai_handling",
    assigned_to_user_id: null,
    bot_silenced_until: "2026-11-06T13:00:00.000Z",
  },
  { id: "grupo-sem-dono", status: "open", assigned_to_user_id: null, is_group: true },
];

/** O pré-filtro no `WHERE`, linha a linha — o que o banco faria antes da função. */
function passaNoPreFiltro(linha: LinhaDeConversa, comando: readonly string[]): boolean {
  const pre = preFiltroDoComando(comando);
  if (!pre) return true; // sem pré-filtro, tudo chega à função
  if (linha.assigned_to_user_id !== null) return false;
  return !pre.statusEncerrados.includes(linha.status);
}

function quemManda(linha: LinhaDeConversa): string {
  return comandoDaConversa(linha, AGORA).comando.quem;
}

/** O resultado da consulta: o conjunto pedido, com ou sem pré-filtro antes. */
function comPreFiltro(comando: readonly string[]): string[] {
  return BASE.filter(
    (l) => passaNoPreFiltro(l, comando) && comando.includes(quemManda(l)),
  ).map((l) => l.id);
}

function semPreFiltro(comando: readonly string[]): string[] {
  return BASE.filter((l) => comando.includes(quemManda(l))).map((l) => l.id);
}

describe("(d) pré-filtro + função == só a função", () => {
  it.each([[["aguardando"]], [["automatico"]], [["aguardando", "automatico"]]])(
    "(d) o conjunto é o mesmo para %j",
    (comando) => {
      // A base tem resultado de verdade: sem isto, dois conjuntos vazios
      // "concordariam" e a prova não valeria nada.
      expect(semPreFiltro(comando).length).toBeGreaterThan(0);
      expect(comPreFiltro(comando)).toEqual(semPreFiltro(comando));
    },
  );

  it("a Fila continua com a conversa travada, a silenciada e o grupo", () => {
    expect(semPreFiltro(["aguardando"]).sort()).toEqual([
      "aberta-com-trava",
      "aberta-silenciada",
      "grupo-sem-dono",
    ]);
    expect(comPreFiltro(["aguardando"]).sort()).toEqual([
      "aberta-com-trava",
      "aberta-silenciada",
      "grupo-sem-dono",
    ]);
  });

  it("o pré-filtro RECUSA exatamente dono-nulo-e-aberto que sobra", () => {
    // A outra metade da prova: aqui mora o `resolved`. Sem ele nesta lista, a
    // conversa resolvida e sem dono voltaria a ser avaliada pela função — e é
    // este `toEqual` que fica vermelho, não a equivalência (que seguiria válida,
    // porque um filtro mais frouxo devolve o mesmo conjunto).
    const recusadas = BASE.filter((l) => !passaNoPreFiltro(l, ["aguardando"])).map((l) => l.id);

    expect(recusadas.sort()).toEqual([
      "aberta-com-dono",
      "arquivada-sem-dono",
      "fechada-com-dono",
      "fechada-sem-dono",
      "resolvida-sem-dono",
    ]);
  });
});

describe("(e) as contagens dão os mesmos números", () => {
  it.each([[["aguardando"]], [["automatico"]], [["aguardando", "automatico"]]])(
    "(e) contagem de %j com e sem pré-filtro",
    (comando) => {
      expect(comPreFiltro(comando).length).toBe(semPreFiltro(comando).length);
      expect(comPreFiltro(comando).length).toBeGreaterThan(0);
    },
  );

  it("Fila 3 e Automático 1 nesta base", () => {
    expect(comPreFiltro(["aguardando"])).toHaveLength(3);
    expect(comPreFiltro(["automatico"])).toHaveLength(1);
    expect(comPreFiltro(["automatico"])).toEqual(["aberta-sem-trava"]);
  });
});

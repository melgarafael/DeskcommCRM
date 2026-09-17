import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";
import { getQueuePosition, getQueuePositions } from "@/lib/routing/queue";

/**
 * A FILA ORDENA POR TEMPO DE ESPERA — E ISSO PASSOU A TER CERCA.
 *
 * ─── O que este arquivo existe para impedir ──────────────────────────────────
 * A ordem da aba Fila é uma decisão de produto: quem espera há mais tempo vem
 * primeiro, e é essa a posição que a tela numera e que o cliente ouve no
 * WhatsApp. Ela vive num `isQueue` de uma linha dentro do handler da lista —
 * trocar `last_inbound_at` por `last_message_at` ali não quebra nada, não avisa,
 * não muda o tamanho da resposta: a lista continua populada e plausível, só
 * ordenada por OUTRA pergunta. "O atendente que espera desde ontem afunda embaixo
 * de quem escreveu agora" é um defeito de produto que se lê como normal.
 *
 * ─── Por que é UNIT e não vive em tests/invariants/ ──────────────────────────
 * O invariante de banco monta a PRÓPRIA consulta e prova a semântica do
 * `order by` — que nunca esteve em dúvida. O que se pode perder é a rota PARAR de
 * pedir essa ordem, e isso se mede no que o handler emite, sem Docker.
 *
 * ─── A sabotagem, medida ─────────────────────────────────────────────────────
 * Antes de abrir: trocar `ORDEM_DA_ESPERA.coluna` por `"last_message_at"` no
 * handler deixa os casos ⭐ vermelhos (é a troca que a #639 descreve). Voltar
 * deixa verde. Um teste de ordem que nunca foi visto vermelho não é um teste.
 */

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

/** Dublê que registra a cadeia POR TABELA — o mesmo padrão de `nao-lidos-filtra-no-banco`. */
function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas;
}

/**
 * A ordem que o handler PEDIU ao banco, em texto — a asserção fica legível no
 * relatório e o `nullsFirst` não some no meio de um objeto comparado.
 */
function ordensPedidas(c: Chamada[]): string[] {
  return c
    .filter((x) => x.tabela === "conversations" && x.metodo === "order")
    .map((x) => {
      const [coluna, opcoes] = x.args as [
        string,
        { ascending?: boolean; nullsFirst?: boolean } | undefined,
      ];
      const direcao = opcoes?.ascending ? "crescente" : "decrescente";
      const nulos = opcoes?.nullsFirst ? "nulos-primeiro" : "nulos-por-último";
      return `${coluna} ${direcao} (${nulos})`;
    });
}

const ESPERA = [
  "last_inbound_at crescente (nulos-por-último)",
  "id crescente (nulos-por-último)",
];

const ATIVIDADE = [
  "last_message_at decrescente (nulos-por-último)",
  "id decrescente (nulos-por-último)",
];

describe("a Fila pede ao banco a ordem por tempo de espera", () => {
  it("⭐ a aba Fila: `last_inbound_at` crescente, quem espera mais primeiro", async () => {
    const c = await listar({ comando: ["aguardando"] });
    expect(ordensPedidas(c)).toEqual(ESPERA);
  });

  it("⭐ o caminho legado (`assigned_to=unassigned`) pede a MESMA ordem", async () => {
    // A Fila passou a se identificar por `comando`; o fallback ficou para as
    // chamadas antigas (MCP, link salvo). Se ele ordenasse por outra coisa, a
    // mesma aba daria duas ordens conforme por onde entrou.
    const c = await listar({ assigned_to: "unassigned" });
    expect(ordensPedidas(c)).toEqual(ESPERA);
  });

  it("CONTROLE: fora da Fila a ordem é por ATIVIDADE RECENTE", async () => {
    // Sem este caso, um handler que ordenasse por espera SEMPRE passaria nos dois
    // de cima — e a caixa inteira (Todas, Minhas, Encerradas) passaria a mostrar
    // primeiro a conversa que o atendente respondeu há mais tempo.
    expect(ordensPedidas(await listar({}))).toEqual(ATIVIDADE);
    expect(ordensPedidas(await listar({ comando: ["humano"] }))).toEqual(ATIVIDADE);
  });

  it("⛔ a ordem sai na MESMA consulta que já filtra a organização", async () => {
    // Este handler usa o admin client, que passa por cima da RLS: o filtro manual
    // de organização é a ÚNICA barreira. Uma consulta nova "só para ordenar"
    // nasceria sem barreira nenhuma e devolveria conversa de OUTRO CLIENTE.
    const c = await listar({ comando: ["aguardando"] });
    expect(c.filter((x) => x.tabela === "conversations" && x.metodo === "eq").map((x) => x.args.join(":"))).toContain(
      "organization_id:org-1",
    );
    expect(c.filter((x) => x.metodo === "order").length).toBeGreaterThan(0);
  });
});

describe("a posição da linha sai da MESMA ordenação da lista", () => {
  /**
   * O "3º" que o atendente lê na linha é o índice desta lista, e o número que o
   * cliente ouve no WhatsApp é a contagem desta MESMA ordem. Se a lista passasse
   * a ordenar por atividade recente e a posição continuasse a contar por espera,
   * a conversa de cima seria a 5ª — e nenhuma das duas telas estaria "errada".
   */
  it("⭐ o mapa de posições pede a MESMA ordem da lista", async () => {
    const { client, chamadas } = fakeSupabase();
    await getQueuePositions(client, "org-1");
    expect(ordensPedidas(chamadas)).toEqual(ESPERA);
  });

  it("⭐ o número que o cliente ouve conta pelo mesmo relógio do cliente", async () => {
    const { client, chamadas } = fakeSupabase();
    const entrada = "2026-09-16T12:00:00.000Z";
    await getQueuePosition(client, "org-1", entrada, new Date());
    const ltes = chamadas.filter((x) => x.metodo === "lte").map((x) => x.args.join(":"));
    expect(ltes).toContain(`last_inbound_at:${entrada}`);
  });
});

describe("a régua da ordem tem um lugar só", () => {
  const RAIZ = join(__dirname, "..", "..");
  const fonte = (caminho: string) => readFileSync(join(RAIZ, caminho), "utf8");

  it("⭐ rota e posições leem `ORDEM_DA_ESPERA` em vez de escrever a sua", () => {
    // A definição de QUEM está na fila já mora num lugar só (`comandosDaFila`,
    // vigiada por `fila-tem-uma-definicao-so`). A ORDEM é a pergunta vizinha e
    // seguia solta: cada sítio com a sua cópia é como as seis definições de fila
    // divergiram.
    for (const caminho of [
      "app/api/v1/conversations/_handler.ts",
      "lib/routing/queue.ts",
    ]) {
      expect(fonte(caminho), `${caminho}: ordem da fila fora de ORDEM_DA_ESPERA`).toContain(
        "ORDEM_DA_ESPERA",
      );
    }
  });

  it("⭐ o PREDICADO da Fila também vem de um lugar só", () => {
    // A ordem passou a ter dono (acima), e o predicado que decide se ela vale
    // continuava em duas cópias: a rota (que ordena) e a lista (que numera "1º,
    // 2º…" e mostra o tempo de espera). Ganhar uma condição num só dos dois
    // produz a tela ordenada por uma pergunta e numerada por outra — sem nada
    // ficar vermelho, que é exatamente o modo de falha que este arquivo vigia.
    const PROIBIDO = /includes\(\s*["']aguardando["']\s*\)/;
    // Controle: a régua morde quando o literal existe.
    expect(PROIBIDO.test('filters.comando?.includes("aguardando")')).toBe(true);

    for (const caminho of [
      "app/api/v1/conversations/_handler.ts",
      "components/inbox/ConversationList.tsx",
    ]) {
      const semComentarios = fonte(caminho)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(semComentarios, `${caminho}: o predicado da Fila voltou a ser escrito à mão`).not.toMatch(
        PROIBIDO,
      );
      expect(fonte(caminho), `${caminho}: não usa ehAFila`).toContain("ehAFila");
    }
  });

  it("⛔ o literal não voltou como régua própria — e a cerca morde", () => {
    const PROIBIDO = /\.order\(\s*["']last_inbound_at["']/;
    // O controle: uma varredura que nasce com zero achados pode estar certa ou
    // cega, e as duas se leem igual.
    expect(PROIBIDO.test('.order("last_inbound_at", { ascending: true })')).toBe(true);

    for (const caminho of ["app/api/v1/conversations/_handler.ts", "lib/routing/queue.ts"]) {
      const semComentarios = fonte(caminho)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(semComentarios, `${caminho}: ordem da espera escrita à mão`).not.toMatch(PROIBIDO);
    }
  });
});

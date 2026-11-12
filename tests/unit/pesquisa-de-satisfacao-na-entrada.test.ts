import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";

/**
 * NÚMERO SOLTO NÃO ENGOLE O ATENDIMENTO — pela ENTRADA inteira (#4023).
 *
 * `pesquisa-de-satisfacao-no-encerramento.test.ts` prova a regra na função que
 * lê a nota. Este arquivo prova o que o cliente sente: com uma pesquisa aberta,
 * o "2" que chega pela `aplicarEfeitosPosEntrada`
 *
 *   - logo depois da pergunta → vira nota e NÃO acorda nada (sem negócio, sem
 *     turno do agente, sem follow-up);
 *   - depois que a equipe ou a IA voltou a falar (um menu) → é conversa: o
 *     negócio nasce, o turno do agente é pedido e o follow-up anda, como para
 *     qualquer mensagem.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - tirar de `capturarRespostaDeSatisfacao` a leitura das mensagens enviadas
 *     depois da pergunta: o caso do menu acusa (o "2" some na nota);
 *   - tirar o `return` depois da nota em `pos-entrada.ts`: o caso da nota acusa
 *     (o agente acorda para responder a uma nota).
 */

const audit = vi.fn(async () => {});
const garantirLeadDaConversa = vi.fn(async () => ({ criado: true, leadId: "lead-1" }) as never);
const acelerarFollowupDoInbound = vi.fn(async () => {});
const drenarEventosDoInbound = vi.fn(async () => {});

vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...(a as [])) }));
vi.mock("@/lib/leads/encerramento", () => ({
  encerraDemanda: vi.fn(async () => ({ lead: {}, jaEstava: false })),
}));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: (...a: unknown[]) => garantirLeadDaConversa(...(a as [])),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: (...a: unknown[]) => acelerarFollowupDoInbound(...(a as [])),
  drenarEventosDoInbound: (...a: unknown[]) => drenarEventosDoInbound(...(a as [])),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehContatoDoNumeroInterno: vi.fn(async () => false),
}));

const PERGUNTADO_EM = "2026-11-12T15:00:00.000Z";
const A_PERGUNTA = {
  id: "msg-pergunta",
  direction: "outbound",
  sent_at: "2026-11-12T15:00:01.000Z",
  metadata: { pesquisa_de_satisfacao: true },
};
const O_MENU = { id: "msg-menu", direction: "outbound", sent_at: "2026-11-12T15:10:00.000Z", metadata: {} };

let enviadasDepoisDaPergunta: unknown[] = [];
let atualizacoesDoPedido: Array<Record<string, unknown>> = [];
let rpcChamadas: Array<{ nome: string; args: Record<string, unknown> }> = [];

/** Elo encadeável mínimo do PostgREST, com o efeito no `await`/`maybeSingle`. */
interface Elo {
  eq(coluna: string, valor: unknown): Elo;
  neq(coluna: string, valor: unknown): Elo;
  gt(coluna: string, valor: unknown): Elo;
  gte(coluna: string, valor: unknown): Elo;
  lte(coluna: string, valor: unknown): Elo;
  in(coluna: string, valor: unknown): Elo;
  is(coluna: string, valor: unknown): Elo;
  not(coluna: string, op: string, valor: unknown): Elo;
  order(coluna: string, opcoes?: unknown): Elo;
  limit(n: number): Elo;
  select(colunas?: string): Elo;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then(resolve: (v: { data: unknown; error: null }) => void): Promise<void>;
}

function elo(unica: () => unknown, lista: (filtros: Record<string, unknown>) => unknown[]): Elo {
  const filtros: Record<string, unknown> = {};
  const q: Elo = {
    eq: (coluna, valor) => {
      filtros[coluna] = valor;
      return q;
    },
    neq: () => q,
    gt: (coluna, valor) => {
      filtros[`${coluna}>`] = valor;
      return q;
    },
    gte: () => q,
    lte: () => q,
    in: () => q,
    is: () => q,
    not: () => q,
    order: () => q,
    limit: () => q,
    select: () => q,
    async maybeSingle() {
      return { data: unica(), error: null };
    },
    then(resolve) {
      return Promise.resolve({ data: lista(filtros), error: null }).then(resolve);
    },
  };
  return q;
}

const admin = {
  from(tabela: string) {
    return {
      select: () =>
        elo(
          () => {
            if (tabela === "satisfacao_do_atendimento") {
              return { id: "pedido-1", expira_em: "2026-11-13T15:00:00.000Z", perguntado_em: PERGUNTADO_EM };
            }
            if (tabela === "contacts") return { is_personal: false };
            if (tabela === "channel_sessions") return { metadata: {} };
            return null;
          },
          // Só a leitura da pesquisa ("o que foi ENVIADO depois da pergunta?")
          // enxerga as mensagens; qualquer outra leitura de `messages` vê vazio,
          // como no harness de `contato-pessoal-entrada.test.ts`.
          (filtros) =>
            tabela === "messages" && filtros.direction === "outbound" && "sent_at>" in filtros
              ? enviadasDepoisDaPergunta
              : [],
        ),
      update(payload: Record<string, unknown>) {
        if (tabela === "satisfacao_do_atendimento") atualizacoesDoPedido.push(payload);
        return elo(
          () => (tabela === "satisfacao_do_atendimento" ? { id: "pedido-1" } : null),
          () => [],
        );
      },
    };
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    rpcChamadas.push({ nome, args });
    return { error: null };
  },
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-do-cliente",
  channelSessionId: "sessao-1",
  texto: "2",
  nomeDoContato: "Cliente",
  requestId: "req-1",
  origem: "canal_de_teste",
};

async function rodar() {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, ENTRADA);
}

const turnosPedidos = () =>
  rpcChamadas.filter((c) => c.args.p_event_type === "ai_agent.dispatch_requested");

beforeEach(() => {
  // O relógio fica DENTRO da janela do pedido: a captura usa `new Date()`, e um
  // relógio real tornaria o caso dependente do dia em que roda.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:20:00.000Z"));
  enviadasDepoisDaPergunta = [];
  atualizacoesDoPedido = [];
  rpcChamadas = [];
  audit.mockClear();
  garantirLeadDaConversa.mockClear();
  acelerarFollowupDoInbound.mockClear();
  drenarEventosDoInbound.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#4023 — com a pesquisa aberta, o '2' que chega pela entrada", () => {
  it("logo depois da pergunta: é a nota, e nada acorda", async () => {
    enviadasDepoisDaPergunta = [A_PERGUNTA];
    await rodar();

    expect(atualizacoesDoPedido).toEqual([expect.objectContaining({ status: "respondida", nota: 2 })]);
    expect(garantirLeadDaConversa, "negócio não nasce de uma nota").not.toHaveBeenCalled();
    expect(acelerarFollowupDoInbound).not.toHaveBeenCalled();
    expect(turnosPedidos(), "o agente não responde a uma nota").toHaveLength(0);
  });

  it("depois que a equipe mandou um menu: é conversa, e o atendimento segue", async () => {
    enviadasDepoisDaPergunta = [A_PERGUNTA, O_MENU];
    await rodar();

    expect(atualizacoesDoPedido).toEqual([{ status: "sem_nota" }]);
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(acelerarFollowupDoInbound).toHaveBeenCalledTimes(1);
    expect(turnosPedidos(), "o turno do agente é pedido como para qualquer mensagem").toHaveLength(1);
  });
});

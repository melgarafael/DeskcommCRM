import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";

/**
 * NÚMERO SOLTO NÃO ENGOLE O ATENDIMENTO, E A NOTA NÃO O REABRE — pela ENTRADA
 * inteira (#4023).
 *
 * `pesquisa-de-satisfacao-no-encerramento.test.ts` prova a regra na função que
 * lê a nota. Este arquivo prova o que o cliente e a equipe veem: a conversa
 * foi ENCERRADA, a pergunta saiu, e o "5" do cliente já reabriu a conversa no
 * banco (`fn_service_inbound`, no INSERT da mensagem) quando chega a
 * `aplicarEfeitosPosEntrada`. O dublê devolve a conversa nesse estado: `open`,
 * revisão 8, com a demanda nova que a reabertura criou.
 *
 *   - logo depois da pergunta → vira nota, a conversa volta a ser ENCERRADA
 *     (`fn_service_status` com a revisão lida), a demanda que a nota abriu
 *     fecha (`fn_demanda_encerrar`, `nao_procede`), a nota fica na auditoria,
 *     e nada acorda (sem negócio, sem turno do agente, sem follow-up);
 *   - fora do prazo, ou depois que a equipe ou a IA voltou a falar (um menu) →
 *     é conversa: a conversa fica reaberta como sempre, o negócio nasce, o
 *     turno do agente é pedido e o follow-up anda.
 *
 * ─── SABOTAGEM ──────────────────────────────────────────────────────────────
 *   - tirar de `capturarRespostaDeSatisfacao` a leitura das mensagens enviadas
 *     depois da pergunta: o caso do menu acusa (o "5" some na nota);
 *   - tirar o `return` depois da nota em `pos-entrada.ts`: o caso da nota acusa
 *     (o agente acorda para responder a uma nota);
 *   - tirar `devolverAoEncerramentoDepoisDaNota`: o caso da nota acusa (a
 *     conversa fica aberta só com a nota);
 *   - tirar a conferência "o episódio só tem esta mensagem": o caso em que o
 *     cliente já tinha escrito antes acusa (um atendimento de verdade fecharia).
 */

const audit = vi.fn<(registro: Record<string, unknown>) => Promise<void>>(async () => {});
const garantirLeadDaConversa = vi.fn(async () => ({ criado: true, leadId: "lead-1" }) as never);
const acelerarFollowupDoInbound = vi.fn(async () => {});
const drenarEventosDoInbound = vi.fn(async () => {});

vi.mock("@/lib/audit", () => ({
  audit: (registro: Record<string, unknown>) => audit(registro),
}));
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
const PRAZO = "2026-11-13T15:00:00.000Z";
const A_PERGUNTA = {
  id: "msg-pergunta",
  direction: "outbound",
  sent_at: "2026-11-12T15:00:01.000Z",
  metadata: { pesquisa_de_satisfacao: true },
};
const O_MENU = { id: "msg-menu", direction: "outbound", sent_at: "2026-11-12T15:10:00.000Z", metadata: {} };
/** A revisão do episódio que a reabertura abriu (a do encerramento era 7). */
const REVISAO_REABERTA = 8;

let enviadasDepoisDaPergunta: unknown[] = [];
let episodioReaberto: Array<{ id: string }> = [];
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
      select: (colunas?: string) =>
        elo(
          () => {
            if (tabela === "satisfacao_do_atendimento") {
              return { id: "pedido-1", expira_em: PRAZO, perguntado_em: PERGUNTADO_EM };
            }
            // A conversa como a reabertura do banco a deixou. Só a leitura do
            // reencerramento a enxerga; as outras leituras veem o de sempre.
            if (tabela === "conversations" && colunas?.includes("current_demanda_id")) {
              return { status: "open", service_revision: REVISAO_REABERTA, current_demanda_id: "demanda-da-nota" };
            }
            if (tabela === "demandas") return { id: "demanda-da-nota", revision: 1, fechada_em: null };
            if (tabela === "contacts") return { is_personal: false };
            if (tabela === "channel_sessions") return { metadata: {} };
            return null;
          },
          (filtros) => {
            if (tabela !== "messages") return [];
            // "O que foi ENVIADO depois da pergunta?" (a conversa seguiu?)
            if (filtros.direction === "outbound" && "sent_at>" in filtros) return enviadasDepoisDaPergunta;
            // "Quem está no episódio reaberto?" (foi esta mensagem quem reabriu?)
            if (filtros.service_revision === REVISAO_REABERTA) return episodioReaberto;
            return [];
          },
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
    return { data: null, error: null };
  },
} as never;

const ENTRADA: EntradaDeMensagem = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-do-cliente",
  channelSessionId: "sessao-1",
  texto: "5",
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
const reencerramentos = () => rpcChamadas.filter((c) => c.nome === "fn_service_status");
const demandasEncerradas = () => rpcChamadas.filter((c) => c.nome === "fn_demanda_encerrar");
const acoesAuditadas = () => audit.mock.calls.map(([registro]) => registro.action);

beforeEach(() => {
  // O relógio fica DENTRO do prazo do pedido: a captura usa `new Date()`, e um
  // relógio real tornaria o caso dependente do dia em que roda.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:20:00.000Z"));
  enviadasDepoisDaPergunta = [A_PERGUNTA];
  episodioReaberto = [{ id: "msg-do-cliente" }];
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

describe("#4023 — conversa encerrada, pergunta feita, o cliente responde '5'", () => {
  it("é a nota: a conversa continua encerrada, a demanda da nota fecha e nada acorda", async () => {
    await rodar();

    expect(atualizacoesDoPedido).toEqual([expect.objectContaining({ status: "respondida", nota: 5 })]);

    expect(reencerramentos(), "volta a encerrar pela porta do botão Encerrar").toEqual([
      {
        nome: "fn_service_status",
        args: {
          p_org: "org-1",
          p_conversation: "conversa-1",
          p_status: "closed",
          p_expected: REVISAO_REABERTA,
        },
      },
    ]);
    expect(demandasEncerradas()).toEqual([
      expect.objectContaining({
        args: expect.objectContaining({ p_demanda: "demanda-da-nota", p_expected: 1, p_desfecho: "nao_procede" }),
      }),
    ]);
    expect(acoesAuditadas()).toEqual(expect.arrayContaining(["satisfacao.nota_recebida", "demanda.encerrada"]));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "satisfacao.nota_recebida",
        metadata: expect.objectContaining({ pedido_id: "pedido-1", reencerrada: true }),
      }),
    );

    expect(garantirLeadDaConversa, "negócio não nasce de uma nota").not.toHaveBeenCalled();
    expect(acelerarFollowupDoInbound, "follow-up não anda").not.toHaveBeenCalled();
    expect(drenarEventosDoInbound).not.toHaveBeenCalled();
    expect(turnosPedidos(), "o agente não responde a uma nota").toHaveLength(0);
  });

  it("se o cliente já tinha escrito antes no episódio reaberto, a nota fica, mas a conversa NÃO fecha", async () => {
    episodioReaberto = [{ id: "msg-obrigado" }, { id: "msg-do-cliente" }];
    await rodar();

    expect(atualizacoesDoPedido).toEqual([expect.objectContaining({ status: "respondida", nota: 5 })]);
    expect(reencerramentos()).toHaveLength(0);
    expect(demandasEncerradas()).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "satisfacao.nota_recebida",
        metadata: expect.objectContaining({ reencerrada: false }),
      }),
    );
  });
});

describe("#4023 — controle: o '5' que NÃO é nota reabre a conversa como hoje", () => {
  it("fora do prazo: não vira nota, a conversa fica reaberta e o atendimento segue", async () => {
    vi.setSystemTime(new Date("2026-11-14T09:00:00.000Z"));
    await rodar();

    expect(atualizacoesDoPedido).toEqual([{ status: "sem_nota" }]);
    expect(reencerramentos(), "ninguém volta a encerrar").toHaveLength(0);
    expect(acoesAuditadas()).not.toContain("satisfacao.nota_recebida");
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(acelerarFollowupDoInbound).toHaveBeenCalledTimes(1);
    expect(turnosPedidos()).toHaveLength(1);
  });

  it("depois que a equipe mandou um menu: é conversa, e o atendimento segue", async () => {
    enviadasDepoisDaPergunta = [A_PERGUNTA, O_MENU];
    await rodar();

    expect(atualizacoesDoPedido).toEqual([{ status: "sem_nota" }]);
    expect(reencerramentos(), "ninguém volta a encerrar").toHaveLength(0);
    expect(acoesAuditadas()).not.toContain("satisfacao.nota_recebida");
    expect(garantirLeadDaConversa).toHaveBeenCalledTimes(1);
    expect(acelerarFollowupDoInbound).toHaveBeenCalledTimes(1);
    expect(turnosPedidos(), "o turno do agente é pedido como para qualquer mensagem").toHaveLength(1);
  });
});

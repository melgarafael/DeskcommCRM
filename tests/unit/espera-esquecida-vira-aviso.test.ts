/**
 * A MENSAGEM QUE ESPERAVA A CONEXÃO VOLTAR NÃO FICA PARADA EM SILÊNCIO.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 * A conexão oficial ficou fora por cinco minutos; as duas mensagens que o
 * operador mandou nesse intervalo foram para `queued` e, quando a conexão
 * voltou, ninguém as reintentou: o resgate do agent-engine fala um transporte
 * só, e mensagem de PESSOA não tem resgate nenhum. `queued` não parece erro —
 * parece "indo" —, então nada na tela dizia que elas nunca sairiam.
 *
 * `recoverStuckMessages` passa a abrir um aviso na Central quando há outbound
 * `queued` vencida numa conexão que JÁ VOLTOU a WORKING. Não marca falha (no canal
 * por QR `queued` tem dono, e falhá-la perderia mensagem que ia sair) e não reenvia
 * (reenviar é decisão de quem escreveu).
 *
 * ─── O que este arquivo ganhou na triagem do #3907 ──────────────────────────
 *
 * A linha segue `queued` depois de resolvido o aviso, e nada a tira dali. Sem teto
 * de idade nem memória do aviso anterior, o crítico voltava a cada rodada e nunca
 * morria. O portão real desta regra é medido contra o Postgres em
 * `tests/invariants/piso-ocioso-retrato.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditMock = vi.hoisted(() => vi.fn());
const adminAtual = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => true }));
vi.mock("@/lib/cron/piso-ocioso", () => ({ recursoOcioso: async () => false }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminAtual.client }));

import { GET, recoverStuckMessages } from "@/app/api/v1/cron/recover-stuck-messages/route";

interface Chamada {
  tabela: string;
  op: string;
  filtros: Record<string, unknown>;
  valores?: Record<string, unknown>;
}

const AGORA = new Date("2026-11-03T12:00:00.000Z");
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "55555555-5555-4555-8555-555555555555";
const TITULO = "Mensagens ficaram esperando e não saíram";

const minutosAtras = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();

function esperando(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: ORG_A,
    conversation_id: "33333333-3333-4333-8333-333333333333",
    created_at: minutosAtras(16),
    metadata: { queued_reason: "channel_session_not_working" },
    channel_sessions: { status: "WORKING" },
    ...over,
  };
}

/**
 * Dublê da fatia que a regra usa: a busca de `sending` (vazia, o caso comum),
 * a busca de `queued`, a checagem de aviso já aberto e o insert do aviso.
 */
function clientDuble(
  emFila: Record<string, unknown>[],
  opts: { ultimoAviso?: { status: string; created_at: string } | null; erroNoAviso?: boolean } = {},
) {
  const chamadas: Chamada[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      chamadas.push({ tabela: `rpc:${fn}`, op: "rpc", filtros: {}, valores: args });
      return Promise.resolve({ error: null });
    },
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let op = "select";
      let valores: Record<string, unknown> | undefined;
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        update(v: Record<string, unknown>) {
          op = "update";
          valores = v;
          return cadeia;
        },
        insert(v: Record<string, unknown>) {
          chamadas.push({ tabela, op: "insert", filtros: {}, valores: v });
          return Promise.resolve({ data: null, error: null });
        },
        eq(col: string, val: unknown) {
          filtros[`eq:${col}`] = val;
          return cadeia;
        },
        in(col: string, val: unknown) {
          filtros[`in:${col}`] = val;
          return cadeia;
        },
        lt(col: string, val: unknown) {
          filtros[`lt:${col}`] = val;
          return cadeia;
        },
        gte(col: string, val: unknown) {
          filtros[`gte:${col}`] = val;
          return cadeia;
        },
        order(col: string, val: { ascending: boolean }) {
          filtros[`order:${col}`] = val.ascending;
          return cadeia;
        },
        limit() {
          chamadas.push({ tabela, op, filtros, valores });
          if (tabela === "messages" && filtros["eq:status"] === "queued") {
            return Promise.resolve({ data: emFila, error: null });
          }
          if (tabela === "agent_inbox_items") return cadeia;
          return Promise.resolve({ data: [], error: null });
        },
        maybeSingle() {
          if (opts.erroNoAviso) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: opts.ultimoAviso ?? null, error: null });
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

const avisos = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "agent_inbox_items" && c.op === "insert");

beforeEach(() => auditMock.mockReset());

describe("a espera esquecida vira aviso", () => {
  it("⭐ esperou a conexão, passou de 15 min e a conexão voltou: um aviso crítico na Central — mesmo sem nada preso em `sending`", async () => {
    const { client, chamadas } = clientDuble([esperando()]);
    const r = await recoverStuckMessages(client as never, AGORA, "req-1");

    expect(r.esperando).toBe(1);
    const [aviso] = avisos(chamadas);
    expect(aviso?.valores).toMatchObject({
      organization_id: ORG_A,
      kind: "message_send_stuck",
      severity: "critical",
      title: TITULO,
      ref_kind: "conversation",
      ref_id: "33333333-3333-4333-8333-333333333333",
    });
    // Torna visível, não decide pelo operador: nenhuma linha muda de status.
    expect(chamadas.filter((c) => c.tabela === "messages" && c.op === "update")).toEqual([]);
  });

  it("a busca: outbound `queued` entre 15 min e 24 h, da mais nova para a mais velha", async () => {
    const { client, chamadas } = clientDuble([]);
    await recoverStuckMessages(client as never, AGORA, "req-2");

    const busca = chamadas.find((c) => c.tabela === "messages" && c.filtros["eq:status"] === "queued");
    expect(busca?.filtros["eq:direction"]).toBe("outbound");
    expect(busca?.filtros["lt:created_at"]).toBe(minutosAtras(15));
    expect(busca?.filtros["gte:created_at"]).toBe(minutosAtras(24 * 60));
    expect(busca?.filtros["order:created_at"]).toBe(false);
  });

  it("conexão ainda fora do ar: esperar é o certo, e avisar repetiria o alerta de queda", async () => {
    const { client, chamadas } = clientDuble([esperando({ channel_sessions: { status: "STOPPED" } })]);
    const r = await recoverStuckMessages(client as never, AGORA, "req-3");

    expect(r.esperando).toBe(0);
    expect(avisos(chamadas)).toEqual([]);
  });

  it("a que pode ter tentativa agendada espera os 5 pedidos: aos 49 min não avisa, aos 50 avisa", async () => {
    const desacelerada = (min: number) =>
      esperando({ created_at: minutosAtras(min), metadata: { queued_reason: "canal_throttled" } });

    const cedo = clientDuble([desacelerada(49)]);
    expect((await recoverStuckMessages(cedo.client as never, AGORA, "req-4")).esperando).toBe(0);
    expect(avisos(cedo.chamadas)).toEqual([]);

    const vencida = clientDuble([desacelerada(50)]);
    expect((await recoverStuckMessages(vencida.client as never, AGORA, "req-5")).esperando).toBe(1);
  });

  it("um aviso por organização, com a contagem no corpo e o título fixo", async () => {
    const tres = [
      esperando({ id: "a1" }),
      esperando({ id: "a2" }),
      esperando({ id: "b1", organization_id: ORG_B }),
    ];
    const { client, chamadas } = clientDuble(tres);
    await recoverStuckMessages(client as never, AGORA, "req-6");

    expect(avisos(chamadas).map((a) => [a.valores?.organization_id, a.valores?.title])).toEqual([
      [ORG_A, TITULO],
      [ORG_B, TITULO],
    ]);
    expect(avisos(chamadas)[0]?.valores?.body).toContain("2 mensagens seguem");
    expect(avisos(chamadas)[1]?.valores?.body).toContain("Uma mensagem segue");
  });

  it("de 1 para 2 mensagens com o aviso aberto: não abre outro", async () => {
    const aberto = { status: "open", created_at: minutosAtras(10) };
    const { client, chamadas } = clientDuble([esperando({ id: "a1" }), esperando({ id: "a2" })], {
      ultimoAviso: aberto,
    });
    const r = await recoverStuckMessages(client as never, AGORA, "req-7");

    expect(avisos(chamadas)).toEqual([]);
    expect(r.esperando).toBe(0);
  });

  it("resolvido o aviso, a mesma mensagem parada não o abre de novo", async () => {
    const { client, chamadas } = clientDuble([esperando({ created_at: minutosAtras(40) })], {
      ultimoAviso: { status: "resolved", created_at: minutosAtras(20) },
    });
    const r = await recoverStuckMessages(client as never, AGORA, "req-8");

    expect(avisos(chamadas)).toEqual([]);
    expect(r.esperando).toBe(0);
  });

  it("resolvido o aviso, mensagem que venceu depois dele reabre", async () => {
    const { client, chamadas } = clientDuble([esperando({ created_at: minutosAtras(16) })], {
      ultimoAviso: { status: "resolved", created_at: minutosAtras(30) },
    });
    const r = await recoverStuckMessages(client as never, AGORA, "req-9");

    expect(avisos(chamadas)).toHaveLength(1);
    expect(r.esperando).toBe(1);
  });

  it("a que nasceu ANTES do aviso e venceu DEPOIS dele ainda avisa", async () => {
    // Nasceu há 20 min, o aviso (de outra) saiu há 10: ela venceu há 5, depois dele.
    const { client, chamadas } = clientDuble([esperando({ created_at: minutosAtras(20) })], {
      ultimoAviso: { status: "resolved", created_at: minutosAtras(10) },
    });
    await recoverStuckMessages(client as never, AGORA, "req-10");

    expect(avisos(chamadas)).toHaveLength(1);
  });

  it("sem conseguir ler o último aviso, não abre outro: duplicar um crítico é pior que esperar a rodada", async () => {
    const { client, chamadas } = clientDuble([esperando()], { erroNoAviso: true });
    const r = await recoverStuckMessages(client as never, AGORA, "req-11");

    expect(avisos(chamadas)).toEqual([]);
    expect(r.esperando).toBe(0);
  });
});

describe("a rodada que abriu aviso deixa rastro", () => {
  const pedido = () => new NextRequest("http://localhost/api/v1/cron/recover-stuck-messages");

  it("rodada com aviso audita", async () => {
    adminAtual.client = clientDuble([{ ...esperando(), created_at: new Date(Date.now() - 16 * 60_000).toISOString() }]).client;
    await GET(pedido());

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]?.[0]).toMatchObject({
      action: "message.recover_stuck_run",
      metadata: { failed: 0, esperando: 1 },
    });
  });

  it("controle: rodada que não fez nada não ocupa linha de auditoria", async () => {
    adminAtual.client = clientDuble([]).client;
    await GET(pedido());

    expect(auditMock).not.toHaveBeenCalled();
  });
});

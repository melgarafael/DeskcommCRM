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
 * `queued` há mais de 15 minutos numa conexão que JÁ VOLTOU a WORKING. Não marca
 * falha (no canal por QR `queued` tem dono, e falhá-la perderia mensagem que ia
 * sair) e não reenvia (reenviar é decisão de quem escreveu).
 */
import { describe, expect, it } from "vitest";

import { recoverStuckMessages } from "@/app/api/v1/cron/recover-stuck-messages/route";

interface Chamada {
  tabela: string;
  op: string;
  filtros: Record<string, unknown>;
  valores?: Record<string, unknown>;
}

const AGORA = new Date("2026-11-03T12:00:00.000Z");
const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "55555555-5555-4555-8555-555555555555";

function esperando(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: ORG_A,
    conversation_id: "33333333-3333-4333-8333-333333333333",
    channel_sessions: { status: "WORKING" },
    ...over,
  };
}

/**
 * Dublê da fatia que a regra usa: a busca de `sending` (vazia, o caso comum),
 * a busca de `queued`, a checagem de aviso já aberto e o insert do aviso.
 */
function clientDuble(emFila: Record<string, unknown>[], opts: { avisoAberto?: boolean } = {}) {
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
        limit() {
          chamadas.push({ tabela, op, filtros, valores });
          if (tabela === "messages" && filtros["eq:status"] === "queued") {
            return Promise.resolve({ data: emFila, error: null });
          }
          if (tabela === "agent_inbox_items") return cadeia;
          return Promise.resolve({ data: [], error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: opts.avisoAberto ? { id: "aviso-1" } : null, error: null });
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

const avisos = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "agent_inbox_items" && c.op === "insert");

describe("a espera esquecida vira aviso", () => {
  it("⭐ queued há mais de 15 min numa conexão que já voltou: um aviso crítico na Central — mesmo sem nada preso em `sending`", async () => {
    const { client, chamadas } = clientDuble([esperando()]);
    const r = await recoverStuckMessages(client as never, AGORA, "req-1");

    expect(r.esperando).toBe(1);
    const [aviso] = avisos(chamadas);
    expect(aviso?.valores).toMatchObject({
      organization_id: ORG_A,
      kind: "message_send_stuck",
      severity: "critical",
      title: "Uma mensagem sua ficou esperando e não saiu",
      ref_kind: "conversation",
      ref_id: "33333333-3333-4333-8333-333333333333",
    });
    // Torna visível, não decide pelo operador: nenhuma linha muda de status.
    expect(chamadas.filter((c) => c.tabela === "messages" && c.op === "update")).toEqual([]);
  });

  it("a busca: outbound `queued` mais velha que 15 min, pelo relógio injetado", async () => {
    const { client, chamadas } = clientDuble([]);
    await recoverStuckMessages(client as never, AGORA, "req-2");

    const busca = chamadas.find((c) => c.tabela === "messages" && c.filtros["eq:status"] === "queued");
    expect(busca?.filtros["eq:direction"]).toBe("outbound");
    expect(busca?.filtros["lt:created_at"]).toBe(new Date(AGORA.getTime() - 15 * 60 * 1000).toISOString());
  });

  it("conexão ainda fora do ar: esperar é o certo, e avisar repetiria o alerta de queda", async () => {
    const { client, chamadas } = clientDuble([esperando({ channel_sessions: { status: "STOPPED" } })]);
    const r = await recoverStuckMessages(client as never, AGORA, "req-3");

    expect(r.esperando).toBe(0);
    expect(avisos(chamadas)).toEqual([]);
  });

  it("um aviso por organização, com a contagem — e nenhum se o mesmo já está aberto", async () => {
    const tres = [
      esperando({ id: "a1" }),
      esperando({ id: "a2" }),
      esperando({ id: "b1", organization_id: ORG_B }),
    ];
    const { client, chamadas } = clientDuble(tres);
    await recoverStuckMessages(client as never, AGORA, "req-4");
    expect(avisos(chamadas).map((a) => [a.valores?.organization_id, a.valores?.title])).toEqual([
      [ORG_A, "2 mensagens suas ficaram esperando e não saíram"],
      [ORG_B, "Uma mensagem sua ficou esperando e não saiu"],
    ]);

    const jaAberto = clientDuble([esperando()], { avisoAberto: true });
    const r = await recoverStuckMessages(jaAberto.client as never, AGORA, "req-5");
    expect(avisos(jaAberto.chamadas)).toEqual([]);
    expect(r.esperando).toBe(0);
  });
});

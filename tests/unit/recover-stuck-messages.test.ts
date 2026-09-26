/**
 * A REGRA do cron `recover-stuck-messages` (issue #129).
 *
 * O `CLAUDE.md` (§WAHA) e o PRD 03 prometiam este cron desde o começo — regra
 * de negócio W-12 — e ele não existia: o `git grep` só achava a promessa. Sem
 * ele, mensagem outbound cujo envio nunca acontece fica `status='sending'` para
 * sempre, e o self-hoster vê no inbox uma mensagem eternamente "enviando":
 * sinal de progresso para algo que não vai acontecer.
 *
 * O que se guarda aqui é o COMPORTAMENTO, com um dublê do client que registra as
 * chamadas — não a existência da rota. Cada propriedade existe porque errar
 * nela recria um defeito diferente:
 *
 *   1. só mexe no que passou do prazo, medido por `created_at` — marcar cedo
 *      demais falha mensagem que estava a caminho, e medir por `sent_at` (que o
 *      caminho de envio reescreve) deixa a mensagem rejuvenescer;
 *   2. o UPDATE carrega `status='sending'` como condição — sem esse claim, um
 *      ack que chega entre o SELECT e o UPDATE vira "falha" numa mensagem que o
 *      cliente recebeu;
 *   3. emite `message.failed`, como manda a regra W-12 — o trigger não emite,
 *      porque é AFTER INSERT e aqui só muda status;
 *   4. abre aviso na Central — marcar `failed` em silêncio troca uma falha
 *      invisível por outra: a bolha muda de ícone numa conversa que ninguém tem
 *      motivo para reabrir;
 *   5. o que a corrida levou não vira evento nem aviso — anunciar falha que não
 *      houve é o defeito espelhado.
 */
import { describe, expect, it } from "vitest";

import { STUCK_AFTER_MS, recoverStuckMessages } from "@/app/api/v1/cron/recover-stuck-messages/route";

interface Chamada {
  tabela: string;
  op: string;
  filtros: Record<string, unknown>;
  valores?: Record<string, unknown>;
}

/**
 * Dublê mínimo do client: registra o que foi pedido e devolve o que a rodada
 * encontraria. Não imita o PostgREST inteiro — imita só a fatia que a regra usa,
 * e qualquer método não previsto estoura, para o teste não passar por engano
 * sobre um caminho que ele não modela.
 */
function clientDuble(presas: Record<string, unknown>[], atualizadas?: Record<string, unknown>[]) {
  const chamadas: Chamada[] = [];
  const client = {
    rpc(fn: string, args: Record<string, unknown>) {
      chamadas.push({ tabela: `rpc:${fn}`, op: "rpc", filtros: {}, valores: args });
      return Promise.resolve({ error: null });
    },
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let valores: Record<string, unknown> | undefined;
      let op = "select";
      const cadeia: Record<string, unknown> = {
        select() {
          return cadeia;
        },
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
          return Promise.resolve({ data: presas, error: null });
        },
        then(resolve: (r: unknown) => unknown) {
          chamadas.push({ tabela, op, filtros, valores });
          return Promise.resolve(
            resolve({ data: atualizadas ?? presas, error: null }),
          );
        },
      };
      return cadeia;
    },
  };
  return { client, chamadas };
}

const AGORA = new Date("2026-08-05T12:00:00.000Z");

function presa(over: Partial<Record<string, string>> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: "22222222-2222-4222-8222-222222222222",
    conversation_id: "33333333-3333-4333-8333-333333333333",
    contact_id: "44444444-4444-4444-8444-444444444444",
    created_at: new Date(AGORA.getTime() - 10 * 60 * 1000).toISOString(),
    sent_via: "ai",
    // Embed N:1: o PostgREST devolve OBJETO.
    contacts: { phone_number: "+5531999990000" },
    ...over,
  };
}

describe("recover-stuck-messages", () => {
  it("o prazo é o do CLAUDE.md: 5 minutos", () => {
    expect(STUCK_AFTER_MS).toBe(5 * 60 * 1000);
  });

  it("busca só outbound sending mais velha que o prazo", async () => {
    const { client, chamadas } = clientDuble([]);
    await recoverStuckMessages(client as never, AGORA, "req-1");

    const busca = chamadas.find((c) => c.tabela === "messages" && c.op === "select");
    expect(busca).toBeDefined();
    expect(busca?.filtros["eq:direction"]).toBe("outbound");
    expect(busca?.filtros["eq:status"]).toBe("sending");
    // O corte é calculado a partir do `now` INJETADO — se a regra usasse
    // `Date.now()` por dentro, este caso não conseguiria fixá-lo e passaria a
    // medir o relógio da máquina em vez da regra. E é por `created_at`, não
    // `sent_at`: medir idade pela coluna que o caminho de envio reescreve
    // deixaria a mensagem rejuvenescer e escapar do cron para sempre.
    expect(busca?.filtros["lt:created_at"]).toBe(
      new Date(AGORA.getTime() - STUCK_AFTER_MS).toISOString(),
    );
  });

  it("nada preso ⇒ não escreve nada", async () => {
    const { client, chamadas } = clientDuble([]);
    const r = await recoverStuckMessages(client as never, AGORA, "req-2");

    expect(r).toEqual({ scanned: 0, failed: 0, organizations: 0 });
    expect(chamadas.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("marca failed com claim atômico em status=sending", async () => {
    const { client, chamadas } = clientDuble([presa()]);
    const r = await recoverStuckMessages(client as never, AGORA, "req-3");

    const upd = chamadas.find((c) => c.op === "update");
    expect(upd?.valores?.status).toBe("failed");
    expect(upd?.valores?.error_code).toBe("send_timeout");
    // A condição que impede marcar como falha uma mensagem cujo ack chegou
    // entre o SELECT e o UPDATE. Sem ela o cron mente sobre uma entrega real.
    expect(
      upd?.filtros["eq:status"],
      "o UPDATE precisa carregar status=sending como claim — senão uma corrida com o ack vira falso 'failed'",
    ).toBe("sending");
    // Service role bypassa RLS: o filtro de org é programático, não opcional.
    expect(upd?.filtros["eq:organization_id"]).toBe(presa().organization_id);
    expect(r.failed).toBe(1);
  });

  it("abre UM aviso por organização, não um por mensagem", async () => {
    const tres = [
      presa({ id: "aaaaaaaa-0000-4000-8000-000000000001" }),
      presa({ id: "aaaaaaaa-0000-4000-8000-000000000002" }),
      presa({ id: "aaaaaaaa-0000-4000-8000-000000000003" }),
    ];
    const { client, chamadas } = clientDuble(tres);
    const r = await recoverStuckMessages(client as never, AGORA, "req-4");

    const avisos = chamadas.filter((c) => c.tabela === "agent_inbox_items");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.valores?.kind).toBe("message_send_stuck");
    expect(avisos[0]?.valores?.severity).toBe("critical");
    expect(String(avisos[0]?.valores?.title)).toContain("3");
    expect(r).toEqual({ scanned: 3, failed: 3, organizations: 1 });
  });

  it("emite message.failed por mensagem marcada (W-12)", async () => {
    // O trigger `trg_messages_emit_event` é AFTER INSERT: mudar o status não
    // emite nada. Se este cron não emitir, o evento que a regra promete
    // simplesmente não existe — e ninguém notaria, porque o status muda igual.
    const dois = [
      presa({ id: "aaaaaaaa-0000-4000-8000-000000000001" }),
      presa({ id: "aaaaaaaa-0000-4000-8000-000000000002" }),
    ];
    const { client, chamadas } = clientDuble(dois);
    await recoverStuckMessages(client as never, AGORA, "req-6");

    const emitidos = chamadas.filter((c) => c.tabela === "rpc:emit_event");
    expect(emitidos).toHaveLength(2);
    expect(emitidos[0]?.valores?.p_event_type).toBe("message.failed");
    expect(emitidos[0]?.valores?.p_organization_id).toBe(presa().organization_id);
    expect(emitidos.map((e) => e.valores?.p_entity_id).sort()).toEqual(
      dois.map((m) => m.id).sort(),
    );
  });

  it("o message.failed do timeout tem o MESMO contrato do envio e do webhook da Meta (#1614)", async () => {
    // Um formato só para quem integra: a regra "Quando uma mensagem não for
    // entregue" com `event.erro.codigo` precisa casar no timeout também, e o
    // `contact_id` é de onde o motor hidrata `contact.*` nas condições.
    const { client, chamadas } = clientDuble([presa()]);
    await recoverStuckMessages(client as never, AGORA, "req-7");

    const [evento] = chamadas.filter((c) => c.tabela === "rpc:emit_event");
    expect(evento?.valores).toMatchObject({
      p_entity_kind: "message",
      p_payload: {
        message_id: presa().id,
        conversation_id: presa().conversation_id,
        contact_id: presa().contact_id,
        contact: "+5531999990000",
        sent_via: "ai",
        erro: { codigo: "send_timeout", titulo: expect.stringContaining("5 min") },
      },
      p_metadata: { source: "recover-stuck-messages", request_id: "req-7" },
    });
  });

  it("o UPDATE que não pegou nada não vira evento nem aviso (a corrida perdida é silenciosa)", async () => {
    // presas encontradas, mas o UPDATE devolve zero linhas: outro tick — ou o
    // ack — chegou primeiro. Anunciar aqui assustaria o dono do negócio com uma
    // falha que não houve, e gravaria `message.failed` de uma entrega real.
    const { client, chamadas } = clientDuble([presa()], []);
    const r = await recoverStuckMessages(client as never, AGORA, "req-5");

    expect(chamadas.filter((c) => c.tabela === "agent_inbox_items")).toEqual([]);
    expect(chamadas.filter((c) => c.tabela === "rpc:emit_event")).toEqual([]);
    expect(r).toEqual({ scanned: 1, failed: 0, organizations: 0 });
  });
});

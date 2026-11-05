import { beforeEach, describe, expect, it } from "vitest";

import {
  lerQuarentenaDaMensagem,
  liberarMensagemDaQuarentena,
  marcarMensagemEmQuarentena,
  MOTIVO_MAXIMO,
  normalizarMotivo,
} from "./quarentena";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A MARCA DA QUARENTENA — o que ela grava, o que ela recusa e o que ela não
 * sobrescreve.
 *
 * ─── Por que estes casos existem ───────────────────────────────────────────
 *
 * O estado é uma linha de `messages` marcada. Três coisas podem dar errado em
 * silêncio, e cada uma vira um caso aqui:
 *
 * · o filtro por organização sumir e a marca cair em mensagem de outra empresa;
 * · o `is("quarantined_at", null)` sumir e o duplo clique reescrever o motivo
 *   original — auditoria que se reescreve não é auditoria;
 * · a leitura lançar em vez de responder "não está", derrubando a ingestão ou
 *   calando uma conversa legítima por causa de um timeout.
 */

type Chamada = {
  tabela: string;
  op: string;
  payload?: Record<string, unknown>;
  filtros: Array<[metodo: string, coluna: string, valor: unknown]>;
};

function clienteFalso(roteiro: {
  update?: { data: unknown; error?: { message: string } | null };
  selects?: Array<{ data: unknown; error?: { message: string } | null }>;
}) {
  const chamadas: Chamada[] = [];
  const selects = [...(roteiro.selects ?? [])];

  const from = (tabela: string) => {
    const estado: Chamada = { tabela, op: "", filtros: [] };
    chamadas.push(estado);
    const builder = {
      update(payload: Record<string, unknown>) {
        estado.op = "update";
        estado.payload = payload;
        return builder;
      },
      select() {
        if (!estado.op) estado.op = "select";
        return builder;
      },
      eq(coluna: string, valor: unknown) {
        estado.filtros.push(["eq", coluna, valor]);
        return builder;
      },
      is(coluna: string, valor: unknown) {
        estado.filtros.push(["is", coluna, valor]);
        return builder;
      },
      not(coluna: string, metodo: string, valor: unknown) {
        estado.filtros.push(["not", `${coluna}:${metodo}`, valor]);
        return builder;
      },
      limit() {
        return builder;
      },
      gte() {
        return builder;
      },
      async maybeSingle() {
        if (estado.op === "update") {
          return { data: roteiro.update?.data ?? null, error: roteiro.update?.error ?? null };
        }
        const proximo = selects.shift() ?? { data: null, error: null };
        return { data: proximo.data, error: proximo.error ?? null };
      },
    };
    return builder;
  };

  return { client: { from } as unknown as SupabaseClient, chamadas };
}

const PEDIDO = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
  motivo: "  link   de   golpe  ",
  porUserId: "33333333-3333-4333-8333-333333333333",
};

describe("normalizarMotivo", () => {
  it("colapsa espaço e apara as pontas — o banco recebe o texto que a auditoria leu", () => {
    expect(normalizarMotivo("  link   de   golpe  ")).toBe("link de golpe");
    expect(normalizarMotivo("linha\nquebrada")).toBe("linha quebrada");
  });

  it("recusa vazio, só espaço, curto demais e acima do teto", () => {
    expect(normalizarMotivo("")).toBeNull();
    expect(normalizarMotivo("    ")).toBeNull();
    expect(normalizarMotivo("oi")).toBeNull();
    expect(normalizarMotivo(undefined)).toBeNull();
    expect(normalizarMotivo("x".repeat(MOTIVO_MAXIMO + 1))).toBeNull();
    expect(normalizarMotivo("x".repeat(MOTIVO_MAXIMO))).toHaveLength(MOTIVO_MAXIMO);
  });
});

describe("marcarMensagemEmQuarentena", () => {
  let roteiro: Parameters<typeof clienteFalso>[0];

  beforeEach(() => {
    roteiro = { update: { data: { id: PEDIDO.messageId } }, selects: [] };
  });

  it("grava o motivo normalizado, o autor e a hora — escopado por organização", async () => {
    const { client, chamadas } = clienteFalso(roteiro);

    const desfecho = await marcarMensagemEmQuarentena(client, PEDIDO);

    expect(desfecho).toMatchObject({ ok: true, jaEstava: false });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.tabela).toBe("messages");
    expect(chamadas[0]?.op).toBe("update");
    expect(chamadas[0]?.payload).toMatchObject({
      quarantine_reason: "link de golpe",
      quarantined_by_user_id: PEDIDO.porUserId,
    });
    expect(typeof chamadas[0]?.payload?.["quarantined_at"]).toBe("string");
    // Escopo: a organização entra no filtro, senão a marca cairia em mensagem
    // de outra empresa que por acaso tem o mesmo id (não tem, mas o filtro é a
    // diferença entre "não tem" e "confia em não ter").
    expect(chamadas[0]?.filtros).toContainEqual(["eq", "organization_id", PEDIDO.organizationId]);
    expect(chamadas[0]?.filtros).toContainEqual(["eq", "id", PEDIDO.messageId]);
    // Idempotência no BANCO: a segunda escrita não casa a linha já marcada.
    expect(chamadas[0]?.filtros).toContainEqual(["is", "quarantined_at", null]);
  });

  it("marcar duas vezes é idempotente e NÃO reescreve o motivo original", async () => {
    roteiro = {
      update: { data: null },
      selects: [{ data: { id: PEDIDO.messageId, quarantined_at: "2026-11-05T12:00:00.000Z" } }],
    };
    const { client, chamadas } = clienteFalso(roteiro);

    const desfecho = await marcarMensagemEmQuarentena(client, PEDIDO);

    expect(desfecho).toMatchObject({ ok: true, jaEstava: true });
    // Uma única escrita — a segunda chamada não pode ter tentado sobrescrever.
    expect(chamadas.filter((c) => c.op === "update")).toHaveLength(1);
  });

  it("mensagem de outra organização (ou inexistente) é nao_encontrada", async () => {
    roteiro = { update: { data: null }, selects: [{ data: null }] };
    const { client } = clienteFalso(roteiro);

    expect(await marcarMensagemEmQuarentena(client, PEDIDO)).toEqual({
      ok: false,
      erro: "nao_encontrada",
    });
  });

  it("motivo inválido não toca o banco", async () => {
    const { client, chamadas } = clienteFalso(roteiro);

    expect(await marcarMensagemEmQuarentena(client, { ...PEDIDO, motivo: "  " })).toEqual({
      ok: false,
      erro: "motivo_invalido",
    });
    expect(chamadas).toHaveLength(0);
  });

  it("erro do banco volta como falha — nunca como sucesso silencioso", async () => {
    roteiro = { update: { data: null, error: { message: "permission denied" } } };
    const { client } = clienteFalso(roteiro);

    const desfecho = await marcarMensagemEmQuarentena(client, PEDIDO);
    expect(desfecho.ok).toBe(false);
    if (!desfecho.ok) expect(desfecho.erro).toBe("falha");
  });
});

describe("liberarMensagemDaQuarentena", () => {
  it("zera as três colunas, só na linha marcada, e devolve o motivo anterior", async () => {
    const { client, chamadas } = clienteFalso({
      update: { data: { id: PEDIDO.messageId, quarantine_reason: "link de golpe" } },
    });

    const desfecho = await liberarMensagemDaQuarentena(client, {
      organizationId: PEDIDO.organizationId,
      messageId: PEDIDO.messageId,
    });

    expect(desfecho).toEqual({ ok: true, estava: true, motivo: "link de golpe" });
    expect(chamadas[0]?.payload).toEqual({
      quarantined_at: null,
      quarantine_reason: null,
      quarantined_by_user_id: null,
    });
    expect(chamadas[0]?.filtros).toContainEqual(["not", "quarantined_at:is", null]);
    expect(chamadas[0]?.filtros).toContainEqual(["eq", "organization_id", PEDIDO.organizationId]);
  });

  it("liberar quem não estava em quarentena é no-op com sucesso (não é 404)", async () => {
    const { client } = clienteFalso({ update: { data: null }, selects: [{ data: { id: "x" } }] });

    expect(
      await liberarMensagemDaQuarentena(client, {
        organizationId: PEDIDO.organizationId,
        messageId: PEDIDO.messageId,
      }),
    ).toEqual({ ok: true, estava: false, motivo: null });
  });

  it("mensagem de outra organização é nao_encontrada — não existe liberação entre empresas", async () => {
    const { client } = clienteFalso({ update: { data: null }, selects: [{ data: null }] });

    expect(
      await liberarMensagemDaQuarentena(client, {
        organizationId: PEDIDO.organizationId,
        messageId: PEDIDO.messageId,
      }),
    ).toEqual({ ok: false, erro: "nao_encontrada" });
  });
});

describe("lerQuarentenaDaMensagem", () => {
  it("devolve a marca e o motivo quando a linha está marcada", async () => {
    const { client } = clienteFalso({
      selects: [{ data: { quarantined_at: "2026-11-05T12:00:00.000Z", quarantine_reason: "golpe" } }],
    });

    expect(
      await lerQuarentenaDaMensagem(client, {
        organizationId: PEDIDO.organizationId,
        messageId: PEDIDO.messageId,
      }),
    ).toEqual({ emQuarentena: true, motivo: "golpe" });
  });

  it("linha sem marca (ou ausente) responde 'não está'", async () => {
    const semMarca = clienteFalso({
      selects: [{ data: { quarantined_at: null, quarantine_reason: null } }],
    });
    expect(
      await lerQuarentenaDaMensagem(semMarca.client, {
        organizationId: PEDIDO.organizationId,
        messageId: PEDIDO.messageId,
      }),
    ).toEqual({ emQuarentena: false, motivo: null });

    const ausente = clienteFalso({ selects: [{ data: null }] });
    expect(
      await lerQuarentenaDaMensagem(ausente.client, {
        organizationId: PEDIDO.organizationId,
        messageId: PEDIDO.messageId,
      }),
    ).toEqual({ emQuarentena: false, motivo: null });
  });

  it("erro de leitura FALHA ABERTA: 'não está', sem lançar", async () => {
    // Fail-open é o lado seguro da conversa: um timeout não pode calar um
    // cliente legítimo nem derrubar a ingestão (o provider reentregaria tudo).
    const { client } = clienteFalso({ selects: [{ data: null, error: { message: "timeout" } }] });

    await expect(
      lerQuarentenaDaMensagem(client, {
        organizationId: PEDIDO.organizationId,
        messageId: PEDIDO.messageId,
      }),
    ).resolves.toEqual({ emQuarentena: false, motivo: null });
  });
});

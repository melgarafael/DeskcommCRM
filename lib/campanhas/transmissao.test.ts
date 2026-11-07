import { describe, expect, it } from "vitest";

import type { DestinatarioDaTransmissao } from "@/lib/channels/transmissao";

import { desfechoDaTransmissao } from "./transmissao";

/**
 * O relatório do provedor levado a cada destinatário da campanha. Ele é lido a
 * cada rodada, inteiro, e o eco pelo webhook pode ter chegado antes: a regra é
 * nunca rebaixar e nunca mexer em quem já saiu da campanha por outro motivo.
 */

const item = (x: Partial<DestinatarioDaTransmissao>): DestinatarioDaTransmissao => ({
  telefone: "5511987654321",
  status: "sent",
  idDaMensagem: "wamid.X",
  codigoDoErro: null,
  erro: null,
  enviadoEm: "2026-10-16T21:31:04.508Z",
  entregueEm: null,
  lidoEm: null,
  ...x,
});

const reservado = { status: "sending", sent_at: null, delivered_at: null, read_at: null };

describe("desfechoDaTransmissao", () => {
  it("reservado que o provedor entregou vira `delivered`, com as duas horas", () => {
    expect(
      desfechoDaTransmissao(reservado, item({ status: "delivered", entregueEm: "2026-10-16T21:31:07.000Z" })),
    ).toEqual({ sent_at: "2026-10-16T21:31:04.508Z", delivered_at: "2026-10-16T21:31:07.000Z", status: "delivered" });
  });

  it("não rebaixa: o `read` que o eco trouxe não volta a `delivered` numa leitura atrasada", () => {
    const lido = { status: "read", sent_at: "t1", delivered_at: "t2", read_at: "t3" };
    expect(desfechoDaTransmissao(lido, item({ status: "delivered", entregueEm: "t2" }))).toBeNull();
  });

  it("falha traz o código e a explicação, e solta a reserva", () => {
    expect(
      desfechoDaTransmissao(
        reservado,
        item({ status: "failed", codigoDoErro: "131049", erro: "Meta chose not to deliver", enviadoEm: null }),
      ),
    ).toEqual({ status: "failed", last_error_code: "131049", last_error_detail: "Meta chose not to deliver", sending_at: null });
  });

  it("falha não apaga uma entrega que já aconteceu", () => {
    const entregue = { status: "delivered", sent_at: "t1", delivered_at: "t2", read_at: null };
    expect(desfechoDaTransmissao(entregue, item({ status: "failed", enviadoEm: null }))).toBeNull();
  });

  it("quem respondeu, saiu ou foi cancelado mantém o status — só ganha as horas que faltavam", () => {
    for (const status of ["replied", "opted_out", "cancelled"]) {
      expect(
        desfechoDaTransmissao(
          { status, sent_at: "t1", delivered_at: null, read_at: null },
          item({ status: "read", entregueEm: "t2", lidoEm: "t3" }),
        ),
      ).toEqual({ delivered_at: "t2", read_at: "t3" });
    }
  });

  it("devolvido à fila por uma rodada que caiu, mas que o provedor mandou: o relatório corrige", () => {
    expect(desfechoDaTransmissao({ ...reservado, status: "pending" }, item({ status: "sent" }))).toEqual({
      sent_at: "2026-10-16T21:31:04.508Z",
      status: "sent",
    });
  });

  it("ainda pendente no provedor, ou ausente do relatório: nada muda", () => {
    expect(desfechoDaTransmissao(reservado, item({ status: "pending", enviadoEm: null }))).toBeNull();
    expect(desfechoDaTransmissao(reservado, undefined)).toBeNull();
  });
});

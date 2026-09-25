import { describe, expect, it } from "vitest";

import {
  destinatarioQueEssaRespostaFecha,
  JANELA_DE_ATRIBUICAO_MS,
  type DestinatarioCandidato,
} from "./resposta";

const AGORA = new Date("2026-09-18T12:00:00.000Z");

function enviado(over: Partial<DestinatarioCandidato> & { hAtras: number }): DestinatarioCandidato {
  return {
    id: over.id ?? "r1",
    status: over.status ?? "sent",
    sent_at: new Date(AGORA.getTime() - over.hAtras * 3_600_000).toISOString(),
    replied_at: over.replied_at ?? null,
  };
}

describe("a qual envio esta resposta responde", () => {
  it("fecha o envio mais recente dentro da janela", () => {
    const escolhido = destinatarioQueEssaRespostaFecha(
      [enviado({ id: "velho", hAtras: 40 }), enviado({ id: "novo", hAtras: 2 })],
      AGORA,
    );
    expect(escolhido?.id).toBe("novo");
  });

  it("72 horas é a borda: dentro conta, fora não", () => {
    const dentro = destinatarioQueEssaRespostaFecha([enviado({ hAtras: 71 })], AGORA);
    expect(dentro).not.toBeNull();
    const fora = destinatarioQueEssaRespostaFecha([enviado({ hAtras: 73 })], AGORA);
    // Sem a janela, uma mensagem de meses depois viraria "resposta à campanha" e
    // a taxa de resposta subiria sozinha com o tempo.
    expect(fora).toBeNull();
    expect(JANELA_DE_ATRIBUICAO_MS).toBe(72 * 3_600_000);
  });

  it("quem já respondeu não responde de novo — evento repetido não duplica métrica", () => {
    const linhas = [enviado({ hAtras: 2, replied_at: "2026-09-18T10:00:00.000Z" })];
    expect(destinatarioQueEssaRespostaFecha(linhas, AGORA)).toBeNull();
  });

  it("só promove quem SAIU: pendente, falho, pulado e cancelado não viram resposta", () => {
    for (const status of ["pending", "queued", "sending", "failed", "skipped", "cancelled"]) {
      expect(destinatarioQueEssaRespostaFecha([enviado({ hAtras: 1, status })], AGORA), status).toBeNull();
    }
    for (const status of ["sent", "delivered", "read"]) {
      expect(destinatarioQueEssaRespostaFecha([enviado({ hAtras: 1, status })], AGORA), status).not.toBeNull();
    }
  });

  it("envio POSTERIOR à resposta não é o que ela responde", () => {
    // Acontece de verdade: o ack e o inbound chegam quase juntos, e a ordem de
    // processamento não é a ordem do relógio.
    const linhas = [enviado({ id: "depois", hAtras: -1 }), enviado({ id: "antes", hAtras: 3 })];
    expect(destinatarioQueEssaRespostaFecha(linhas, AGORA)?.id).toBe("antes");
  });

  it("linha sem carimbo de envio, ou com data corrompida, é ignorada em vez de explodir", () => {
    const semData: DestinatarioCandidato = { id: "x", status: "sent", sent_at: null, replied_at: null };
    const lixo: DestinatarioCandidato = { id: "y", status: "sent", sent_at: "ontem", replied_at: null };
    expect(destinatarioQueEssaRespostaFecha([semData, lixo], AGORA)).toBeNull();
  });

  it("lista vazia não escolhe ninguém", () => {
    expect(destinatarioQueEssaRespostaFecha([], AGORA)).toBeNull();
  });
});

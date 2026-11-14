import { describe, expect, it } from "vitest";
import { desfechoDoAgendamento } from "@/lib/agendamento-mensagem/desfecho";

describe("desfechoDoAgendamento — a fila do canal não conta como enviada (#3118, doc 314)", () => {
  it("encaminhada com a mensagem ainda em queued/sending é 'Na fila de envio'", () => {
    for (const status of ["queued", "sending"]) {
      expect(desfechoDoAgendamento({ status: "encaminhada", mensagem: { status } }).desfecho).toBe("na_fila");
    }
  });

  it("encaminhada sem a linha da mensagem também não vira 'Enviada'", () => {
    expect(desfechoDoAgendamento({ status: "encaminhada", mensagem: null }).desfecho).toBe("na_fila");
  });

  it("só sent, delivered e read são 'Enviada'", () => {
    for (const status of ["sent", "delivered", "read"]) {
      expect(desfechoDoAgendamento({ status: "encaminhada", mensagem: { status } })).toEqual({ desfecho: "enviada", tom: "success" });
    }
  });

  it("a mensagem que falhou depois de encaminhada aparece como falha", () => {
    expect(desfechoDoAgendamento({ status: "encaminhada", mensagem: { status: "failed" } }).desfecho).toBe("falhou");
    expect(desfechoDoAgendamento({ status: "falhou", mensagem: null }).desfecho).toBe("falhou");
  });

  it("cancelada é cancelada", () => {
    expect(desfechoDoAgendamento({ status: "cancelada", mensagem: null }).desfecho).toBe("cancelada");
  });
});

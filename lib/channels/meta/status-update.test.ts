import { describe, expect, it } from "vitest";

import { statusUpdate } from "./status-update";
import type { MessageStatusEvent } from "./webhook";

const AGORA = "2026-09-21T12:00:00.000Z";

function evento(over: Partial<MessageStatusEvent>): MessageStatusEvent {
  return {
    kind: "message_status",
    wabaId: "waba-1",
    externalId: "wamid.HBg",
    status: "sent",
    recipient: "5571992894634",
    errorCode: null,
    errorTitle: null,
    ...over,
  };
}

describe("statusUpdate", () => {
  it("guarda o motivo quando a Meta reprova a entrega", () => {
    const u = statusUpdate(
      evento({ status: "failed", errorCode: 131026, errorTitle: "Message Undeliverable" }),
      AGORA,
    );
    expect(u.status).toBe("failed");
    expect(u.error_code).toBe("131026");
    expect(u.error_message).toBe("Message Undeliverable");
  });

  it("carimba entrega e leitura em vez de achatar tudo em sent", () => {
    expect(statusUpdate(evento({ status: "delivered" }), AGORA)).toMatchObject({
      status: "sent",
      delivered_at: AGORA,
    });
    expect(statusUpdate(evento({ status: "read" }), AGORA)).toMatchObject({
      delivered_at: AGORA,
      read_at: AGORA,
    });
  });

  it("não inventa carimbo nem erro no sent cru", () => {
    const u = statusUpdate(evento({ status: "sent" }), AGORA);
    expect(u).toEqual({ status: "sent", updated_at: AGORA });
  });

  describe("#4316 — a hora da entrega é de uma vez só", () => {
    it("(a) delivered grava delivered_at e não toca read_at", () => {
      const u = statusUpdate(evento({ status: "delivered" }), AGORA, { delivered_at: null });
      expect(u).toMatchObject({ status: "sent", delivered_at: AGORA });
      expect(u).not.toHaveProperty("read_at");
    });

    it("(b) read preserva o delivered_at que já estava na linha", () => {
      const ENTREGUE_ANTES = "2026-09-21T11:59:30.000Z";
      const u = statusUpdate(evento({ status: "read" }), AGORA, {
        delivered_at: ENTREGUE_ANTES,
      });
      expect(u).toMatchObject({ status: "sent", read_at: AGORA });
      expect(u.delivered_at).toBeUndefined();
    });

    it("(c) read sem delivered antes carimba a entrega uma vez", () => {
      const u = statusUpdate(evento({ status: "read" }), AGORA, { delivered_at: null });
      expect(u).toMatchObject({ delivered_at: AGORA, read_at: AGORA });
    });
  });
});

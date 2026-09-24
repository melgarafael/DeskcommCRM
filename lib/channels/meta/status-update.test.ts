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
});

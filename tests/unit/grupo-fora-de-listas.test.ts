import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

describe("grupos: quem escuta e quem não escuta", () => {
  it("a notificação do atendente escuta mensagem de grupo", () => {
    expect(webPushInboundHandler.events).toContain("message.group_received");
  });

  it("nenhum outro consumidor registrado escuta message.group_received", async () => {
    const { getRegisteredHandlers } = await import("@/lib/event-log/dispatcher");
    ensureHandlersRegistered();
    const escutam = getRegisteredHandlers()
      .filter((h) => h.events.includes("message.group_received"))
      .map((h) => h.key);
    expect(escutam).toEqual([webPushInboundHandler.key]);
  });

  it("listagem de contatos e audiência de campanha excluem o contato de grupo", () => {
    for (const arquivo of ["app/api/v1/contacts/_handler.ts", "lib/campanhas/consulta-de-audiencia.ts"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/\.eq\(\s*["']kind["']\s*,\s*["']person["']\s*\)/);
    }
  });
});

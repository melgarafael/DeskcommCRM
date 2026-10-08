/**
 * `enviarPushAosUsuarios` — push para a lista fechada de `message.received`
 * (responsável + admins). Prova que só as inscrições DAQUELAS pessoas, na
 * organização do evento, recebem, e que a faxina 404/410 continua valendo.
 *
 * Roda com: npx vitest run lib/notifications/web_push.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendNotification, deletados } = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  deletados: [] as Array<[string, string]>,
}));

vi.mock("web-push", () => ({ default: { setVapidDetails: vi.fn(), sendNotification } }));
vi.mock("./vapid", () => ({
  vapidPronto: () => true,
  vapidPublica: () => "pub",
  vapidSubject: async () => "mailto:x@example.com",
}));
vi.mock("@/lib/env", () => ({ env: { VAPID_PRIVATE_KEY: "priv" } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { enviarPushAosUsuarios } from "./web_push";

function adminFalso(linhas: Array<{ id: string; endpoint: string }>) {
  const filtros: Array<[string, string, unknown]> = [];
  const admin = {
    from: () => {
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push(["eq", c, v]), q),
        in: async (c: string, v: unknown) => {
          filtros.push(["in", c, v]);
          return { data: linhas.map((l) => ({ ...l, p256dh: "k", auth: "a" })), error: null };
        },
        delete: () => ({
          eq: async (c: string, v: string) => {
            deletados.push([c, v]);
            return { error: null };
          },
        }),
      };
      return q;
    },
  };
  return { admin, filtros };
}

beforeEach(() => {
  sendNotification.mockReset();
  deletados.length = 0;
});

describe("enviarPushAosUsuarios", () => {
  it("filtra pela org e pelos user_ids, e envia a cada inscrição deles", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin, filtros } = adminFalso([
      { id: "s1", endpoint: "https://push/1" },
      { id: "s2", endpoint: "https://push/2" },
    ]);
    const r = await enviarPushAosUsuarios("org-1", ["u-ana", "u-admin"], { title: "t", body: "b" } as never, admin as never);
    expect(r).toEqual({ sent: 2, gone: 0 });
    expect(filtros).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(filtros).toContainEqual(["in", "user_id", ["u-ana", "u-admin"]]);
  });

  it("inscrição morta (410) é apagada, como no envio da org", async () => {
    sendNotification.mockRejectedValueOnce({ statusCode: 410 }).mockResolvedValueOnce(undefined);
    const { admin } = adminFalso([
      { id: "morta", endpoint: "https://push/1" },
      { id: "viva", endpoint: "https://push/2" },
    ]);
    const r = await enviarPushAosUsuarios("org-1", ["u-ana"], { title: "t", body: "b" } as never, admin as never);
    expect(r).toEqual({ sent: 1, gone: 1 });
    expect(deletados).toEqual([["id", "morta"]]);
  });

  it("lista vazia não consulta nem envia nada", async () => {
    const { admin, filtros } = adminFalso([{ id: "s1", endpoint: "https://push/1" }]);
    const r = await enviarPushAosUsuarios("org-1", [], { title: "t", body: "b" } as never, admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(filtros).toEqual([]);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

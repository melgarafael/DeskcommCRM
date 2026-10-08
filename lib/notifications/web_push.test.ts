/**
 * `enviarPushAQuemVeAConversa` — push de `message.received`. Só sai para as
 * inscrições que o banco devolveu como capazes de ver a conversa; a lista de
 * quem deve ser avisado (responsável + admins) só estreita esse conjunto, e a
 * faxina 404/410 continua valendo.
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

import { enviarPushAQuemVeAConversa } from "./web_push";

type Linha = { id: string; user_id: string; endpoint: string };

function adminFalso(linhas: Linha[], erro: { message: string } | null = null) {
  const chamadas: Array<[string, unknown]> = [];
  const admin = {
    rpc: async (fn: string, args: unknown) => {
      chamadas.push([fn, args]);
      return erro ? { data: null, error: erro } : { data: linhas.map((l) => ({ ...l, p256dh: "k", auth: "a" })), error: null };
    },
    from: () => ({
      delete: () => ({
        eq: async (c: string, v: string) => {
          deletados.push([c, v]);
          return { error: null };
        },
      }),
    }),
  };
  return { admin, chamadas };
}

const payload = { title: "t", body: "b" } as never;

beforeEach(() => {
  sendNotification.mockReset();
  deletados.length = 0;
});

describe("enviarPushAQuemVeAConversa", () => {
  it("pergunta ao banco quem vê a conversa DO EVENTO e envia só a essas inscrições", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin, chamadas } = adminFalso([
      { id: "s1", user_id: "u-ana", endpoint: "https://push/1" },
      { id: "s2", user_id: "u-admin", endpoint: "https://push/2" },
    ]);
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 2, gone: 0 });
    expect(chamadas).toEqual([
      ["fn_push_inscricoes_que_veem_a_conversa", { p_org: "org-1", p_conversation: "conv-1" }],
    ]);
  });

  it("a lista de quem deve ser avisado só estreita: quem não pode ver não entra por ela", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso([{ id: "s1", user_id: "u-ana", endpoint: "https://push/ana" }]);
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, ["u-ana", "u-bruno"], admin as never);
    expect(r).toEqual({ sent: 1, gone: 0 });
    expect(sendNotification.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint)).toEqual([
      "https://push/ana",
    ]);
  });

  it("quem pode ver mas não está na lista decidida não recebe", async () => {
    sendNotification.mockResolvedValue(undefined);
    const { admin } = adminFalso([
      { id: "s1", user_id: "u-ana", endpoint: "https://push/ana" },
      { id: "s2", user_id: "u-carla", endpoint: "https://push/carla" },
    ]);
    await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, ["u-ana"], admin as never);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("inscrição morta (410) é apagada, como no envio da org", async () => {
    sendNotification.mockRejectedValueOnce({ statusCode: 410 }).mockResolvedValueOnce(undefined);
    const { admin } = adminFalso([
      { id: "morta", user_id: "u-ana", endpoint: "https://push/1" },
      { id: "viva", user_id: "u-ana", endpoint: "https://push/2" },
    ]);
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 1, gone: 1 });
    expect(deletados).toEqual([["id", "morta"]]);
  });

  it("lista decidida vazia não consulta nem envia nada", async () => {
    const { admin, chamadas } = adminFalso([{ id: "s1", user_id: "u-ana", endpoint: "https://push/1" }]);
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, [], admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(chamadas).toEqual([]);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("falha ao perguntar quem vê → ninguém recebe", async () => {
    const { admin } = adminFalso([], { message: "banco fora" });
    const r = await enviarPushAQuemVeAConversa("org-1", "conv-1", payload, undefined, admin as never);
    expect(r).toEqual({ sent: 0, gone: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

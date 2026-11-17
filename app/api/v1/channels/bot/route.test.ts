import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O canal do robô é módulo opcional da instalação (doc 216, A): desligado, a
 * rota responde 404 antes de ler o corpo ou o banco. Ligado, ela segue o fluxo.
 */
const h = vi.hoisted(() => ({
  ligado: false,
  modulosPerguntados: [] as string[],
  lidas: 0,
  conexoes: 0,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "cccccccc-0000-4000-8000-0000000000ee" },
    org: { orgId: "cccccccc-0000-4000-8000-000000000001", role: "admin" },
  }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/instalacao/modulos", () => ({
  moduloLigado: async (_db: unknown, modulo: string) => {
    h.modulosPerguntados.push(modulo);
    return h.ligado;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));
vi.mock("@/lib/webhooks/url-publica", () => ({ basePublicaDaInstalacao: () => "https://crm.exemplo.com.br" }));
vi.mock("@/lib/channels/bot/connect", () => ({
  ROTULO_DO_CANAL: "Robô",
  acharSessaoDoRobo: async () => {
    h.lidas++;
    return null;
  },
  conectarRobo: async () => {
    h.conexoes++;
    return { ok: true, bot: { id: "777", username: "acme_bot", firstName: "Acme" }, channelSessionId: "s1", webhookUrl: "u" };
  },
}));

import { GET, POST } from "./route";

const url = "http://localhost/api/v1/channels/bot";
const conectar = () =>
  POST(new NextRequest(url, { method: "POST", body: JSON.stringify({ token: "123456789:AAH-um-token-bem-comprido" }) }));

beforeEach(() => {
  h.ligado = false;
  h.modulosPerguntados = [];
  h.lidas = 0;
  h.conexoes = 0;
});

describe("/api/v1/channels/bot com o módulo desligado", () => {
  it("GET e POST respondem 404, sem ler a sessão nem conectar", async () => {
    expect((await GET(new NextRequest(url))).status).toBe(404);
    expect((await conectar()).status).toBe(404);
    expect(h.lidas).toBe(0);
    expect(h.conexoes).toBe(0);
    expect(h.modulosPerguntados).toEqual(["canal_bot", "canal_bot"]);
  });
});

describe("/api/v1/channels/bot com o módulo ligado (controle)", () => {
  it("GET devolve o estado e POST conecta", async () => {
    h.ligado = true;
    const g = await GET(new NextRequest(url));
    expect(g.status).toBe(200);
    expect(((await g.json()) as { data: { connected: boolean } }).data.connected).toBe(false);
    expect((await conectar()).status).toBe(200);
    expect(h.conexoes).toBe(1);
  });
});

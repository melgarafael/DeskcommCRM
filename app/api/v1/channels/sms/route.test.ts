import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O canal de SMS é módulo opcional da instalação (`canal_sms`, no molde do
 * `canal_bot`): desligado, a rota responde 404 antes de ler o corpo, o banco ou
 * a conta do fornecedor. Ligado, ela segue o fluxo de sempre.
 */
const h = vi.hoisted(() => ({
  ligado: false,
  modulosPerguntados: [] as string[],
  lidas: 0,
  consultasNaConta: 0,
  gravacoes: 0,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "dddddddd-0000-4000-8000-0000000000ee", idioma: "pt-BR" },
    org: { orgId: "dddddddd-0000-4000-8000-000000000001", role: "admin" },
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
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "cifrado" }));
vi.mock("@/lib/channels/sms", () => ({
  ROTULO_DO_CANAL_SMS: "SMS",
  acharSessaoDeSms: async () => {
    h.lidas++;
    return null;
  },
  acharNumeroNaConta: async () => {
    h.consultasNaConta++;
    return { ok: true, numeroId: "PN0000", numero: "+15555550123", nome: null };
  },
  salvarSessaoDeSms: async () => {
    h.gravacoes++;
    return { error: null, channelSessionId: "s1", webhookPathToken: "tok" };
  },
  apontarRecebimentoDoNumero: async () => ({ ok: true }),
}));

import { GET, POST } from "./route";

const url = "http://localhost/api/v1/channels/sms";
const conectar = () =>
  POST(
    new NextRequest(url, {
      method: "POST",
      body: JSON.stringify({
        account_sid: `AC${"0".repeat(32)}`,
        auth_token: "um-token-de-teste-inventado",
        phone_number: "+15555550123",
      }),
    }),
  );

beforeEach(() => {
  h.ligado = false;
  h.modulosPerguntados = [];
  h.lidas = 0;
  h.consultasNaConta = 0;
  h.gravacoes = 0;
});

describe("/api/v1/channels/sms com o módulo desligado", () => {
  it("GET e POST respondem 404, sem ler a sessão, sem consultar a conta e sem gravar", async () => {
    expect((await GET(new NextRequest(url))).status).toBe(404);
    expect((await conectar()).status).toBe(404);
    expect(h.lidas).toBe(0);
    expect(h.consultasNaConta).toBe(0);
    expect(h.gravacoes).toBe(0);
    expect(h.modulosPerguntados).toEqual(["canal_sms", "canal_sms"]);
  });

  it("o POST recusa antes de ler o corpo: um corpo inválido também recebe 404, e não 422", async () => {
    const r = await POST(new NextRequest(url, { method: "POST", body: "isto não é JSON" }));
    expect(r.status).toBe(404);
  });
});

describe("/api/v1/channels/sms com o módulo ligado (controle)", () => {
  it("GET devolve o estado e POST conecta", async () => {
    h.ligado = true;
    const g = await GET(new NextRequest(url));
    expect(g.status).toBe(200);
    expect(((await g.json()) as { data: { connected: boolean } }).data.connected).toBe(false);
    const p = await conectar();
    expect(p.status).toBe(200);
    expect(h.consultasNaConta).toBe(1);
    expect(h.gravacoes).toBe(1);
  });

  it("corpo inválido volta a ser 422 quando o módulo está ligado", async () => {
    h.ligado = true;
    const r = await POST(new NextRequest(url, { method: "POST", body: "isto não é JSON" }));
    expect(r.status).toBe(422);
  });
});

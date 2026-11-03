/**
 * POST /api/v1/webhooks/canal-da-instalacao — a tradução do desfecho em HTTP.
 * De quem é o evento é medido em `lib/channels/entrada-da-instalacao.test.ts`;
 * o que acontece depois, nas cercas de `_entrada-do-canal.ts`.
 */
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resolver: vi.fn(), processar: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/channels/entrada-da-instalacao", () => ({
  resolverEntradaDaInstalacao: h.resolver,
}));
vi.mock("../_entrada-do-canal", () => ({ processarEntradaDoCanal: h.processar }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: h.warn, info: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";

const chamar = (corpo = '{"event":"message.received"}') =>
  POST(
    new Request("https://crm.test/api/v1/webhooks/canal-da-instalacao", {
      method: "POST",
      body: corpo,
      headers: { "x-qualquer": "1" },
    }) as never,
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.processar.mockResolvedValue(
    new Response(JSON.stringify({ data: { status: "ingested" } }), { status: 200 }),
  );
});

it("sem webhook registrado: 404, como token desconhecido", async () => {
  h.resolver.mockResolvedValue({
    tipo: "recusa",
    status: 404,
    motivo: "sem_webhook_da_instalacao",
  });
  expect((await chamar()).status).toBe(404);
  expect(h.processar).not.toHaveBeenCalled();
});

it("assinatura recusada: 401 e uma linha no log", async () => {
  h.resolver.mockResolvedValue({ tipo: "recusa", status: 401, motivo: "bad_signature" });
  const r = await chamar();
  expect(r.status).toBe(401);
  expect(h.warn).toHaveBeenCalledTimes(1);
  expect(h.processar).not.toHaveBeenCalled();
});

it("evento de ninguém: 200 ignorado, para o provedor não reentregar para sempre", async () => {
  h.resolver.mockResolvedValue({ tipo: "ignorar", motivo: "conta_desconhecida" });
  const r = await chamar();
  expect(r.status).toBe(200);
  expect((await r.json()).data).toEqual({ status: "ignored", reason: "conta_desconhecida" });
  expect(h.processar).not.toHaveBeenCalled();
});

it("sessão achada: o MESMO processamento da rota por token, com o corpo cru e o segredo da instalação", async () => {
  const sessao = { id: "s-1", organization_id: "org-1", provider: "parceiro" };
  h.resolver.mockResolvedValue({ tipo: "sessao", sessao, secret: "segredo" });
  const corpo = '{"event":"message.received","account":{"id":"x"}}';
  const r = await chamar(corpo);
  expect(r.status).toBe(200);
  const [, entrada] = h.processar.mock.calls[0] ?? [];
  expect(entrada).toMatchObject({ sessao, rawBody: corpo, secret: "segredo" });
  expect((entrada as { headers: Headers }).headers.get("x-qualquer")).toBe("1");
});

it("falha ao ler o banco: 500, que é quando a reentrega é o que queremos", async () => {
  h.resolver.mockRejectedValue(new Error("banco fora"));
  expect((await chamar()).status).toBe(500);
});

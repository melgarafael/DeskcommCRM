/**
 * POST /api/v1/channels/partner/um-clique — as guardas e a tradução das recusas.
 * O fluxo em si é medido em `lib/channels/conexao-um-clique.test.ts`.
 */
import { beforeEach, expect, it, vi } from "vitest";

import type * as ConexaoUmClique from "@/lib/channels/conexao-um-clique";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  mfa: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
  iniciar: vi.fn(),
  concluir: vi.fn(),
  baseConfigurada: "https://crm.exemplo.com" as string | undefined,
  provedor: "https://provedor.exemplo.com/api",
}));
vi.mock("@/lib/env", async (original) => {
  const { env: real } = await original<{ env: Record<string, unknown> }>();
  return {
    env: new Proxy(real, {
      get: (alvo, chave) => (chave === "NEXT_PUBLIC_APP_URL" ? h.baseConfigurada : alvo[chave as string]),
    }),
  };
});
vi.mock("@/lib/channels/connect", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  partnerEndpoint: () => h.provedor,
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfa }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: h.limit }));
vi.mock("@/lib/branding/saida", () => ({
  marcaDaSaida: async () => ({ nome: "Marca", accent: "#206ce8" }),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/conexao-um-clique", async (original) => ({
  ...(await original<typeof ConexaoUmClique>()),
  iniciarConexaoUmClique: h.iniciar,
  concluirConexaoUmClique: h.concluir,
}));

import { ErroDaConexaoUmClique } from "@/lib/channels/conexao-um-clique";

import { POST } from "./route";

const chamar = (corpo: unknown, cabecalhos: Record<string, string> = {}) =>
  POST(
    new Request("https://crm.test/api/v1/channels/partner/um-clique", {
      method: "POST",
      body: JSON.stringify(corpo),
      headers: cabecalhos,
    }) as never,
  );

const concluida = {
  channelSessionId: "sessao-1",
  phoneNumber: "+5511987650000",
  displayName: "Loja",
  webhookRegistrado: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.baseConfigurada = "https://crm.exemplo.com";
  h.provedor = "https://provedor.exemplo.com/api";
  h.role.mockResolvedValue({
    ok: true,
    org: { orgId: "org-1", name: "Loja" },
    user: { id: "admin-1", idioma: "es" },
  });
  h.mfa.mockResolvedValue(false);
  h.support.mockResolvedValue(null);
  h.limit.mockResolvedValue({ allowed: true });
  h.iniciar.mockResolvedValue({ tipo: "pagina", url: "https://provedor.test/cadastro" });
  h.concluir.mockResolvedValue(concluida);
});

it("quem não é dono não passa", async () => {
  const negado = new Response(null, { status: 403 });
  h.role.mockResolvedValue({ ok: false, response: negado });
  expect((await chamar({ acao: "iniciar", coexistencia: true })).status).toBe(403);
  expect(h.iniciar).not.toHaveBeenCalled();
});

it("verificação em duas etapas pendente recusa antes de tudo", async () => {
  h.mfa.mockResolvedValue(true);
  const r = await chamar({ acao: "iniciar", coexistencia: true });
  expect(r.status).toBe(403);
  expect((await r.json()).error.code).toBe("mfa_required");
  expect(h.iniciar).not.toHaveBeenCalled();
});

it("tentativas demais: 429 com Retry-After", async () => {
  h.limit.mockResolvedValue({ allowed: false });
  const r = await chamar({ acao: "iniciar", coexistencia: true });
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toBe("60");
});

it("corpo fora do formato: 400, sem chamar o fluxo", async () => {
  expect((await chamar({ acao: "iniciar" })).status).toBe(400);
  expect(
    (await chamar({ acao: "concluir", estado: "x".repeat(30), erro: "<script>" })).status,
  ).toBe(400);
  expect(h.iniciar).not.toHaveBeenCalled();
  expect(h.concluir).not.toHaveBeenCalled();
});

it("iniciar devolve a página e passa a organização da SESSÃO, nunca do corpo", async () => {
  const r = await chamar({ acao: "iniciar", coexistencia: false });
  expect(r.status).toBe(200);
  expect((await r.json()).data).toEqual({ url: "https://provedor.test/cadastro" });
  const [, ctx, opcoes] = h.iniciar.mock.calls[0] ?? [];
  expect(ctx).toMatchObject({
    organizationId: "org-1",
    organizationNome: "Loja",
    userId: "admin-1",
    idioma: "es",
  });
  expect(opcoes).toEqual({ coexistencia: false, marca: "Marca", cor: "#206ce8" });
  expect(h.audit).not.toHaveBeenCalled();
});

it("concluir grava e audita a conexão", async () => {
  const r = await chamar({
    acao: "concluir",
    estado: "e".repeat(30),
    account_id: "b".repeat(24),
    profile_id: "a".repeat(24),
  });
  expect(r.status).toBe(200);
  expect((await r.json()).data).toMatchObject({
    connected: true,
    channel_session_id: "sessao-1",
    webhook_automatico: true,
  });
  expect(h.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "channel.connected",
      organizationId: "org-1",
      resourceId: "sessao-1",
      metadata: expect.objectContaining({ modo: "um_clique", webhook: "registrado" }),
    }),
  );
});

it("recusa do fluxo sai com o status e a frase traduzida", async () => {
  h.concluir.mockRejectedValue(
    new ErroDaConexaoUmClique("A conexão foi cancelada na janela da Meta.", 422),
  );
  const r = await chamar({
    acao: "concluir",
    estado: "e".repeat(30),
    erro: "connection_cancelled",
  });
  expect(r.status).toBe(422);
  expect((await r.json()).error.message).toBe("La conexión se canceló en la ventana de Meta.");
  expect(h.audit).not.toHaveBeenCalled();
});

it("limite do plano recusado pelo banco vira plan_limit_reached", async () => {
  h.concluir.mockRejectedValue(new Error("limite_do_plano:canais:1"));
  const r = await chamar({
    acao: "concluir",
    estado: "e".repeat(30),
    account_id: "b".repeat(24),
    profile_id: "a".repeat(24),
  });
  expect(r.status).toBe(409);
  expect((await r.json()).error.code).toBe("plan_limit_reached");
});

it("falha inesperada do provedor: 502 sem vazar o detalhe", async () => {
  h.iniciar.mockRejectedValue(new Error("HTTP 500 com corpo interno"));
  const r = await chamar({ acao: "iniciar", coexistencia: true });
  expect(r.status).toBe(502);
  expect(JSON.stringify(await r.json())).not.toContain("corpo interno");
});

const FORJADO = { origin: "https://outro-lugar.example", host: "outro-lugar.example" };

it("o endereço do webhook único vem da configuração, nunca do Origin de quem pediu", async () => {
  const r = await chamar({ acao: "iniciar", coexistencia: true }, FORJADO);
  expect(r.status).toBe(200);
  const [, ctx] = h.iniciar.mock.calls[0] ?? [];
  expect(ctx).toMatchObject({ publicBase: "https://crm.exemplo.com" });
});

it.each([
  ["ausente", undefined],
  ["o placeholder da imagem genérica", "https://placeholder.invalid"],
  ["a própria máquina", "http://localhost:3000"],
  ["a própria máquina por IP", "http://127.0.0.1:3000"],
])("base configurada %s: recusa sem falar com o provedor, mesmo com Origin", async (_r, base) => {
  h.baseConfigurada = base;
  for (const corpo of [
    { acao: "iniciar", coexistencia: true },
    { acao: "concluir", estado: "e".repeat(30), account_id: "b".repeat(24), profile_id: "a".repeat(24) },
  ]) {
    const r = await chamar(corpo, FORJADO);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("base_publica_nao_configurada");
  }
  expect(h.iniciar).not.toHaveBeenCalled();
  expect(h.concluir).not.toHaveBeenCalled();
});

it("a própria máquina vale quando o provedor também está nela (o dublê das provas de tela)", async () => {
  h.baseConfigurada = "http://localhost:3000/";
  h.provedor = "http://127.0.0.1:3996";
  const r = await chamar({ acao: "iniciar", coexistencia: true }, FORJADO);
  expect(r.status).toBe(200);
  const [, ctx] = h.iniciar.mock.calls[0] ?? [];
  expect(ctx).toMatchObject({ publicBase: "http://localhost:3000" });
});

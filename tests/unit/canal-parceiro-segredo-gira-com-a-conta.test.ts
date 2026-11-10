/**
 * Conectar pela chave própria: quando o segredo do webhook é reaproveitado e quando é trocado.
 *
 * Reconectar o MESMO número ativo reaproveita o segredo, para que a assinatura
 * que já entrega continue valendo e nenhum evento se perca. Se a conta mudou,
 * ou se a conexão foi excluída, o segredo tem de ser novo. É o único jeito de
 * aposentar um segredo que ficou com alguém de fora (uma agência que
 * administrava a conta antiga, por exemplo), e é o que a tela promete ao dizer
 * "exclua a conexão e conecte de novo para gerar outro".
 *
 * O handler roda de verdade. Os dublês ficam só na borda (banco, cifra,
 * provedor), e o webhook automático é recusado para que o segredo volte na
 * resposta e possa ser comparado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  existente: null as Record<string, unknown> | null,
  segredoAtual: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: "admin" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async (_db: unknown, v: string) => `cifrado:${v}`),
}));
vi.mock("@/lib/webhooks/url-publica", () => ({ basePublicaDaInstalacao: () => "https://crm.test" }));
vi.mock("@/lib/channels/conexao-um-clique", () => ({ umCliqueDisponivel: async () => false }));
vi.mock("@/lib/channels/connect", () => ({
  PARTNER_CHANNEL_LABEL: "Parceiro",
  partnerEndpoint: () => "https://p.test",
  validatePartnerCredentials: vi.fn(async () => ({
    ok: true,
    phoneNumber: "5511999990000",
    displayName: "Loja",
    qualityRating: null,
  })),
  findPartnerSession: vi.fn(async () => h.existente),
  savePartnerSession: vi.fn(async () => ({ error: null, id: "sessao-1" })),
  segredoAtualDoWebhook: h.segredoAtual,
  // provedor sem permissão de webhook: a resposta devolve o segredo para colar
  registrarWebhookDoNumero: vi.fn(async () => null),
}));

import { POST } from "@/app/api/v1/channels/partner/route";

const CONTA = "a".repeat(24);
const OUTRA = "b".repeat(24);
const SEGREDO_ANTIGO = "segredo-que-ja-esta-colado-no-provedor";

function sessaoPropria(sobre: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sessao-1",
    accountId: CONTA,
    displayName: "Loja",
    webhookPathToken: "tok-atual",
    archivedAt: null,
    pelaInstalacao: false,
    webhookId: null,
    ...sobre,
  };
}

async function conectar(conta: string): Promise<string> {
  const r = await POST(
    new NextRequest("https://crm.test/api/v1/channels/partner", {
      method: "POST",
      body: JSON.stringify({ account_id: conta, api_key: "chave-propria-123" }),
    }),
  );
  expect(r.status).toBe(200);
  const corpo = (await r.json()) as { data: { webhook_secret: string | null } };
  expect(corpo.data.webhook_secret).toBeTruthy();
  return corpo.data.webhook_secret as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.segredoAtual.mockResolvedValue(SEGREDO_ANTIGO);
});

describe("segredo do webhook na reconexão pela chave própria", () => {
  it("o MESMO número ativo reaproveita o segredo: a assinatura que já entrega continua valendo", async () => {
    h.existente = sessaoPropria();
    expect(await conectar(CONTA)).toBe(SEGREDO_ANTIGO);
  });

  it("conta trocada gera segredo NOVO: quem tinha o antigo deixa de assinar eventos válidos", async () => {
    h.existente = sessaoPropria();
    const segredo = await conectar(OUTRA);
    expect(segredo).not.toBe(SEGREDO_ANTIGO);
    expect(h.segredoAtual).not.toHaveBeenCalled();
  });

  it("conexão excluída e conectada de novo gera segredo NOVO, como a tela promete", async () => {
    h.existente = sessaoPropria({ archivedAt: "2026-11-01T00:00:00.000Z" });
    const segredo = await conectar(CONTA);
    expect(segredo).not.toBe(SEGREDO_ANTIGO);
    expect(h.segredoAtual).not.toHaveBeenCalled();
  });
});

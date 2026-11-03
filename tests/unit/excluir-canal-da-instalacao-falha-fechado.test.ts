/**
 * Excluir um número conectado pela instalação, com o provedor fora do ar: a linha fica.
 *
 * Na conexão por um clique, o número está na conta do provedor da INSTALAÇÃO e
 * na fatura dela. Se o provedor falha ao desconectá-lo e a rota arquiva ou
 * apaga a linha assim mesmo, some o único registro de que o número continua
 * lá, e nada volta a desconectá-lo. Por isso a exclusão falha fechada, como no
 * ramo do WAHA: devolve 502 e não mexe na linha, e o operador tenta de novo.
 *
 * A outra metade é o controle: na chave própria o número é da conta da
 * organização, e a exclusão continua best-effort.
 *
 * O handler roda de verdade. Os dublês ficam no banco e no provedor.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({
  sessao: {} as Record<string, unknown>,
  escritas: [] as string[],
  desfazer: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: vi.fn(),
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR", full_name: "Ana", email: "a@x.test" },
    org: { orgId: ORG, role: "admin" },
  })),
}));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false), loadAuthUser: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/health", () => ({ resolverSaudeDaConexaoRemovida: vi.fn(async () => "sem_mudanca") }));
vi.mock("@/lib/channels/central-de-pausa", () => ({ sincronizarAvisoDePausa: vi.fn(async () => undefined) }));
vi.mock("@/lib/channels/connect", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  desfazerNoProvedor: h.desfazer,
}));
// As contagens do impacto: canal virgem, então a saída é o hard delete. A
// escrita pelo service role fica registrada com o prefixo `admin:`.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from() {
      let op = "select";
      const q = {
        select: () => q,
        eq: () => q,
        update: () => ((op = "update"), q),
        delete: () => ((op = "delete"), q),
        then: (ok: (r: unknown) => unknown) => {
          if (op !== "select") h.escritas.push(`admin:${op}`);
          return Promise.resolve({ count: 0, data: null, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      let op = "select";
      const q = {
        select: () => q,
        eq: () => q,
        update: () => ((op = "update"), q),
        delete: () => ((op = "delete"), q),
        maybeSingle: async () => ({ data: h.sessao, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          h.escritas.push(op);
          return Promise.resolve({ data: null, error: null }).then(ok);
        },
      };
      return q;
    },
  }),
}));

import { DELETE } from "@/app/api/v1/channel-sessions/[id]/route";
import { PARTNER_CHANNEL_PROVIDER } from "@/lib/channels/connect";

async function excluir(): Promise<Response> {
  return DELETE(new NextRequest(`https://crm.test/api/v1/channel-sessions/${CANAL}`, { method: "DELETE" }), {
    params: Promise.resolve({ id: CANAL }),
  });
}

function sessao(pelaInstalacao: boolean): Record<string, unknown> {
  return {
    id: CANAL,
    provider: PARTNER_CHANNEL_PROVIDER,
    waha_session_name: null,
    display_name: "Loja",
    phone_number: "+5511999990000",
    meta_phone_number_id: null,
    meta_token_encrypted: null,
    zernio_credencial_da_instalacao: pelaInstalacao,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.escritas = [];
});

describe("exclusão de canal do provedor parceiro com o provedor fora do ar", () => {
  it("conexão pela instalação: 502 e a linha fica, para a nova tentativa", async () => {
    h.sessao = sessao(true);
    h.desfazer.mockRejectedValue(new Error("provedor 503"));
    const r = await excluir();
    expect(r.status).toBe(502);
    expect(h.escritas).toEqual([]);
  });

  it("CONTROLE: com o provedor respondendo, a mesma conexão é excluída — pelo service role, o único que o gatilho da 9093 deixa", async () => {
    h.sessao = sessao(true);
    h.desfazer.mockResolvedValue("desfeito");
    const r = await excluir();
    expect(r.status).toBe(200);
    expect(h.escritas).toEqual(["admin:delete"]);
  });

  it("chave própria: a falha do provedor não segura a exclusão (o número é da conta da organização)", async () => {
    h.sessao = sessao(false);
    h.desfazer.mockRejectedValue(new Error("provedor 503"));
    const r = await excluir();
    expect(r.status).toBe(200);
    expect(h.escritas).toEqual(["delete"]);
  });
});

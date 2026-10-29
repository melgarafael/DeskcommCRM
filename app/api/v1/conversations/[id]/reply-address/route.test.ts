/**
 * GET /api/v1/conversations/[id]/reply-address — para qual número a resposta sai (Spec 31, B4).
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Devolver sempre o principal (ignorar o chat): o caso "@c.us → +digitos" cai.
 * - Não converter `@c.us` em `+<digitos>` (devolver o chat cru): o mesmo caso cai.
 * - Procurar o `@lid` sem olhar o extra (só o principal): o caso "@lid do extra" cai.
 * - Ficha sem extra usando o chat mesmo assim: o caso "via principal" cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { enderecoDaUltimaRecebida } from "@/lib/channels/endereco-da-ultima-recebida";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({
  enderecoDaUltimaRecebida: vi.fn(async () => null),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";

interface Montagem {
  principal?: { phone_number: string; source_metadata?: Record<string, unknown> };
  extras?: Array<{ phone_number: string; wa_lid: string | null }>;
  provider?: string;
  isGroup?: boolean;
  semContato?: boolean;
}

/** Fake de leitura: conversa, ficha e extras, sempre com o filtro de organização registrado. */
function fakeSupabase(m: Montagem) {
  const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
  const respostas: Record<string, unknown> = {
    conversations: {
      id: CONVERSA,
      contact_id: m.semContato ? null : CONTATO,
      is_group: m.isGroup ?? false,
      channel_sessions: { provider: m.provider ?? "waha" },
    },
    contacts: m.principal ?? null,
    contact_phones: m.extras ?? [],
  };
  return {
    filtros,
    cliente: {
      from: (tabela: string) => {
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (coluna: string, valor: unknown) => {
            filtros.push({ tabela, coluna, valor });
            return q;
          },
          limit: () => q,
          maybeSingle: async () => ({ data: respostas[tabela], error: null }),
          then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve({ data: respostas[tabela], error: null }).then(ok, ko),
        };
        return q;
      },
    },
  };
}

function req() {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/reply-address`);
}

const CONTEXTO = { params: Promise.resolve({ id: CONVERSA }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(enderecoDaUltimaRecebida).mockResolvedValue(null);
});

describe("GET /api/v1/conversations/[id]/reply-address", () => {
  it("ficha sem extra → via principal, has_extras false", async () => {
    const { cliente } = fakeSupabase({ principal: { phone_number: "+5511999998888" }, extras: [] });
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    const { GET } = await import("./route");

    const res = await GET(req(), CONTEXTO);
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(corpo.data).toEqual({
      phone_number: "+5511999998888",
      via: "principal",
      has_extras: false,
      provider: "waha",
    });
  });

  it("última recebida @c.us → +digitos, via ultima_recebida", async () => {
    vi.mocked(enderecoDaUltimaRecebida).mockResolvedValue("5515999998888@c.us");
    const { cliente } = fakeSupabase({
      principal: { phone_number: "+5511999998888" },
      extras: [{ phone_number: "+5515999998888", wa_lid: null }],
    });
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    const { GET } = await import("./route");

    const res = await GET(req(), CONTEXTO);
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(corpo.data).toEqual({
      phone_number: "+5515999998888",
      via: "ultima_recebida",
      has_extras: true,
      provider: "waha",
    });
  });

  it("@lid que é do extra → o número do extra", async () => {
    vi.mocked(enderecoDaUltimaRecebida).mockResolvedValue("777666555444@lid");
    const { cliente } = fakeSupabase({
      principal: { phone_number: "+5511999998888", source_metadata: { waha_lid: "111222333444@lid" } },
      extras: [{ phone_number: "+5515988887777", wa_lid: "777666555444" }],
    });
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    const { GET } = await import("./route");

    const res = await GET(req(), CONTEXTO);
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(corpo.data.phone_number).toBe("+5515988887777");
    expect(corpo.data.via).toBe("ultima_recebida");
  });

  it("todas as consultas filtram a organização da sessão", async () => {
    const { cliente, filtros } = fakeSupabase({ principal: { phone_number: "+5511999998888" }, extras: [] });
    vi.mocked(createClient).mockResolvedValue(cliente as never);
    const { GET } = await import("./route");

    await GET(req(), CONTEXTO);

    for (const tabela of ["conversations", "contacts", "contact_phones"]) {
      expect(filtros).toContainEqual({ tabela, coluna: "organization_id", valor: ORG });
    }
  });
});

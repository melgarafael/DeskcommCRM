/**
 * GET /api/v1/contacts/[id] — a ficha devolve os telefones extras (Spec 31, B1).
 *
 * `additional_phones` sai com a forma da API (`tipo→type`, `rotulo→label`,
 * `origem→origin`), ordenado por `created_at`, e SEM `wa_lid`. Ficha sem extra
 * devolve `[]`. As duas leituras novas filtram por organização e por ficha.
 *
 * ─── SABOTAGEM (o que faz este arquivo ficar vermelho) ─────────────────────
 * - Devolver `wa_lid` no `additional_phones` (o `.map` passa a ler `e.wa_lid`):
 *   o caso "sem wa_lid" cai.
 * - Tirar o `.eq("organization_id", …)` da leitura de `contact_phones`: o caso
 *   "filtra por organização" cai.
 * - Trocar `additional_phones` por `[]` fixo: o caso "com extras" cai.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { getContactHandler } from "../_handler";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  orgAtivaDaApi: vi.fn(),
  requireRole: vi.fn(),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("../_handler", () => ({
  getContactHandler: vi.fn(),
  patchContactHandler: vi.fn(),
  deleteContactHandler: vi.fn(),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const CONTATO = "44444444-4444-4444-8444-444444444444";

/** Linhas como o banco as devolve: o fake devolve até o `wa_lid`, de propósito. */
const EXTRAS_DO_BANCO = [
  {
    phone_number: "+5511988887777",
    tipo: "celular",
    whatsapp: "sim",
    rotulo: "Trabalho",
    origem: "fusao",
    wa_lid: "999888777666",
    created_at: "2026-10-02T10:00:00.000Z",
  },
  {
    phone_number: "+551133334444",
    tipo: "fixo",
    whatsapp: "nao_sei",
    rotulo: null,
    origem: "manual",
    wa_lid: "111222333444",
    created_at: "2026-10-01T10:00:00.000Z",
  },
];

const PRINCIPAL_DO_BANCO = { phone_type: "celular", phone_whatsapp: "sim" };

/** Registra cada `eq` por tabela: é o que o caso de organização confere. */
function fakeSupabase(filtros: Array<{ tabela: string; coluna: string; valor: unknown }>, extras: unknown[]) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: (tabela: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => {
          filtros.push({ tabela, coluna, valor });
          return q;
        },
        // Emula o `order by created_at` do banco: a rota confia nele, não reordena.
        order: async () => ({
          data:
            tabela === "contact_phones"
              ? [...extras].sort((a, b) =>
                  String((a as { created_at: string }).created_at).localeCompare(
                    String((b as { created_at: string }).created_at),
                  ),
                )
              : [],
          error: null,
        }),
        maybeSingle: async () => ({
          data: tabela === "contacts" ? PRINCIPAL_DO_BANCO : null,
          error: null,
        }),
      };
      return q;
    },
  };
}

function reqGet() {
  return new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orgAtivaDaApi).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, name: "Org", role: "agent" },
  } as never);
  vi.mocked(getContactHandler).mockResolvedValue({
    id: CONTATO,
    organization_id: ORG,
    name: "Cliente",
    phone_number: "+5511999998888",
  } as never);
});

describe("GET /api/v1/contacts/[id] — telefones extras", () => {
  it("devolve os extras na forma da API, com tipo e WhatsApp do principal", async () => {
    const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(filtros, EXTRAS_DO_BANCO) as never);
    const { GET } = await import("./route");

    const res = await GET(reqGet(), { params: Promise.resolve({ id: CONTATO }) });
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: Record<string, unknown> };

    expect(corpo.data.phone_type).toBe("celular");
    expect(corpo.data.phone_whatsapp).toBe("sim");
    // Ordem por created_at: o extra de 01/10 vem antes do de 02/10, embora o
    // fake os tenha guardado na ordem inversa.
    expect(corpo.data.additional_phones).toEqual([
      {
        phone_number: "+551133334444",
        type: "fixo",
        whatsapp: "nao_sei",
        label: null,
        origin: "manual",
        created_at: "2026-10-01T10:00:00.000Z",
      },
      {
        phone_number: "+5511988887777",
        type: "celular",
        whatsapp: "sim",
        label: "Trabalho",
        origin: "fusao",
        created_at: "2026-10-02T10:00:00.000Z",
      },
    ]);
  });

  it("nunca devolve wa_lid: nem no extra, nem em lugar nenhum da resposta", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase([], EXTRAS_DO_BANCO) as never);
    const { GET } = await import("./route");

    const res = await GET(reqGet(), { params: Promise.resolve({ id: CONTATO }) });
    const texto = await res.text();
    expect(texto).not.toContain("wa_lid");
    expect(texto).not.toContain("999888777666");
  });

  it("ficha sem extra devolve additional_phones []", async () => {
    vi.mocked(createClient).mockResolvedValue(fakeSupabase([], []) as never);
    const { GET } = await import("./route");

    const res = await GET(reqGet(), { params: Promise.resolve({ id: CONTATO }) });
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data.additional_phones).toEqual([]);
  });

  it("filtra por organização e por ficha nas duas leituras", async () => {
    const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
    vi.mocked(createClient).mockResolvedValue(fakeSupabase(filtros, EXTRAS_DO_BANCO) as never);
    const { GET } = await import("./route");

    await GET(reqGet(), { params: Promise.resolve({ id: CONTATO }) });
    for (const tabela of ["contacts", "contact_phones"]) {
      const deTabela = filtros.filter((f) => f.tabela === tabela);
      expect(deTabela).toContainEqual({ tabela, coluna: "organization_id", valor: ORG });
    }
    expect(filtros).toContainEqual({ tabela: "contact_phones", coluna: "contact_id", valor: CONTATO });
  });
});

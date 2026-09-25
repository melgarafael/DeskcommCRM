import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({
  user: true,
  contact: { organization_id: "org-a", is_anonymized: false } as {
    organization_id: string;
    is_anonymized: boolean;
  } | null,
  error: null as unknown,
  candidate: null as unknown,
  filters: [] as unknown[][],
  admin: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user ? { id: "user-a" } : null }, error: null }),
    },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "limit", "is", "not"]) q[name] = () => q;
      q.maybeSingle = async () => ({ data: state.contact, error: null });
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === "contacts" ? state.contact : [], error: null }).then(
          resolve,
        );
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.admin();
    const q: Record<string, unknown> = {};
    for (const name of ["select", "order", "limit"]) q[name] = () => q;
    q.eq = (...args: unknown[]) => {
      state.filters.push(args);
      return q;
    };
    q.maybeSingle = async () => ({ data: state.candidate, error: state.error });
    return { from: () => q };
  },
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));
import { GET } from "@/app/api/v1/contacts/[id]/crm-summary/route";
const prospect = {
  name: "Clínica exemplo",
  category: "Estética",
  address: null,
  website: "https://example.com",
  maps_url: null,
  rating: 4.9,
  reviews: 100,
  emails: [],
  socials: [],
};
const run = () =>
  GET(new NextRequest("https://crm.example/api/v1/contacts/contact-a/crm-summary"), {
    params: Promise.resolve({ id: "contact-a" }),
  });
beforeEach(() => {
  state.user = true;
  state.contact = { organization_id: "org-a", is_anonymized: false };
  state.candidate = {
    data: { ...prospect, secret_raw: "must not leave server" },
    created_at: "2026-09-16T10:00:00Z",
  };
  state.error = null;
  state.filters = [];
  state.admin.mockClear();
});
describe("enriquecimento autorizado no resumo CRM", () => {
  it("filtra contato e organização autorizados e projeta apenas os campos públicos", async () => {
    const r = await run();
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(state.filters).toEqual([
      ["organization_id", "org-a"],
      ["contact_id", "contact-a"],
    ]);
    expect(body.data.enrichment.name).toBe(prospect.name);
    expect(body.data.enrichment.secret_raw).toBeUndefined();
  });
  it("não consulta service role quando RLS nega o contato", async () => {
    state.contact = null;
    expect((await run()).status).toBe(404);
    expect(state.admin).not.toHaveBeenCalled();
  });
  it("requer autenticação", async () => {
    state.user = false;
    expect((await run()).status).toBe(401);
    expect(state.admin).not.toHaveBeenCalled();
  });
  it("não recupera enriquecimento de contato anonimizado", async () => {
    state.contact!.is_anonymized = true;
    const body = await (await run()).json();
    expect(body.data.enrichment).toBeNull();
    expect(state.admin).not.toHaveBeenCalled();
  });
  it("separa ausência de falha sem derrubar as demais seções", async () => {
    state.candidate = null;
    expect((await (await run()).json()).data.enrichment_error).toBe(false);
    state.error = { message: "DB unavailable" };
    const body = await (await run()).json();
    expect(body.data.enrichment_error).toBe(true);
    expect(body.data.leads).toEqual([]);
  });
});

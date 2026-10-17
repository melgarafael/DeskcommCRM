import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  candidate: null as unknown,
  org: null as unknown,
  chamadasPorTabela: {} as Record<string, number>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "limit", "is", "not"]) q[name] = () => q;
      q.maybeSingle = async () =>
        table === "contacts"
          ? { data: { organization_id: "org-a", is_anonymized: false }, error: null }
          : { data: null, error: null };
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return q;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      state.chamadasPorTabela[table] = (state.chamadasPorTabela[table] ?? 0) + 1;
      const q: Record<string, unknown> = {};
      for (const name of ["select", "order", "limit"]) q[name] = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({
        data: table === "organizations" ? state.org : state.candidate,
        error: null,
      });
      return q;
    },
  }),
}));

vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));

import { GET } from "@/app/api/v1/contacts/[id]/crm-summary/route";

const run = () =>
  GET(new NextRequest("https://crm.example/api/v1/contacts/contact-a/crm-summary"), {
    params: Promise.resolve({ id: "contact-a" }),
  });

const SITE = {
  ver: 1,
  classe: "sem-site",
  problemas: [],
  checklist: { tem: [], falta: [] },
  final_url: null,
  http_status: null,
  tempo_ms: 0,
  conteudo_resumo: null,
  pagespeed: null,
  verificado_em: "2026-10-10T12:00:00.000Z",
};

describe("crm-summary devolve personalizacao só com auditoria", () => {
  it("com site: lê settings e devolve a fatia", async () => {
    state.chamadasPorTabela = {};
    state.candidate = {
      data: {
        name: "X", category: null, address: null, website: null, maps_url: null,
        rating: null, reviews: null, emails: [], socials: [], site: SITE,
      },
      created_at: "2026-10-10T12:00:00Z",
    };
    state.org = { settings: { prospeccao: { vocabulario: { clinica: "convênios" } } } };
    const body = await (await run()).json();
    expect(body.data.personalizacao).toEqual({ vocabulario: { clinica: "convênios" } });
    expect(state.chamadasPorTabela["organizations"]).toBe(1);
  });

  it("sem site: não toca em organizations", async () => {
    state.chamadasPorTabela = {};
    state.candidate = {
      data: {
        name: "X", category: null, address: null, website: null, maps_url: null,
        rating: null, reviews: null, emails: [], socials: [],
      },
      created_at: "2026-10-10T12:00:00Z",
    };
    state.org = { settings: { prospeccao: { vocabulario: { clinica: "convênios" } } } };
    const body = await (await run()).json();
    expect(body.data.personalizacao).toBeNull();
    expect(state.chamadasPorTabela["organizations"] ?? 0).toBe(0);
  });
});

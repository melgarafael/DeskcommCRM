/**
 * As duas guardas de `anunciosDoContato` na rota do resumo de CRM.
 *
 * `inbox-enrichment-route.test.ts` EXECUTA esse caminho, mas o dublê dele engole
 * todo filtro (`q[name] = () => q`) e nunca devolve anúncio: tirar a guarda de
 * anonimização ou o `.eq("organization_id")` da leitura de `messages` deixava a
 * suíte inteira verde (medido na triagem do #2808). Um teste de fluxo completo
 * também não pega — a redação de LGPD já zera `source_metadata` e
 * `messages.metadata` —, então a guarda é provada aqui, na unidade da rota: o
 * dublê entrega o anúncio MESMO para contato anonimizado e REGISTRA os filtros.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  contact: null as Record<string, unknown> | null,
  filtros: {} as Record<string, unknown[][]>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }) },
    from: (table: string) => {
      const filtros: unknown[][] = (state.filtros[table] ??= []);
      const q: Record<string, unknown> = {};
      for (const name of ["select", "order", "limit", "is", "not"]) q[name] = () => q;
      q.eq = (...args: unknown[]) => {
        filtros.push(args);
        return q;
      };
      q.maybeSingle = async () => {
        if (table === "contacts") return { data: state.contact, error: null };
        if (table === "messages") {
          return {
            data: {
              anuncio: { titulo: "Botox de verão", texto: "Agende hoje", ad_id: "ad-recente" },
              created_at: "2026-10-10T12:00:00Z",
            },
            error: null,
          };
        }
        return { data: null, error: null };
      };
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve);
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    for (const name of ["select", "eq", "order", "limit"]) q[name] = () => q;
    q.maybeSingle = async () => ({ data: null, error: null });
    return { from: () => q };
  },
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: async () => new Map() }));

import { GET } from "@/app/api/v1/contacts/[id]/crm-summary/route";

const run = async () => {
  const r = await GET(new NextRequest("https://crm.example/api/v1/contacts/contact-a/crm-summary"), {
    params: Promise.resolve({ id: "contact-a" }),
  });
  expect(r.status).toBe(200);
  return (await r.json()).data as { anuncio_de_origem: unknown; anuncio_mais_recente: unknown };
};

const contatoDeAnuncio = (is_anonymized: boolean) => ({
  organization_id: "org-a",
  is_anonymized,
  source_metadata: {
    ad_platform: "meta",
    ad_title: "Limpeza de pele",
    ad_body: "Primeira sessão grátis",
    ad_id: "ad-origem",
  },
});

beforeEach(() => {
  state.filtros = {};
});

describe("anúncios no resumo de CRM", () => {
  it("lê o anúncio mais recente só da organização do contato", async () => {
    state.contact = contatoDeAnuncio(false);
    const data = await run();
    // Controle positivo: sem anonimização os dois anúncios chegam — é o que dá
    // sentido ao caso de baixo devolver null.
    expect(data.anuncio_de_origem).toMatchObject({ ad_id: "ad-origem" });
    expect(data.anuncio_mais_recente).toMatchObject({ ad_id: "ad-recente" });
    expect(state.filtros.messages).toContainEqual(["organization_id", "org-a"]);
    expect(state.filtros.messages).toContainEqual(["contact_id", "contact-a"]);
  });

  it("contato anonimizado não mostra anúncio nenhum, mesmo com o dado ainda lá", async () => {
    state.contact = contatoDeAnuncio(true);
    const data = await run();
    expect(data.anuncio_de_origem).toBeNull();
    expect(data.anuncio_mais_recente).toBeNull();
  });
});

/**
 * O painel do inbox acha o negócio pelo número ADICIONAL do cliente (#3669, fatia 2a).
 *
 * O contato da conversa pode ser uma "pessoa relacionada" de um negócio
 * (`crm_lead_links` target_kind=contact, link_kind=related): o negócio tem o
 * `contact_id` do contato principal, e a leitura por `contact_id` devolvia vazio.
 *
 * A precedência é a da fatia 1 (`lib/leads/active-lead.ts`): o próprio ABERTO
 * vence. Próprio só fechado não vence — senão o cartão "(2º número)" duplicado
 * que alguém fechou depois de juntar esconderia o negócio vivo do cliente.
 *
 * O dublê distingue as duas leituras de `crm_leads` pelo filtro que cada uma
 * usa (`contact_id` = próprio; `.in("id")` = relacionado) e registra os filtros
 * de `crm_lead_links`, para a guarda de organização ser medida, não suposta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Linha = { id: string; status: string; title: string };
type Resultado = { data: unknown; error: { message: string } | null };

const state = vi.hoisted(() => ({
  proprios: [] as unknown[],
  relacionados: [] as unknown[],
  vinculos: { data: [], error: null } as { data: unknown; error: { message: string } | null },
  relacionadosErr: null as { message: string } | null,
  filtrosVinculo: [] as unknown[][],
  leuRelacionados: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }) },
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let porId = false;
      for (const name of ["select", "order", "limit", "is", "not"]) q[name] = () => q;
      q.eq = (...args: unknown[]) => {
        if (table === "crm_lead_links") state.filtrosVinculo.push(args);
        return q;
      };
      q.in = () => {
        porId = true;
        return q;
      };
      q.maybeSingle = async () =>
        table === "contacts"
          ? { data: { organization_id: "org-a", is_anonymized: false }, error: null }
          : { data: null, error: null };
      q.then = (resolve: (v: unknown) => unknown) => {
        let r: Resultado = { data: [], error: null };
        if (table === "crm_lead_links") r = state.vinculos;
        if (table === "crm_leads" && porId) {
          state.leuRelacionados = true;
          r = { data: state.relacionados, error: state.relacionadosErr };
        } else if (table === "crm_leads") r = { data: state.proprios, error: null };
        return Promise.resolve(r).then(resolve);
      };
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

const run = () =>
  GET(new NextRequest("https://crm.example/api/v1/contacts/contato-b/crm-summary"), {
    params: Promise.resolve({ id: "contato-b" }),
  });
const ids = async (res: Response) =>
  ((await res.json()).data.leads as Linha[]).map((l) => l.id);
const lead = (id: string, status: string): Linha => ({ id, status, title: id });

beforeEach(() => {
  state.proprios = [];
  state.relacionados = [lead("negocio-do-cliente", "open")];
  state.vinculos = { data: [{ lead_id: "negocio-do-cliente" }], error: null };
  state.relacionadosErr = null;
  state.filtrosVinculo = [];
  state.leuRelacionados = false;
});

describe("crm-summary — negócio pelo número adicional", () => {
  it("sem negócio próprio: mostra o negócio em que o contato é pessoa relacionada", async () => {
    expect(await ids(await run())).toEqual(["negocio-do-cliente"]);
  });

  it("próprio ABERTO vence: o relacionado nem é lido", async () => {
    state.proprios = [lead("proprio-aberto", "open")];
    expect(await ids(await run())).toEqual(["proprio-aberto"]);
    expect(state.leuRelacionados).toBe(false);
  });

  it("próprio só PERDIDO não vence: o negócio aberto do cliente vem na frente", async () => {
    state.proprios = [lead("segundo-numero-fechado", "lost")];
    expect(await ids(await run())).toEqual(["negocio-do-cliente", "segundo-numero-fechado"]);
  });

  it("a leitura de vínculos filtra pela organização do contato e pelo tipo de vínculo", async () => {
    await run();
    expect(state.filtrosVinculo).toContainEqual(["organization_id", "org-a"]);
    expect(state.filtrosVinculo).toContainEqual(["target_kind", "contact"]);
    expect(state.filtrosVinculo).toContainEqual(["link_kind", "related"]);
    expect(state.filtrosVinculo).toContainEqual(["target_id", "contato-b"]);
  });

  it("falha ao ler os vínculos SOBE como 500, não vira lista vazia", async () => {
    state.vinculos = { data: null, error: { message: "vinculos fora" } };
    const res = await run();
    expect(res.status).toBe(500);
  });

  it("falha ao ler os negócios relacionados SOBE como 500", async () => {
    state.relacionadosErr = { message: "leads fora" };
    const res = await run();
    expect(res.status).toBe(500);
  });
});

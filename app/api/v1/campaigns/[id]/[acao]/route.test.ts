/** Rota e preparação reais; client PostgREST real com transporte em memória. */
import { createClient as criarSupabase } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CAMPANHA = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
type Linha = Record<string, unknown>;

function bancada(falharAoConcluir: boolean) {
  const campanha: Linha = {
    id: CAMPANHA,
    organization_id: ORG,
    name: "Campanha de teste",
    status: "draft",
    channel_session_id: "55555555-5555-4555-8555-555555555555",
    message_mode: "text",
    message_body: "Olá, {{nome}}",
    base_legal: "consent",
    audience_filter: { origens: ["import"], limite: 1 },
    content_version: 1,
    audience_version: 0,
  };
  const tabelas: Record<string, Linha[]> = {
    campaigns: [campanha],
    campaign_recipients: [],
    campaign_suppressions: [],
    contacts: [{
      id: CONTATO,
      organization_id: ORG,
      name: "Ana",
      phone_number: "+5581999990000",
      kind: "person",
      source: "import",
      is_merged_into: null,
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
      created_at: "2026-11-01T12:00:00.000Z",
    }],
  };
  const transporte: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const tabela = url.pathname.split("/").at(-1)!;
    expect(tabelas).toHaveProperty(tabela);
    const metodo = init?.method ?? "GET";
    const corpo = init?.body ? JSON.parse(String(init.body)) as Linha | Linha[] : null;
    const selecionadas = tabelas[tabela]!.filter((l) => [...url.searchParams].every(([coluna, filtro]) => {
      if (filtro.startsWith("eq.")) return String(l[coluna]) === filtro.slice(3);
      if (filtro.startsWith("neq.")) return String(l[coluna]) !== filtro.slice(4);
      if (filtro === "is.null") return l[coluna] == null;
      if (filtro === "not.is.null") return l[coluna] != null;
      if (filtro.startsWith("in.(")) return filtro.slice(4, -1).split(",").includes(String(l[coluna]));
      return true;
    }));
    if (metodo === "PATCH") {
      if (tabela === "campaigns" && (corpo as Linha).status === "ready" && falharAoConcluir) {
        falharAoConcluir = false;
        return Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 });
      }
      selecionadas.forEach((l) => Object.assign(l, corpo));
    } else if (metodo === "DELETE") {
      tabelas[tabela] = tabelas[tabela]!.filter((l) => !selecionadas.includes(l));
    } else if (metodo === "POST") {
      tabelas[tabela]!.push(...(Array.isArray(corpo) ? corpo : [corpo!]).map((l) => ({ ...l })));
    } else {
      expect(["GET", "HEAD"]).toContain(metodo);
    }
    if (metodo === "HEAD") return new Response(null, { headers: { "Content-Range": `*/${selecionadas.length}` } });
    if (metodo === "POST" || metodo === "DELETE" || (metodo === "PATCH" && !url.searchParams.has("select"))) {
      return new Response(null, { status: 204 });
    }
    return Response.json(selecionadas);
  };
  const client = criarSupabase("http://postgrest.invalid", "chave-sintetica", {
    global: { fetch: transporte },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  vi.mocked(createAdminClient).mockReturnValue(client as never);
  return { campanha, tabelas };
}

async function preparar() {
  return POST(new NextRequest(`http://localhost/api/v1/campaigns/${CAMPANHA}/preparar`, { method: "POST" }), {
    params: Promise.resolve({ id: CAMPANHA, acao: "preparar" }),
  });
}

describe("confirmação do preparo da campanha", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "11111111-1111-4111-8111-111111111111", idioma: "pt-BR" },
      org: { orgId: ORG, name: "Org", role: "manager" },
    } as never);
  });

  it("não confirma nem audita sucesso quando o banco recusa concluir; permite preparar de novo", async () => {
    const { campanha, tabelas } = bancada(true);
    const resposta = await preparar();
    expect(resposta.status).toBe(500);
    expect(await resposta.json()).toMatchObject({ error: { code: "internal_error" } });
    expect(campanha.status).toBe("draft");
    expect(tabelas.campaign_recipients).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();

    const tentativa = await preparar();
    expect(tentativa.status).toBe(200);
    expect(campanha).toMatchObject({ status: "ready", audience_version: 1, snapshot_eligible: 1 });
    expect(tabelas.campaign_recipients).toHaveLength(1);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "campaign.prepared" }));
  });

  it("continua confirmando e auditando o snapshot que foi gravado e ficou pronto", async () => {
    const { campanha, tabelas } = bancada(false);
    const resposta = await preparar();
    expect(resposta.status).toBe(200);
    expect(campanha).toMatchObject({ status: "ready", audience_version: 1, snapshot_total: 1, snapshot_eligible: 1 });
    expect(tabelas.campaign_recipients).toEqual([expect.objectContaining({
      contact_id: CONTATO, campaign_id: CAMPANHA, status: "pending", eligibility_status: "eligible",
    })]);
    expect(audit).toHaveBeenCalledOnce();
  });
});

// @vitest-environment node
//
// O LEAD DE FORMULÁRIO ENTRA NO FUNIL MESMO NUMA ETAPA EXIGENTE (#2295) ──────
//
// A régua de campos obrigatórios passou a valer na criação (#1710). O webhook
// de captação é a exceção escolhida: o lead que vem de fora não fica fora do
// funil porque a etapa padrão da fonte exige um campo que o formulário não
// mandou. Ele passa `exigirCamposDaEtapa: false` ao `createLeadHandler`.
//
// Aqui a rota de verdade chama o handler de verdade (só o Supabase é de
// mentira), numa etapa que exige `concorrente`, com um formulário que não traz
// esse campo. Sabotagem: tirar a opção da rota deixa este caso vermelho — o
// handler recusa com 422 e a captação vira `recusado`.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const h = vi.hoisted(() => ({
  registrar: vi.fn(async () => undefined),
  leadsInseridos: [] as Record<string, unknown>[],
}));

const FONTE = {
  id: "fonte-1",
  name: "Formulário do site",
  organization_id: ORG,
  secret_encrypted: null,
  default_pipeline_id: FUNIL,
  default_stage_id: ETAPA,
  field_map: {},
  redirect_to: null,
  is_active: true,
};

/** Cadeia do PostgREST da ROTA: só a fonte é lida de verdade; o resto resolve vazio. */
function cadeia(tabela: string): unknown {
  const resultado = { data: tabela === "webhook_sources" ? FONTE : null, error: null };
  const proxy: unknown = new Proxy(() => undefined, {
    get(_alvo, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok(resultado);
      return () => proxy;
    },
  });
  return proxy;
}

/** Supabase do HANDLER: a etapa, o funil que EXIGE `concorrente` nela, e o insert do lead. */
function supabaseDoHandler(): unknown {
  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const mesmo = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = mesmo;
    q.insert = (linha: Record<string, unknown>) => {
      if (tabela === "crm_leads") h.leadsInseridos.push(linha);
      return q;
    };
    q.maybeSingle = async () => {
      if (tabela === "crm_stages") return { data: { id: ETAPA, pipeline_id: FUNIL, organization_id: ORG }, error: null };
      if (tabela === "crm_pipelines") {
        return {
          data: {
            settings: {
              fields: [{ key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [ETAPA] } }],
            },
          },
          error: null,
        };
      }
      if (tabela === "organizations") return { data: { currency: "BRL" }, error: null };
      return { data: null, error: null };
    };
    q.single = async () => ({ data: { ...h.leadsInseridos.at(-1), id: "lead-novo" }, error: null });
    q.then = (ok: (v: unknown) => void) => ok({ data: null, error: null });
    return q;
  };
  return { from };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => cadeia(t), rpc: async () => ({ data: null, error: null }) }),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ kickLocalPipeline: async () => undefined }));
vi.mock("@/lib/webhooks/captacao", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  registrarCaptacao: h.registrar,
}));
// O handler REAL, com o Supabase do handler no lugar do cliente que a rota passa.
vi.mock("@/app/api/v1/leads/_handler", async (original) => {
  const real = await original<{ createLeadHandler: (...a: unknown[]) => unknown }>();
  return {
    ...real,
    createLeadHandler: (_sb: unknown, ...resto: unknown[]) => real.createLeadHandler(supabaseDoHandler(), ...resto),
  };
});

import { POST } from "@/app/api/v1/webhooks/in/[token]/route";

beforeEach(() => {
  h.registrar.mockClear();
  h.leadsInseridos.length = 0;
});

describe("webhook de captação numa etapa que exige campo", () => {
  it("o formulário sem o campo cria o negócio como antes", async () => {
    const req = new NextRequest("http://localhost/api/v1/webhooks/in/token-da-fonte-0001", {
      method: "POST",
      body: JSON.stringify({ nome: "Dora", email: "dora@example.com" }),
      headers: { "content-type": "application/json" },
    });

    const res = await POST(req, { params: Promise.resolve({ token: "token-da-fonte-0001" }) });

    expect(h.registrar).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "recusado" }),
    );
    expect(res.status).toBe(200);
    expect(h.leadsInseridos, "o negócio não nasceu").toHaveLength(1);
    expect(h.leadsInseridos[0]).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA });
  });
});

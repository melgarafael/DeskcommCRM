// @vitest-environment node
//
// CRIAR DIRETO NUMA ETAPA DE PERDA SEM MOTIVO RESPONDE 422, NÃO 500 (#2743) ──
//
// ─── O defeito, medido na vps-teste pela prova do #2713 ──────────────────────
//
// `POST /api/v1/leads` com `stage_id` de uma etapa de perda ("Perdido") e sem
// motivo devolvia HTTP 500 `{"code":"internal_error","message":"lost_reason_required"}`:
// o trigger `fn_validate_lost_reason_required` (supabase/baseline.sql) levanta
// `22023`, e o INSERT em `createLeadHandler` convertia QUALQUER erro do banco
// em `ApiError(500, "internal_error")`. O 500 vai para o Sentry como erro
// interno e não diz a quem opera o que fazer — o mesmo caso, no arrasto e no
// `/lose`, já era 422 `lost_reason_required`.
//
// ─── O que estes casos provam ────────────────────────────────────────────────
//
// 1. o INSERT recusado pelo trigger (`22023` `lost_reason_required`) chega como
//    422 `lost_reason_required` com a MESMA frase traduzida que o `/lose`
//    devolve — e NUNCA como 500;
// 2. a CHECK `crm_leads_lost_reason_required` (`23514`) — a outra recusa da
//    mesma classe — vira o MESMO 422;
// 3. controle negativo: um erro do banco que NÃO é desta classe continua 500
//    `internal_error` (a conversão é da classe certa, não de tudo);
// 4. controle positivo: sem erro no INSERT, a criação passa como antes.
//
// Sabotagem esperada: sem a conversão em `createLeadHandler`, os casos 1 e 2
// ficam vermelhos (recebem `status: 500, code: "internal_error"`).

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: async () => "humano" }));

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { recusaDeMotivoDaPerda } from "@/lib/leads/motivo-da-perda";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA_PERDA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LEAD_NOVO = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const ctx = {
  organization_id: ORG,
  actor: { type: "user" as const, id: "user-1" },
  requestId: "req-1",
  idioma: "pt-BR" as const,
};

const payload = {
  pipeline_id: FUNIL,
  stage_id: ETAPA_PERDA,
  title: "Negócio criado na etapa de perda",
  tags: [],
  source: "manual",
};

/** A recusa do Postgres, como ela chega pelo supabase-js. */
type RecusaDoBanco = { code: string; message: string };

/**
 * Supabase de mentira só com o que a CRIAÇÃO pergunta, e que GRAVA o erro do
 * INSERT — é o INSERT que o trigger `fn_validate_lost_reason_required`
 * recusa, e nenhum caminho antes dele sabe que a etapa é de perda.
 */
function supabaseQueRecusaNoInsert(recusa: RecusaDoBanco | null) {
  const inseridos: Record<string, unknown>[] = [];

  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const cadeia = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = cadeia;
    q.insert = (linha: Record<string, unknown>) => {
      inseridos.push(linha);
      return q;
    };
    q.maybeSingle = async () => {
      if (tabela === "crm_stages") {
        return {
          data: { id: ETAPA_PERDA, pipeline_id: FUNIL, organization_id: ORG, is_lost: true },
          error: null,
        };
      }
      if (tabela === "crm_pipelines") return { data: { settings: null }, error: null };
      if (tabela === "organizations") return { data: { currency: "BRL" }, error: null };
      // A leitura do MAX(position_in_stage): sem linhas, sem erro.
      return { data: null, error: null };
    };
    q.single = async () =>
      recusa
        ? { data: null, error: recusa }
        : { data: { ...inseridos.at(-1), id: LEAD_NOVO }, error: null };
    q.then = (ok: (v: { data: null; error: null }) => void) => ok({ data: null, error: null });
    return q;
  };

  return { cliente: { from } as never, inseridos };
}

/** O mesmo texto que a rota `/leads/{id}/lose` devolve para esta recusa. */
const MENSAGEM_TRADUZIDA = recusaDeMotivoDaPerda("pt-BR").mensagem;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createLeadHandler — nascer numa etapa de perda sem motivo (#2743)", () => {
  it("o trigger `22023` chega como 422 lost_reason_required com a mensagem traduzida", async () => {
    const { cliente, inseridos } = supabaseQueRecusaNoInsert({
      code: "22023",
      message: "lost_reason_required",
    });

    const erro = await createLeadHandler(cliente, ctx, payload).catch((e: unknown) => e);

    expect(erro).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "lost_reason_required",
    });
    // A MESMA frase de `/lose` e do arrasto — em pt-BR, não o texto cru do banco.
    expect((erro as Error).message).toBe(MENSAGEM_TRADUZIDA);
    // A prova do #2743: a conversão é PARA 422, e não "não-500 qualquer".
    expect((erro as { status: number }).status).not.toBe(500);
    // A recusa vem do banco: o INSERT foi tentado e foi o Postgres que barrou.
    expect(inseridos).toHaveLength(1);
  });

  it("a CHECK `crm_leads_lost_reason_required` (`23514`) chega como o MESMO 422", async () => {
    const { cliente } = supabaseQueRecusaNoInsert({
      code: "23514",
      message:
        'new row for relation "crm_leads" violates check constraint "crm_leads_lost_reason_required"',
    });

    const erro = await createLeadHandler(cliente, ctx, payload).catch((e: unknown) => e);

    expect(erro).toMatchObject({
      name: "ApiError",
      status: 422,
      code: "lost_reason_required",
    });
    expect((erro as Error).message).toBe(MENSAGEM_TRADUZIDA);
  });

  it("um erro do banco que NÃO é desta classe continua 500 internal_error", async () => {
    const { cliente } = supabaseQueRecusaNoInsert({
      code: "57014",
      message: "canceling statement due to statement timeout",
    });

    const erro = await createLeadHandler(cliente, ctx, payload).catch((e: unknown) => e);

    expect(erro).toMatchObject({
      name: "ApiError",
      status: 500,
      code: "internal_error",
    });
  });

  it("sem recusa no INSERT, a criação passa como antes", async () => {
    const { cliente, inseridos } = supabaseQueRecusaNoInsert(null);

    const lead = await createLeadHandler(cliente, ctx, payload);

    expect(lead).toMatchObject({ id: LEAD_NOVO });
    expect(inseridos).toHaveLength(1);
  });
});

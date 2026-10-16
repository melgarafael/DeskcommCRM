/**
 * A MESMA RÉGUA NO SERVIDOR (#2730) — o cliente não é garantia.
 *
 * A issue pede a validação em TRÊS pontos; este arquivo mede o ponto 2, a API:
 * `POST/PATCH /api/v1/contacts` e `POST/PATCH /api/v1/leads` recusam o valor
 * fora do `padrao` do campo com 422, a frase de erro sendo a DO CAMPO
 * (`mensagem_padrao`) — nunca "valor inválido" — e nada é gravado.
 *
 * O que também está medido aqui:
 *
 *  - campo SEM `padrao` segue aceitando qualquer coisa (o de hoje, byte a
 *    byte) — é o que impede a régua nova de virar regressão silenciosa;
 *  - regex inválida configurada fecha com mensagem legível (422
 *    `custom_field_pattern_invalid`), não 500 e não "aceita tudo";
 *  - o espanhol do `Idioma` do contexto chega na resposta, pela MESMA chave do
 *    dicionário que a tela usa.
 *
 * O Supabase é de mentira; os handlers são os de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
  hashEmail: (e: string) => e,
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async () => ({ data: null, error: null })),
  })),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

import { createContactHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { createLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import {
  MENSAGEM_DE_FORA_DO_PADRAO,
  MENSAGEM_DE_PADRAO_INVALIDO,
} from "@/lib/leads/padrao-do-campo";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ETAPA = "55555555-5555-4555-8555-555555555555";
const USUARIO = "11111111-1111-4111-8111-111111111111";

/** O campo do exemplo da issue. */
const CAMPO_IDADES = {
  key: "idades",
  label: "Idades das crianças",
  type: "text",
  padrao: "^\\d{1,2}(,\\d{1,2})*$",
  mensagem_padrao: "Use só números separados por vírgula, ex.: 2,9",
};

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-1",
  idioma: "pt-BR",
};

/** `custom_fields` sem nenhuma definição de padrão — o campo livre de sempre. */
const CAMPO_LIVRE = { key: "idades", label: "Idades das crianças", type: "text" };

// ── O banco falso dos CONTATOS ───────────────────────────────────────────────

function bancoDeContatos(fields: unknown[]) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const existente = {
    id: CONTATO,
    organization_id: ORG,
    is_anonymized: false,
    tags: [] as string[],
    email: null,
    phone_number: null,
    name: "Ana",
    display_name: null,
    consent: {},
    custom_fields: {} as Record<string, unknown>,
  };

  const from = (tabela: string) => {
    let escrita: Record<string, unknown> | null = null;
    const c: Record<string, unknown> = {};
    const mesmo = () => c;
    c.select = mesmo;
    c.order = mesmo;
    c.limit = mesmo;
    c.eq = mesmo;
    c.in = mesmo;
    c.is = mesmo;
    c.insert = (linha: Record<string, unknown>) => {
      escrita = linha;
      inserts.push(linha);
      return c;
    };
    c.update = (linha: Record<string, unknown>) => {
      escrita = linha;
      updates.push(linha);
      return c;
    };
    const linha = () => (tabela === "contacts" ? { ...existente, ...(escrita ?? {}) } : null);
    c.single = async () => ({
      data: tabela === "contacts" ? { ...linha(), id: "ct-novo" } : null,
      error: null,
    });
    c.maybeSingle = async () => ({ data: linha(), error: null });
    c.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
      Promise.resolve({
        data: tabela === "crm_pipelines" ? [{ settings: { fields } }] : [],
        error: null,
      }).then(ok, ruim);
    return c;
  };

  return {
    cliente: { from, rpc: async () => ({ data: null, error: null }) } as unknown as never,
    inserts,
    updates,
  };
}

// ── O banco falso dos LEADS ──────────────────────────────────────────────────

function bancoDeLeads(fields: unknown[]) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const gravado: Record<string, unknown> = {
    id: "lead-1",
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: ETAPA,
    title: "Aluguel",
    tags: [],
    custom_fields: {},
    updated_at: "2026-09-15T12:00:00.000Z",
    contact_id: null,
  };

  const from = (tabela: string) => {
    let escrita: Record<string, unknown> | null = null;
    const q: Record<string, unknown> = {};
    const mesmo = () => q;
    for (const nome of ["select", "eq", "neq", "is", "order", "limit"]) q[nome] = mesmo;
    q.insert = (linha: Record<string, unknown>) => {
      escrita = linha;
      inserts.push(linha);
      return q;
    };
    q.update = (linha: Record<string, unknown>) => {
      escrita = linha;
      updates.push(linha);
      return q;
    };
    const linha = () => {
      if (tabela !== "crm_leads") return null;
      if (tabela === "crm_leads" && !escrita) return { ...gravado };
      return { ...gravado, ...(escrita ?? {}) };
    };
    q.maybeSingle = async () => {
      if (tabela === "crm_stages")
        return { data: { id: ETAPA, pipeline_id: FUNIL, organization_id: ORG }, error: null };
      if (tabela === "crm_pipelines") return { data: { settings: { fields } }, error: null };
      if (tabela === "organizations")
        return { data: { currency: "BRL", settings: { currency: "BRL" } }, error: null };
      return { data: linha(), error: null };
    };
    q.single = async () => ({
      data:
        tabela === "crm_leads"
          ? {
              ...(escrita ?? {}),
              id: "lead-1",
              pipeline_id: FUNIL,
              stage_id: ETAPA,
              title: "Aluguel",
            }
          : null,
      error: null,
    });
    q.then = (ok: (v: unknown) => unknown, ruim?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(ok, ruim);
    return q;
  };

  return {
    cliente: {
      from,
      rpc: async () => ({ data: null, error: null }),
    } as unknown as never,
    inserts,
    updates,
  };
}

async function recusa(promise: Promise<unknown>): Promise<ApiError> {
  const erro = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro, "a escrita deveria ter sido recusada").toBeInstanceOf(ApiError);
  return erro as ApiError;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/contacts — o valor fora do padrão não nasce", () => {
  it("recusa com 422, a frase DO CAMPO, e não grava nada", async () => {
    const { cliente, inserts } = bancoDeContatos([CAMPO_IDADES]);

    const erro = await recusa(
      createContactHandler(cliente, ctx, {
        name: "Ana",
        source: "manual",
        custom_fields: { idades: "dois" },
      }),
    );

    expect(erro.status).toBe(422);
    expect(erro.code).toBe("custom_field_pattern_mismatch");
    expect(erro.message).toBe("Use só números separados por vírgula, ex.: 2,9");
    expect(erro.details).toEqual({ recusas: [{ campo: "idades", motivo: "fora_do_padrao" }] });
    expect(inserts, "nada foi gravado torto").toHaveLength(0);
  });

  it("o valor que casa passa e chega ao banco intacto", async () => {
    const { cliente, inserts } = bancoDeContatos([CAMPO_IDADES]);

    await createContactHandler(cliente, ctx, {
      name: "Ana",
      source: "manual",
      custom_fields: { idades: "2,9" },
    });

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ custom_fields: { idades: "2,9" } });
  });

  it("sem `padrao` no campo, o valor livre segue gravando — o de sempre", async () => {
    const { cliente, inserts } = bancoDeContatos([CAMPO_LIVRE]);

    await createContactHandler(cliente, ctx, {
      name: "Ana",
      source: "manual",
      custom_fields: { idades: "dois e meio, com espaço" },
    });

    expect(inserts).toHaveLength(1);
  });

  it("regex inválida configurada fecha com 422 legível — não 500", async () => {
    const { cliente, inserts } = bancoDeContatos([{ ...CAMPO_IDADES, padrao: "^\\d{1,2(" }]);

    const erro = await recusa(
      createContactHandler(cliente, ctx, {
        name: "Ana",
        source: "manual",
        custom_fields: { idades: "2,9" },
      }),
    );

    expect(erro.status).toBe(422);
    expect(erro.code).toBe("custom_field_pattern_invalid");
    expect(erro.message).toBe(MENSAGEM_DE_PADRAO_INVALIDO);
    expect(inserts).toHaveLength(0);
  });

  it("sem `mensagem_padrao`, a genérica sai JÁ TRADUZIDA pelo idioma do contexto", async () => {
    const { cliente } = bancoDeContatos([
      { key: "idades", label: "Idades", type: "text", padrao: "^\\d+$" },
    ]);

    const erro = await recusa(
      createContactHandler(
        cliente,
        { ...ctx, idioma: "es" },
        {
          name: "Ana",
          source: "manual",
          custom_fields: { idades: "abc" },
        },
      ),
    );

    expect(DICIONARIO[MENSAGEM_DE_FORA_DO_PADRAO]?.es).toBeTruthy();
    expect(erro.message).toBe(DICIONARIO[MENSAGEM_DE_FORA_DO_PADRAO]?.es);
  });
});

describe("PATCH /api/v1/contacts/{id} — a mesma régua na edição", () => {
  it("recusa o valor fora do padrão e o contato não é atualizado", async () => {
    const { cliente, updates } = bancoDeContatos([CAMPO_IDADES]);

    const erro = await recusa(
      patchContactHandler(cliente, ctx, CONTATO, { custom_fields: { idades: "123" } }),
    );

    expect(erro.status).toBe(422);
    expect(erro.message).toBe("Use só números separados por vírgula, ex.: 2,9");
    expect(updates, "nada foi atualizado").toHaveLength(0);
  });

  it("o valor que casa atualiza, e campos SEM padrão seguem livres", async () => {
    const { cliente, updates } = bancoDeContatos([CAMPO_IDADES, CAMPO_LIVRE]);

    await patchContactHandler(cliente, ctx, CONTATO, {
      custom_fields: { idades: "2,9", observacao: "escrevi o que quis" },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      custom_fields: { idades: "2,9", observacao: "escrevi o que quis" },
    });
  });
});

describe("POST /api/v1/leads — a criação pergunta o mesmo", () => {
  it("recusa o valor fora do padrão ANTES de nascer o negócio", async () => {
    const { cliente, inserts } = bancoDeLeads([CAMPO_IDADES]);

    const erro = await recusa(
      createLeadHandler(
        cliente,
        { organization_id: ORG, actor: ctx.actor, requestId: "req-1", idioma: "pt-BR" },
        {
          pipeline_id: FUNIL,
          stage_id: ETAPA,
          title: "Aluguel",
          tags: [],
          source: "manual",
          custom_fields: { idades: "dois" },
        },
      ),
    );

    expect(erro.status).toBe(422);
    expect(erro.code).toBe("custom_field_pattern_mismatch");
    expect(erro.message).toBe("Use só números separados por vírgula, ex.: 2,9");
    expect(inserts).toHaveLength(0);
  });

  it("o valor que casa cria o negócio como antes", async () => {
    const { cliente, inserts } = bancoDeLeads([CAMPO_IDADES]);

    await createLeadHandler(
      cliente,
      { organization_id: ORG, actor: ctx.actor, requestId: "req-1", idioma: "pt-BR" },
      {
        pipeline_id: FUNIL,
        stage_id: ETAPA,
        title: "Aluguel",
        tags: [],
        source: "manual",
        custom_fields: { idades: "2,9" },
      },
    );

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ custom_fields: { idades: "2,9" } });
  });
});

describe("PATCH /api/v1/leads/{id} — a edição também", () => {
  it("recusa o valor fora do padrão e não mexe nos campos", async () => {
    const { cliente, updates } = bancoDeLeads([CAMPO_IDADES]);

    const erro = await recusa(
      updateLeadHandler(cliente, ctx, "lead-1", { custom_fields: { idades: "abc" } }),
    );

    expect(erro.status).toBe(422);
    expect(erro.message).toBe("Use só números separados por vírgula, ex.: 2,9");
    expect(updates).toHaveLength(0);
  });

  it("sem `padrao`, a edição segue gravando o que a pessoa digitou", async () => {
    const { cliente, updates } = bancoDeLeads([CAMPO_LIVRE]);

    await updateLeadHandler(cliente, ctx, "lead-1", {
      custom_fields: { idades: "livre mesmo" },
    });

    expect(updates).toHaveLength(1);
  });
});

/**
 * A RETOMADA (issue #1538) NÃO DUPLICA E NÃO FURA A RÉGUA DE CAMPOS (#1536).
 *
 *  - Retomar duas vezes a mesma origem devolve a retomada ABERTA que já existe,
 *    sem criar um segundo negócio (a tool MCP não tem trava de duplo clique).
 *  - A retomada entra numa etapa: se a etapa exige um campo que o negócio novo
 *    não terá, é 422 `required_fields_missing` — e nada é criado.
 */
import { describe, expect, it } from "vitest";

import { retomarLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";

const ORG = "11111111-1111-4111-8111-111111111111";
const FUNIL = "44444444-4444-4444-8444-444444444444";
const ORIGEM = "33333333-3333-4333-8333-333333333333";
const ETAPA = "66666666-6666-4666-8666-666666666666";
const JA_RETOMADO = "77777777-7777-4777-8777-777777777777";

function bancoFalso(opcoes: { settings?: Record<string, unknown>; retomadaAberta?: boolean }) {
  const inserts: unknown[] = [];
  const from = (tabela: string) => {
    const filtros: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      eq: (col: string, v: unknown) => {
        filtros[col] = v;
        return chain;
      },
      insert: (linha: unknown) => {
        inserts.push(linha);
        throw new Error("insert não esperado neste teste");
      },
      maybeSingle: async () => {
        if (tabela === "crm_leads" && filtros.retomado_de_lead_id) {
          return {
            data: opcoes.retomadaAberta ? { id: JA_RETOMADO, retomado_de_lead_id: ORIGEM } : null,
            error: null,
          };
        }
        if (tabela === "crm_leads") {
          return {
            data: {
              id: ORIGEM,
              organization_id: ORG,
              pipeline_id: FUNIL,
              status: "lost",
              title: "Consulta",
              custom_fields: {},
              tags: [],
            },
            error: null,
          };
        }
        if (tabela === "crm_pipelines") return { data: { settings: opcoes.settings ?? {} }, error: null };
        throw new Error(`maybeSingle inesperado: ${tabela}`);
      },
      then: (resolve: (r: unknown) => unknown) => {
        if (tabela === "crm_stages") {
          return resolve({
            data: [{ id: ETAPA, pipeline_id: FUNIL, is_won: false, is_lost: false, is_archived: false }],
            error: null,
          });
        }
        throw new Error(`lista inesperada: ${tabela}`);
      },
    };
    return chain;
  };
  return { supabase: { from } as never, inserts };
}

const ctx = { organization_id: ORG, actor: { type: "user" as const, id: "u1" }, requestId: "r1" };

describe("retomarLeadHandler", () => {
  it("segunda retomada da mesma origem devolve a que já está aberta, sem criar outra", async () => {
    const { supabase, inserts } = bancoFalso({ retomadaAberta: true });
    const lead = await retomarLeadHandler(supabase, ctx, ORIGEM);
    expect(lead.id).toBe(JA_RETOMADO);
    expect(inserts).toEqual([]);
  });

  it("etapa que exige campo que o negócio novo não terá: 422 com faltando, nada criado", async () => {
    const { supabase, inserts } = bancoFalso({
      settings: {
        fields: [
          { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [ETAPA] } },
        ],
      },
    });
    const erro = await retomarLeadHandler(supabase, ctx, ORIGEM).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(422);
    expect((erro as ApiError).code).toBe("required_fields_missing");
    expect((erro as ApiError).details).toMatchObject({ faltando: [{ chave: "concorrente" }] });
    expect(inserts).toEqual([]);
  });
});

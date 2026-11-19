import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { McpContext } from "../types";

/**
 * `crm_list_pipelines` — OS CAMPOS DO FUNIL CHEGAM AO MODELO (issue #4667).
 *
 * O defeito que este arquivo vigia não dá erro: o agente recebia os funis SEM
 * as chaves dos campos (`settings.fields`, `customFieldSchema` em
 * `lib/schemas/settings.ts`), inventava uma em `custom_fields` e a escrita
 * passava — o schema aceita chave livre — deixando o valor órfão no card. Quem
 * lê a resposta é o MODELO: se a chave não está aqui, ele não tem como
 * adivinhar `valor_do_contrato` em vez de `valor`.
 *
 * Por isso o teste NÃO olha o `settings` do banco: ele cobra a RESPOSTA da
 * ferramenta, que é o contrato com o modelo — e a sabotagem que tira a lista do
 * retorno tem de deixar o primeiro caso vermelho.
 *
 * O handler de listagem é dublê de propósito: o que se mede aqui é a tradução
 * do `settings` para o que o modelo lê, não a query do PostgREST (que tem
 * filtro de organização próprio, no handler).
 */
vi.mock("@/app/api/v1/pipelines/_handler", () => ({ listPipelinesHandler: vi.fn() }));

const { listPipelinesHandler } = await import("@/app/api/v1/pipelines/_handler");
type PipelineRow = Awaited<ReturnType<typeof listPipelinesHandler>>["pipelines"][number];
const { crmListPipelines } = await import("./pipelines");

const ORG = "22222222-2222-4222-8222-222222222222";

const ctx: McpContext = {
  organizationId: ORG,
  role: "agent",
  actor: { type: "ai_agent", id: "run-1", role: "ai_operator", agent_id: "agent-1" },
  apiTokenId: "33333333-3333-4333-8333-333333333333",
  requestId: "44444444-4444-4444-8444-444444444444",
  // Nada aqui toca banco: a listagem está mockada. O dublê existe para
  // satisfazer o contrato do `McpContext`, não para ser usado.
  supabase: {} as unknown as SupabaseClient,
};

/** Um funil como o handler devolve — só os campos que a ferramenta lê. */
function funil(settings: Record<string, unknown> | null, over: Partial<PipelineRow> = {}): PipelineRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: ORG,
    name: "Vendas",
    slug: "vendas",
    description: null,
    is_default: true,
    is_archived: false,
    position: 0,
    vocabulary: { lead: "Lead", deal: "Negócio", won: "Ganho", lost: "Perdido" },
    settings,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    ...over,
  };
}

interface Resposta {
  pipelines: Array<{
    id: string;
    name: string;
    campos: Array<{
      key: string;
      label: string;
      type: string;
      escopo: string;
      options?: Array<{ value: string; label: string }>;
    }>;
  }>;
}

function respondeCom(pipelines: PipelineRow[]) {
  vi.mocked(listPipelinesHandler).mockResolvedValue({ pipelines });
}

async function lista(): Promise<Resposta> {
  return (await crmListPipelines.handler({ include_archived: false }, ctx)) as Resposta;
}

beforeEach(() => vi.clearAllMocks());

describe("crm_list_pipelines — campos do funil", () => {
  it("traz chave, rótulo, tipo e escopo de cada campo do funil", async () => {
    respondeCom([
      funil({
        fields: [
          { key: "valor_do_contrato", label: "Valor do contrato", type: "currency", required: true },
          { key: "prescritor", label: "Prescritor", type: "text", escopo: "contato" },
          // Lixo no jsonb: `camposDoFunil` descarta o que não passa no
          // `customFieldSchema`, e a lista do modelo não pode oferecer chave
          // que o próprio funil não reconhece.
          { label: "Sem chave", type: "text" },
        ],
      }),
    ]);

    const { campos } = (await lista()).pipelines[0]!;

    expect(campos).toEqual([
      { key: "valor_do_contrato", label: "Valor do contrato", type: "currency", escopo: "negocio" },
      { key: "prescritor", label: "Prescritor", type: "text", escopo: "contato" },
    ]);
  });

  it("funil sem campo devolve lista VAZIA, nunca undefined", async () => {
    // `undefined` some do JSON: o modelo leria "esta ferramenta não fala de
    // campos" em vez de "este funil não declara campo nenhum". As três formas
    // de vazio que existem no banco caem na mesma resposta.
    const { pipelines } = await (async () => {
      respondeCom([funil(null), funil({ fields: [] }), funil({}), funil({ fields: "velho" })]);
      return lista();
    })();

    for (const p of pipelines) {
      expect(p.campos).toEqual([]);
    }
  });

  it("campo de lista traz os valores aceitos em options[].value", async () => {
    respondeCom([
      funil({
        fields: [
          {
            key: "forma_farmaceutica",
            label: "Forma farmacêutica",
            type: "select",
            options: [
              { value: "capsula", label: "Cápsula" },
              { value: "creme", label: "Creme" },
            ],
          },
          { key: "observacoes", label: "Observações", type: "textarea" },
        ],
      }),
    ]);

    const { campos } = (await lista()).pipelines[0]!;

    expect(campos[0]!.options).toEqual([
      { value: "capsula", label: "Cápsula" },
      { value: "creme", label: "Creme" },
    ]);
    // Sem opções, a chave fica de fora — `options: []` em todo campo de texto
    // seria ruído pago em token a cada chamada.
    expect(campos[1]).not.toHaveProperty("options");
  });

  it("a descrição diz que a lista traz os campos (é o que o modelo lê antes de chamar)", () => {
    expect(crmListPipelines.description).toContain("campos");
    expect(crmListPipelines.description).toMatch(/options/);
  });
});

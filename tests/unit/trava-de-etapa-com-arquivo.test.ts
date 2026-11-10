/**
 * A TRAVA DE ETAPA DO CAMPO DE ARQUIVO (#2829, fatia 2).
 *
 * ─── O que esta fatia promete ──────────────────────────────────────────────
 *
 * A fatia 1 desenhou o campo `file` no card e passou a contar os anexos por
 * negócio. Aqui a contagem vira REGRA: entrar numa etapa que exige documento
 * sem ter documento é recusa — e a recusa nomeia o campo, senão a pessoa não
 * sabe o que anexar.
 *
 * O lugar da régua é `lib/leads/campos-exigidos.ts` (a MESMA função dos outros
 * cinco caminhos de escrita, #1536) e a fonte da verdade do que está anexado é
 * `camposComAnexo()`, que lê `crm_lead_attachments` — nunca `custom_fields`
 * (issue #3229). Um `custom_fields` forjado com a chave do campo não pode
 * satisfazer a exigência: só a linha de anexo satisfaz. É o caso 3 abaixo.
 *
 * ─── Os controles valem tanto quanto o caso feliz ──────────────────────────
 *
 * Uma trava que barra demais é pior que a ausência dela: o card fica preso na
 * própria coluna e não há o que fazer na tela. Por isso o arquivo só barra
 * onde o funil declarou `obrigatorio_em` (casos 4 e 6), a régua de TEXTO não
 * foi afrouxada (caso 5) e a CRIAÇÃO continua sem cobrar o documento (#3433,
 * caso 7) — o anexo é do negócio, que na criação ainda não existe.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { retomarLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(),
  stageChangeReason: () => "movido",
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const PIPELINE_ID = "44444444-4444-4444-8444-444444444444";
const STAGE_A = "55555555-5555-4555-8555-555555555555";
const STAGE_B = "66666666-6666-4666-8666-666666666666";

const CARREGADO = "2026-09-15T12:00:00.000Z";
const DEPOIS_DO_MOVE = "2026-09-15T12:00:01.000Z";

/** O campo de arquivo do funil de teste — o "voucher" da operação de turismo. */
const VOUCHER = {
  key: "voucher",
  label: "Voucher da emissão",
  type: "file" as const,
  obrigatorio_em: { etapas: [STAGE_B] },
};

/** Quantas leituras de `crm_lead_attachments` a régua fez (custo da pergunta). */
interface BancoFalso {
  stageId: string;
  ultimoPatch: Record<string, unknown> | null;
  leiturasDeAnexo: number;
}

/**
 * Banco falso do caminho do arrasto: funil (`settings`), etapa de destino,
 * lead e — o que esta fatia acrescenta — a tabela de ANEXOS.
 *
 * A tabela de anexos é respondida pela corrente (é assim que o client do
 * Supabase se comporta: `select().eq().eq()` é aguardável) e devolve o que o
 * cenário declarou. Qualquer outra tabela é erro: um caminho novo que passe a
 * consultar algo aqui precisa aparecer.
 */
function bancoFalso(
  settings: unknown = null,
  opcoes: {
    /** Linhas de `crm_lead_attachments` do negócio — só `field_key` importa. */
    anexos?: readonly { field_key: string }[];
    stageExtra?: Record<string, unknown>;
  } = {},
): { from: (tabela: string) => unknown; rpc: () => Promise<{ error: null }>; banco: BancoFalso } {
  const anexos = opcoes.anexos ?? [];
  const banco: BancoFalso = { stageId: STAGE_A, ultimoPatch: null, leiturasDeAnexo: 0 };
  vi.mocked(emitLeadActivity).mockImplementation(async () => ({ ok: true }) as never);

  const lead = () => ({
    id: LEAD_ID,
    organization_id: ORG_ID,
    pipeline_id: PIPELINE_ID,
    stage_id: banco.stageId,
    contact_id: null,
    status: "open",
    updated_at: CARREGADO,
    custom_fields: {} as Record<string, unknown>,
    won_reason: null,
  });

  const from = (tabela: string): unknown => {
    if (tabela === "crm_pipelines") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { settings }, error: null }),
      };
      return chain;
    }
    if (tabela === "crm_lead_attachments") {
      banco.leiturasDeAnexo += 1;
      const chain = {
        select: () => chain,
        eq: () => chain,
        then: (resolve: (resposta: unknown) => unknown) =>
          resolve({ data: anexos.map((linha) => ({ ...linha })), error: null }),
      };
      return chain;
    }
    if (tabela === "crm_stages") {
      const chain = {
        select: () => chain,
        eq: (_coluna: string, id: string) => {
          (chain as { id?: string }).id = id;
          return chain;
        },
        maybeSingle: async () => ({
          data: {
            id: (chain as { id?: string }).id,
            pipeline_id: PIPELINE_ID,
            name: "Etapa",
            is_won: false,
            is_lost: false,
            ...opcoes.stageExtra,
          },
          error: null,
        }),
      };
      return chain;
    }
    if (tabela === "crm_leads") {
      return {
        select: () => {
          const leitura = { eq: () => leitura, maybeSingle: async () => ({ data: lead(), error: null }) };
          return leitura;
        },
        update: (valores: { stage_id: string } & Record<string, unknown>) => {
          const escrita = {
            eq: () => escrita,
            select: () => escrita,
            maybeSingle: async () => {
              banco.stageId = valores.stage_id;
              banco.ultimoPatch = valores;
              return { data: { id: LEAD_ID }, error: null };
            },
          };
          return escrita;
        },
      };
    }
    throw new Error(`tabela inesperada: ${tabela}`);
  };

  return { from, rpc: () => Promise.resolve({ error: null }), banco };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/move`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const MOVE = { stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO };

type CorpoDeRecusa = {
  error?: {
    code?: string;
    message?: string;
    details?: { faltando?: { chave: string; rotulo: string; tipo?: string }[] };
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(bancoFalso() as never);
});

describe("POST /api/v1/leads/[id]/move — a etapa que exige arquivo", () => {
  it("sem anexo no campo exigido: 422 nomeia o campo e NADA é gravado", async () => {
    const falso = bancoFalso({ fields: [VOUCHER] });
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const response = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(422);
    const corpo = (await response.json()) as CorpoDeRecusa;
    expect(corpo.error?.code).toBe("required_fields_missing");
    // O `details.faltando` NOMEIA o campo: é o que a tela vira em formulário e
    // o que a IA devolve ao modelo para pedir o documento ao cliente.
    expect(corpo.error?.details?.faltando).toEqual([
      { chave: "voucher", rotulo: "Voucher da emissão", tipo: "file" },
    ]);
    // A frase também nomeia — o toast não pode dizer só "deu erro".
    expect(corpo.error?.message).toContain("Voucher da emissão");
    // A prova de que a recusa veio ANTES de qualquer escrita.
    expect(falso.banco.leiturasDeAnexo).toBe(1);
    expect(falso.banco.stageId).toBe(STAGE_A);
    expect(falso.banco.ultimoPatch).toBeNull();
  });

  it("com o arquivo anexado no campo: passa e a etapa muda", async () => {
    const falso = bancoFalso({ fields: [VOUCHER] }, { anexos: [{ field_key: "voucher" }] });
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const response = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(200);
    expect(falso.banco.stageId).toBe(STAGE_B);
    expect(falso.banco.ultimoPatch).toMatchObject({ stage_id: STAGE_B });
  });

  it("anexo em OUTRO campo não satisfaz: a chave do arquivo é a do campo exigido", async () => {
    // O negócio tem documento, só não é o que esta etapa pede. Contar "quantos
    // anexos o card tem" em vez de "quais campos têm anexo" liberaria o move
    // sem o voucher — e o funil é por CAMPO (é o recorte da fatia 1).
    const falso = bancoFalso(
      { fields: [VOUCHER] },
      { anexos: [{ field_key: "comprovante" }, { field_key: "contrato" }] },
    );
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const response = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(422);
    const corpo = (await response.json()) as CorpoDeRecusa;
    expect(corpo.error?.details?.faltando?.map((campo) => campo.chave)).toEqual(["voucher"]);
  });

  it("`custom_fields` com a chave do arquivo não substitui o anexo", async () => {
    // A lista de `custom_fields` seria uma SEGUNDA fonte do que está anexado, e
    // um corpo forjado passaria a régua sem arquivo nenhum no Storage.
    const falso = bancoFalso({ fields: [VOUCHER] });
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const response = await POST(
      request({ ...MOVE, custom_fields: { voucher: "ok.pdf" } }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(422);
    expect(falso.banco.ultimoPatch).toBeNull();
  });

  it("campo de arquivo que a etapa de destino NÃO exige não bloqueia (controle)", async () => {
    // `obrigatorio_em` aponta para OUTRA etapa: no caminho A → B o documento é
    // opcional, e um funil que só quer o arquivo na emissão não pode travar a
    // entrada em Cotação.
    const falso = bancoFalso({
      fields: [{ ...VOUCHER, obrigatorio_em: { etapas: [STAGE_A] } }],
    });
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const response = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(200);
    expect(falso.banco.stageId).toBe(STAGE_B);
  });

  it("campo de TEXTO exigido continua bloqueando, mesmo com o arquivo no lugar (controle)", async () => {
    // O arquivo anexado não pode mascarar a régua de texto — e a lista de
    // faltando precisa sair do campo de TEXTO, não do de arquivo.
    const falso = bancoFalso(
      {
        fields: [
          VOUCHER,
          {
            key: "concorrente",
            label: "Concorrente",
            type: "text",
            obrigatorio_em: { etapas: [STAGE_B] },
          },
        ],
      },
      { anexos: [{ field_key: "voucher" }] },
    );
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const response = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });

    expect(response.status).toBe(422);
    const corpo = (await response.json()) as CorpoDeRecusa;
    expect(corpo.error?.details?.faltando).toEqual([
      { chave: "concorrente", rotulo: "Concorrente", tipo: "text" },
    ]);
  });

  it("etapa de GANHO que exige o arquivo segue a mesma régua: sem anexo 422, com anexo 200", async () => {
    // O desfecho `won` é um dos gatilhos de `obrigatorio_em` — e o arrasto para
    // a coluna Ganho passa pela MESMA pergunta que o botão de ganhar.
    const ganhoExigeArquivo = {
      fields: [{ key: "voucher", label: "Voucher da emissão", type: "file", obrigatorio_em: { ao_ganhar: true } }],
    };
    const { POST } = await import("@/app/api/v1/leads/[id]/move/route");

    const semAnexo = bancoFalso(ganhoExigeArquivo, { stageExtra: { is_won: true } });
    vi.mocked(createClient).mockResolvedValue(semAnexo as never);
    const recusado = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });
    expect(recusado.status).toBe(422);
    expect(((await recusado.json()) as CorpoDeRecusa).error?.details?.faltando?.[0]?.chave).toBe(
      "voucher",
    );
    expect(semAnexo.banco.ultimoPatch).toBeNull();

    const comAnexo = bancoFalso(ganhoExigeArquivo, {
      stageExtra: { is_won: true },
      anexos: [{ field_key: "voucher" }],
    });
    vi.mocked(createClient).mockResolvedValue(comAnexo as never);
    const aceito = await POST(request(MOVE), { params: Promise.resolve({ id: LEAD_ID }) });
    expect(aceito.status).toBe(200);
    expect(comAnexo.banco.stageId).toBe(STAGE_B);
  });
});

/**
 * A CRIAÇÃO NÃO COBRA O ARQUIVO (#3433) — e a fatia 2 não pode quebrar isso.
 *
 * A retomada CRIA o negócio: o anexo mora em `crm_lead_attachments.lead_id` e
 * só pode ser enviado depois que ele existe. Uma pré-checagem mais dura que o
 * escritor (`createLeadHandler`, que passa `semAnexosAinda`) responderia 422
 * para sempre — a etapa exigente viraria inalcançável por esse caminho, que é
 * exatamente a impossibilidade que a #3433 fechou.
 */
describe("a retomada entra na etapa que exige arquivo (criação, #3433)", () => {
  const ORIGEM = "77777777-7777-4777-8777-777777777777";
  const ETAPA = "88888888-8888-4888-8888-888888888888";
  /**
   * Sentinela de FRONTEIRA: o banco falso responde só até a régua de campos.
   * Chegar aqui significa que a régua aprovou a retomada e o fluxo entrou na
   * criação (`createLeadHandler`) — o que este arquivo prova é que a recusa não
   * é mais a do campo de arquivo. A criação em si tem teste próprio.
   */
  const CHEGOU_NA_CRIACAO = "chegou-na-criacao";

  function bancoDaRetomada(settings: unknown) {
    const from = (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (coluna: string, valor: unknown) => {
          filtros[coluna] = valor;
          return chain;
        },
        insert: () => {
          throw new Error(CHEGOU_NA_CRIACAO);
        },
        maybeSingle: async () => {
          if (tabela === "crm_leads" && filtros.retomado_de_lead_id) return { data: null, error: null };
          if (tabela === "crm_leads") {
            return {
              data: {
                id: ORIGEM,
                organization_id: ORG_ID,
                pipeline_id: PIPELINE_ID,
                status: "lost",
                title: "Consulta",
                custom_fields: {},
                tags: [],
              },
              error: null,
            };
          }
          if (tabela === "crm_pipelines") return { data: { settings }, error: null };
          // Qualquer outra leitura pontual é o `createLeadHandler` já em curso.
          throw new Error(CHEGOU_NA_CRIACAO);
        },
        then: (resolve: (resposta: unknown) => unknown) => {
          if (tabela === "crm_stages") {
            return resolve({
              data: [
                { id: ETAPA, pipeline_id: PIPELINE_ID, is_won: false, is_lost: false, is_archived: false },
              ],
              error: null,
            });
          }
          throw new Error(`lista inesperada: ${tabela}`);
        },
      };
      return chain;
    };
    return { from } as never;
  }

  const ctx = {
    organization_id: ORG_ID,
    actor: { type: "user" as const, id: USER_ID },
    requestId: "r-2829-f2",
  };

  it("o arquivo exigido NÃO recusa a retomada; ela chega ao caminho de criação", async () => {
    const supabase = bancoDaRetomada({
      fields: [{ ...VOUCHER, obrigatorio_em: { etapas: [ETAPA] } }],
    });

    const erro = await retomarLeadHandler(supabase, ctx, ORIGEM).catch((e: unknown) => e);

    // Não é a recusa de campos: a régua deixou passar o `file` (a criação não o
    // cobra) e o fluxo seguiu para a escrita.
    expect(erro).not.toBeInstanceOf(ApiError);
    expect((erro as Error).message).toBe(CHEGOU_NA_CRIACAO);
  });

  it("o campo de TEXTO exigido continua recusando a retomada (controle)", async () => {
    // A mesma pré-checagem, com um campo que a criação PODE receber no corpo:
    // a régua não foi afrouxada, só o arquivo saiu dela.
    const supabase = bancoDaRetomada({
      fields: [
        { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [ETAPA] } },
      ],
    });

    const erro = await retomarLeadHandler(supabase, ctx, ORIGEM).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).toBe("required_fields_missing");
    expect((erro as ApiError).details).toMatchObject({ faltando: [{ chave: "concorrente" }] });
  });
});

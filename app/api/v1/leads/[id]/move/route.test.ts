import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
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
/** O `updated_at` depois do UPDATE do move. */
const DEPOIS_DO_MOVE = "2026-09-15T12:00:01.000Z";
/** O `updated_at` depois que a atividade, pelo gatilho de `last_activity_at`, escreve no lead de novo. */
const DEPOIS_DA_ATIVIDADE = "2026-09-15T12:00:01.500Z";

/**
 * Banco falso com a cascata real: gravar a atividade (`crm_lead_activities`)
 * dispara `trg_update_last_activity_at`, que escreve em `crm_leads` e troca o
 * `updated_at` de novo. Quem relê o lead antes da atividade devolve um valor
 * que já não vale — e o próximo arrastar do mesmo card cai na OCC (issue #916).
 */
function bancoFalso(
  settingsDoFunil: unknown = null,
  stageExtra: Record<string, unknown> = {},
  /** `status` do lead (issue #1538); o padrão é aberto. */
  statusDoLead = "open",
) {
  const banco = { updatedAt: CARREGADO, stageId: STAGE_A, ultimoPatch: null as Record<string, unknown> | null };
  vi.mocked(emitLeadActivity).mockImplementation(async () => {
    banco.updatedAt = DEPOIS_DA_ATIVIDADE;
    return { ok: true } as never;
  });

  const lead = () => ({
    id: LEAD_ID,
    organization_id: ORG_ID,
    pipeline_id: PIPELINE_ID,
    stage_id: banco.stageId,
    contact_id: null,
    status: statusDoLead,
    updated_at: banco.updatedAt,
    custom_fields: {} as Record<string, unknown>,
    won_reason: null,
  });

  const from = (tabela: string) => {
    if (tabela === "crm_pipelines") {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { settings: settingsDoFunil }, error: null }),
      };
      return chain;
    }
    if (tabela === "crm_stages") {
      const chain = {
        select: () => chain,
        eq: (_col: string, id: string) => {
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
            ...stageExtra,
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
              banco.updatedAt = DEPOIS_DO_MOVE;
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

  return { from, rpc: vi.fn(() => Promise.resolve({ error: null })), banco };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue(bancoFalso() as never);
});

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/move`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/leads/[id]/move", () => {
  it("devolve o updated_at FINAL, depois da atividade que o próprio move grava", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(200);
    const corpo = (await response.json()) as { data: { updated_at: string; stage_id: string } };
    expect(corpo.data.stage_id).toBe(STAGE_B);
    expect(corpo.data.updated_at).toBe(DEPOIS_DA_ATIVIDADE);
  });

  // ── CAMPOS OBRIGATÓRIOS (issue #1536) ──────────────────────────────────────
  //
  // O caminho 1 dos SEIS da issue (arrasto no quadro). A promessa testada: a
  // recusa é 422 com `details.faltando` ANTES de qualquer escrita, e o reenvio
  // com `custom_fields` passa na MESMA régua e grava etapa + campos num
  // UPDATE só — a janela entre dois writes é o defeito da #917.
  const CAMPOS_EXIGIDOS = {
    fields: [
      {
        key: "concorrente",
        label: "Concorrente",
        type: "text",
        obrigatorio_em: { etapas: [STAGE_B] },
      },
    ],
  };

  it("etapa que exige campo sem valor: 422 com faltando, e NADA é gravado", async () => {
    vi.mocked(createClient).mockResolvedValue(bancoFalso(CAMPOS_EXIGIDOS) as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(422);
    const corpo = (await response.json()) as {
      error?: { code?: string; details?: { faltando?: { chave: string; rotulo: string }[] } };
    };
    expect(corpo.error?.code).toBe("required_fields_missing");
    expect(corpo.error?.details?.faltando).toEqual([
      { chave: "concorrente", rotulo: "Concorrente", tipo: "text" },
    ]);
    // A prova de que a recusa veio ANTES do update: a etapa não mudou.
    const falso = bancoFalso(CAMPOS_EXIGIDOS);
    vi.mocked(createClient).mockResolvedValue(falso as never);
    await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );
    expect(falso.banco.stageId).toBe(STAGE_A);
    expect(falso.banco.ultimoPatch).toBeNull();
  });

  it("reenvio com os campos coletados: passa e grava etapa + custom_fields no MESMO update", async () => {
    const falso = bancoFalso(CAMPOS_EXIGIDOS);
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({
        stage_id: STAGE_B,
        position_in_stage: 1500,
        expected_updated_at: CARREGADO,
        custom_fields: { concorrente: "ACME" },
      }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(200);
    // UM update, com as duas coisas: a etapa nova e o campo preenchido.
    expect(falso.banco.stageId).toBe(STAGE_B);
    expect(falso.banco.ultimoPatch).toMatchObject({
      stage_id: STAGE_B,
      custom_fields: { concorrente: "ACME" },
    });
  });

  it("funil sem obrigatorio_em segue exatamente como hoje (controle do critério 3)", async () => {
    // O campo tem `required: true` (o asterisco antigo) e NENHUMA regra de
    // quando exigir: o move continua passando com o campo vazio.
    const soAsterisco = {
      fields: [{ key: "concorrente", label: "Concorrente", type: "text", required: true }],
    };
    vi.mocked(createClient).mockResolvedValue(bancoFalso(soAsterisco) as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );
    expect(response.status).toBe(200);
  });

  // ── A MESMA ETAPA PASSA (CR do mantenedor) ──────────────────────────────────
  //
  // O card já está NA coluna exigente: arrastar dentro dela é REORDENAÇÃO, não
  // entrada. Sem a comparação destino × `lead.stage_id`, a régua respondia 422
  // e o card ficava preso na própria coluna — ninguém conseguia mudar a posição
  // de um card num funil que exige campo. Os dois casos abaixo partem do lead em
  // STAGE_A e mandam STAGE_A de volta; um deles com a exigência declarada na
  // etapa, o outro com `won_reason_required`, que é o que prendia TODO card
  // antigo da coluna Ganho (`won_reason` nasce `null`).
  it("mesma etapa passa: reordenar dentro da coluna que exige campo não cai na régua", async () => {
    const exigenteNaOrigem = {
      fields: [
        {
          key: "concorrente",
          label: "Concorrente",
          type: "text",
          obrigatorio_em: { etapas: [STAGE_A] },
        },
      ],
    };
    const falso = bancoFalso(exigenteNaOrigem);
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_A, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(200);
    // A escrita aconteceu (a posição muda) — o card não foi devolvido.
    expect(falso.banco.ultimoPatch).toMatchObject({ stage_id: STAGE_A });
  });

  it("mesma etapa na coluna Ganho: `won_reason_required` não trava a reordenação", async () => {
    // O card antigo da coluna tem `won_reason` nulo — exigir o motivo DELE ao
    // reordenar tornaria o ganho impossível de reordenar para sempre.
    const falso = bancoFalso({ won_reason_required: true }, { is_won: true });
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_A, position_in_stage: 2500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(200);
    // E a reordenação NÃO escreve motivo nenhum: não houve fechamento novo.
    expect(falso.banco.ultimoPatch?.won_reason).toBeUndefined();
  });

  it("mudança de etapa de verdade continua barrada pela régua (o atalho não vira buraco)", async () => {
    // Aqui a exigência é na etapa de DESTINO — é ela que o card está entrando.
    const exigenteNoDestino = {
      fields: [
        {
          key: "concorrente",
          label: "Concorrente",
          type: "text",
          obrigatorio_em: { etapas: [STAGE_B] },
        },
      ],
    };
    vi.mocked(createClient).mockResolvedValue(bancoFalso(exigenteNoDestino) as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );
    expect(response.status).toBe(422);
  });
});

// ── A RETOMADA COMO NOVO NEGÓCIO (issue #1538) ────────────────────────────────
//
// O arrasto é o caminho QUATRO dos quatro (os outros três passam pelo
// `moveLeadHandler`, que faz a mesma pergunta com a MESMA função). Aqui se mede
// que a recusa existe, que ela devolve o código combinado com a tela e — o que
// separa regra de enfeite — que o MESMO cenário num funil `mesmo_registro`
// continua reabrindo como sempre.
describe("POST /move num funil que retoma como novo negócio", () => {
  it("encerrado → etapa aberta devolve 409 reabertura_cria_novo e NÃO mexe no card", async () => {
    const falso = bancoFalso({ reabertura: "novo_negocio" }, {}, "lost");
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(409);
    const corpo = (await response.json()) as { error: { code: string; details?: Record<string, unknown> } };
    expect(corpo.error.code).toBe("reabertura_cria_novo");
    // A porta que resolve viaja no details, como no 422 do clone.
    expect(corpo.error.details?.use).toBe("/api/v1/leads/{id}/retomar");
    // Nenhuma escrita: o card segue na etapa em que estava.
    expect(falso.banco.stageId).toBe(STAGE_A);
  });

  it("etapa exigente não abre o diálogo de campos antes do 409: a recusa de reabertura vem primeiro", async () => {
    const funil = {
      reabertura: "novo_negocio",
      fields: [
        { key: "concorrente", label: "Concorrente", type: "text", obrigatorio_em: { etapas: [STAGE_B] } },
      ],
    };
    vi.mocked(createClient).mockResolvedValue(bancoFalso(funil, {}, "lost") as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(409);
    const corpo = (await response.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("reabertura_cria_novo");
  });

  it("mesmo cenário num funil mesmo_registro reabre, como antes da issue", async () => {
    const falso = bancoFalso(null, {}, "lost");
    vi.mocked(createClient).mockResolvedValue(falso as never);
    const { POST } = await import("./route");

    const response = await POST(
      request({ stage_id: STAGE_B, position_in_stage: 1500, expected_updated_at: CARREGADO }),
      { params: Promise.resolve({ id: LEAD_ID }) },
    );

    expect(response.status).toBe(200);
    expect(falso.banco.stageId).toBe(STAGE_B);
  });
});

// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/impersonate/support")>(),
  requireSupportWrite: vi.fn(async () => null),
  authenticatedSessionId: vi.fn(async () => "f2200000-0000-4000-8000-000000000099"),
}));

/**
 * #3643 — o clone nasce na ETAPA que quem leva o negócio escolheu.
 *
 * O diálogo "Levar para outro funil" passou a ter seletor de etapa, que manda
 * `stage_id` no corpo do `POST /api/v1/leads/[id]/clone` (a rota já o aceitava;
 * o que faltava era quem o enviasse e um teste da rota). Quem prova que
 * a escolha CHEGA ao negócio criado é este arquivo, e ele roda a ROTA de
 * verdade (auth, Supabase e os dois efeitos de escrita dublados):
 *
 *  1. `stage_id` informado é a etapa do clone — e o `createLeadHandler` recebe
 *     esse id, que é quem grava (`montaPayloadDoClone`);
 *  2. sem `stage_id` nada muda: a primeira etapa ABERTA do destino recebe o
 *     negócio (a de menor `position`; ganho/perda ficam de fora) — é o default
 *     que a issue manda preservar;
 *  3. `stage_id` de OUTRO funil é recusado no SERVIDOR com 422
 *     `stage_pipeline_mismatch`, e nenhuma escrita acontece — o filtro do
 *     cliente não é a garantia, só a conveniência;
 *  4. etapa de fechamento é recusada com 422 `stage_destino_terminal` — a mesma
 *     régua, do lado de quem decide.
 *
 * Sabotagem: a remoção do `stage_id` do corpo é medida no diálogo
 * (`MoveToOtherPipelineDialog.test.tsx`); aqui ela derruba o caso 1, porque a
 * rota recebe o corpo sem a chave e cai no default.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { encerraDemanda } from "@/lib/leads/encerramento";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));
// As duas ESCRITAS da troca, dubladas: o alvo aqui é a escolha da etapa, e o
// que se afirma é o PAYLOAD que a criação recebe (o clone "nasce" nele).
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: vi.fn() }));

import { POST } from "@/app/api/v1/leads/[id]/clone/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_NOVO = "44444444-4444-4444-8444-444444444444";
const FUNIL_ORIGEM = "55555555-5555-4555-8555-555555555555";
const FUNIL_DESTINO = "66666666-6666-4666-8666-666666666666";
/** Etapa de GANHO do destino, com `position` menor que as abertas de propósito. */
const ETAPA_GANHO = "77777777-7777-4777-8777-777777777777";
/** As duas etapas abertas do destino; a de menor `position` é o DEFAULT. */
const ETAPA_PRIMEIRA = "88888888-8888-4888-8888-888888888888";
const ETAPA_SEGUNDA = "99999999-9999-4999-8999-999999999999";
/** Existe, está aberta — mas em OUTRO funil. */
const ETAPA_DE_OUTRO_FUNIL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ETAPA_DE_PERDA_DA_ORIGEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const ETAPAS_DO_DESTINO = [
  {
    id: ETAPA_GANHO,
    pipeline_id: FUNIL_DESTINO,
    position: 500,
    is_won: true,
    is_lost: false,
    is_archived: false,
  },
  {
    id: ETAPA_PRIMEIRA,
    pipeline_id: FUNIL_DESTINO,
    position: 1000,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
  {
    id: ETAPA_SEGUNDA,
    pipeline_id: FUNIL_DESTINO,
    position: 2000,
    is_won: false,
    is_lost: false,
    is_archived: false,
  },
];

/** A linha da origem como o banco a devolve (`select("*")`). */
function origem() {
  return {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: FUNIL_ORIGEM,
    stage_id: ETAPA_DE_PERDA_DA_ORIGEM,
    status: "open",
    title: "Negócio na prospecção",
    description: null,
    contact_id: null,
    value_cents: 150000,
    currency: "BRL",
    owner_user_id: USER,
    owner_agent_id: null,
    expected_close_date: null,
    tags: [],
    source: "manual",
    custom_fields: {},
    source_metadata: {},
    lost_reason: null,
    closed_at: null,
  };
}

interface Escrita {
  tabela: string;
  metodo: string;
  linha: Record<string, unknown>;
}

/**
 * Supabase de mentira, encadeável, respondendo por TABELA + COLUNAS.
 *
 * As duas leituras de `crm_leads` se distinguem pela ORDEM (a primeira é a
 * origem; a segunda é o `update(...).select("*")` que grava `movido_para`), e
 * as de `crm_pipelines` pelo conjunto de colunas (`id, name` = destino;
 * `settings, name` = origem; `settings` = a régua de campos exigidos do
 * destino). Toda escrita é registrada em `escritas` — é a asserção de
 * "nada foi gravado" nas recusas.
 */
function clienteFake(): { cliente: never; escritas: Escrita[] } {
  const escritas: Escrita[] = [];
  const chamadas: Record<string, number> = {};

  const resposta = (tabela: string, colunas: string): { data: unknown; error: null } => {
    const chave = `${tabela}:${colunas}`;
    chamadas[chave] = (chamadas[chave] ?? 0) + 1;

    if (tabela === "crm_leads" && colunas === "*") {
      return { data: origem(), error: null };
    }
    if (tabela === "crm_pipelines" && colunas === "id, name") {
      return { data: { id: FUNIL_DESTINO, name: "Vendas" }, error: null };
    }
    if (tabela === "crm_pipelines" && colunas === "settings, name") {
      return { data: { settings: {}, name: "Prospecção" }, error: null };
    }
    if (tabela === "crm_pipelines" && colunas === "settings") {
      return { data: { settings: {} }, error: null };
    }
    if (tabela === "crm_stages" && colunas.startsWith("id, pipeline_id")) {
      return { data: ETAPAS_DO_DESTINO, error: null };
    }
    if (tabela === "crm_stages" && colunas === "id") {
      return { data: { id: ETAPA_DE_PERDA_DA_ORIGEM }, error: null };
    }
    return { data: null, error: null };
  };

  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    let colunas = "";
    const cadeia = () => q;
    for (const nome of ["eq", "neq", "is", "in", "order", "limit"]) q[nome] = cadeia;
    q.select = (cols: string) => {
      colunas = String(cols ?? "");
      return q;
    };
    q.update = (linha: Record<string, unknown>) => {
      escritas.push({ tabela, metodo: "update", linha });
      return q;
    };
    q.insert = (linha: Record<string, unknown>) => {
      escritas.push({ tabela, metodo: "insert", linha });
      return q;
    };
    q.maybeSingle = async () => resposta(tabela, colunas);
    q.single = async () => resposta(tabela, colunas);
    // Cobre o `await` direto de uma query de LISTA (as etapas do destino).
    q.then = (ok: (v: { data: unknown; error: null }) => void) => ok(resposta(tabela, colunas));
    return q;
  };

  return { cliente: { from } as never, escritas };
}

function pedido(corpo: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD}/clone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const ctx = { params: Promise.resolve({ id: LEAD }) };

/** O payload que a criação recebeu — é o que define a etapa do clone. */
function payloadDaCriacao(atendido = 1): Record<string, unknown> {
  const chamada = vi.mocked(createLeadHandler).mock.calls[atendido - 1];
  expect(chamada).toBeTruthy();
  return chamada![2] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  const { cliente } = clienteFake();
  vi.mocked(createClient).mockResolvedValue(cliente);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  } as never);
  vi.mocked(createLeadHandler).mockImplementation((async (
    _supabase: unknown,
    _ctx: unknown,
    payload: Record<string, unknown>,
  ) => ({
    id: LEAD_NOVO,
    pipeline_id: payload.pipeline_id,
    stage_id: payload.stage_id,
  })) as never);
  vi.mocked(encerraDemanda).mockResolvedValue({ lead: { id: LEAD, status: "lost" } } as never);
});

describe("POST /clone com etapa de destino (#3643)", () => {
  it("etapa ESCOLHIDA: o clone nasce nela, e a resposta é 201", async () => {
    const res = await POST(pedido({ pipeline_id: FUNIL_DESTINO, stage_id: ETAPA_SEGUNDA }), ctx);

    expect(res.status).toBe(201);
    expect(payloadDaCriacao()).toMatchObject({
      pipeline_id: FUNIL_DESTINO,
      stage_id: ETAPA_SEGUNDA,
    });
  });

  it("SEM etapa: mantém o comportamento de sempre — primeira etapa ABERTA (menor position)", async () => {
    const res = await POST(pedido({ pipeline_id: FUNIL_DESTINO }), ctx);

    expect(res.status).toBe(201);
    // `ETAPA_GANHO` tem position 500 e é ignorada: card não nasce fechado.
    expect(payloadDaCriacao()).toMatchObject({
      pipeline_id: FUNIL_DESTINO,
      stage_id: ETAPA_PRIMEIRA,
    });
  });

  it("etapa de OUTRO funil: 422 `stage_pipeline_mismatch` no SERVIDOR e nada é gravado", async () => {
    const { cliente, escritas } = clienteFake();
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(
      pedido({ pipeline_id: FUNIL_DESTINO, stage_id: ETAPA_DE_OUTRO_FUNIL }),
      ctx,
    );
    const corpo = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("stage_pipeline_mismatch");
    expect(corpo.error.message).toBe("A etapa não pertence ao funil de destino.");
    expect(createLeadHandler).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });

  it("etapa de FECHAMENTO escolhida: 422 `stage_destino_terminal` e nada é gravado", async () => {
    const { cliente, escritas } = clienteFake();
    vi.mocked(createClient).mockResolvedValue(cliente);

    const res = await POST(pedido({ pipeline_id: FUNIL_DESTINO, stage_id: ETAPA_GANHO }), ctx);
    const corpo = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(422);
    expect(corpo.error.code).toBe("stage_destino_terminal");
    expect(createLeadHandler).not.toHaveBeenCalled();
    expect(escritas).toEqual([]);
  });
});

/**
 * #2887 — o "perder em lote" é a MESMA perda do botão do card, POR CARD.
 *
 * Provado contra o Route Handler REAL de `POST /api/v1/leads/bulk` (auth e
 * Supabase mockados). O lote manda UM motivo para os selecionados, e a perda
 * individual (`/leads/{id}/lose`, via `encerraDemanda`) é a REFERÊNCIA:
 *
 *  1. quem JÁ estava perdido não tem o motivo trocado — a `/lose` é idempotente
 *     (`jaEstava`) e preserva o original. No lote o motivo antigo era
 *     sobrescrito em silêncio por `fn_mover_leads_em_lote` (`lost_reason = $4`,
 *     em TODOS os leads do alvo, numa escrita só);
 *  2. a linha da timeline de quem É perdido agora diz o motivo
 *     ("Perdido — <motivo>", a mesma frase da `/lose`) e a de quem JÁ estava
 *     perdido NÃO afirma uma troca que o banco não fez (#2887). O TIPO da
 *     atividade segue `stage_changed`, e é decisão declarada: ele é a fonte de
 *     `lib/metrics/taxa-da-etapa.ts` / `win-rates` (#1753), onde "aterrissar
 *     numa etapa de perda" é o que conta o negócio como encerrado;
 *  3. a auditoria é `lead.lost` POR LEAD, com o motivo, como a `/lose` — e não
 *     só o `lead.bulk_action` agregado (que continua: ele registra a OPERAÇÃO).
 *
 * ⚠️ O motivo preservado da coluna sai do banco (a função só escreve o motivo
 * de quem NÃO estava perdido — `fn_mover_leads_em_lote`, #2887). O duplo aqui
 * emula a função devolvendo a etapa de ORIGEM de cada card, que é o que a rota
 * usa para saber quem entrou na etapa de perda agora e quem só trocou de etapa
 * entre duas etapas de perda (`uniq_crm_stages_pipeline_lost` admite UMA etapa
 * de perda por funil, então o card já perdido que aparece no lote vem de outro
 * funil).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type AuthUser, type Role } from "@/lib/auth/types";
import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => false),
}));
// `stageChangeReason` fica REAL de propósito: a linha do card que já estava
// perdido é a da TRANSIÇÃO ("Movido de X para Y"), e uma razão mockada provaria
// só que o mock foi chamado.
vi.mock("@/lib/leads/activity-emitter", async () => {
  const real =
    await vi.importActual<typeof import("@/lib/leads/activity-emitter")>(
      "@/lib/leads/activity-emitter",
    );
  return { ...real, emitLeadActivity: vi.fn(async () => ({ ok: true })) };
});

import { POST } from "@/app/api/v1/leads/bulk/route";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PIPELINE_ID = "55555555-5555-4555-8555-555555555555";
const PERDIDO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PERDIDO_ANTIGO_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NEGOCIANDO_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
/** O negócio que ESTA operação perde agora. */
const CARD_ABERTO = "44444444-4444-4444-8444-444444444444";
/** O negócio que JÁ estava perdido antes do lote. */
const CARD_JA_PERDIDO = "66666666-6666-4666-8666-666666666666";

const MOTIVO_ANTIGO = "price";
const MOTIVO_DO_LOTE = "no_response";

interface Estado {
  rpcArgs: Record<string, unknown> | null;
}

function clienteStub(estado: Estado) {
  const leads = [
    {
      id: CARD_ABERTO,
      organization_id: ORG_ID,
      tags: [],
      stage_id: NEGOCIANDO_ID,
      pipeline_id: PIPELINE_ID,
      contact_id: "77777777-7777-4777-8777-777777777777",
      lost_reason: null,
      status: "open",
    },
    {
      id: CARD_JA_PERDIDO,
      organization_id: ORG_ID,
      tags: [],
      // Etapa de perda de OUTRO funil: o card já estava perdido e o lote o
      // leva para a etapa de perda deste.
      stage_id: PERDIDO_ANTIGO_ID,
      pipeline_id: PIPELINE_ID,
      contact_id: "88888888-8888-4888-8888-888888888888",
      lost_reason: MOTIVO_ANTIGO,
      status: "lost",
    },
  ];

  return {
    from: (tabela: string) => {
      if (tabela === "crm_leads") {
        const b = {
          select: () => b,
          eq: () => b,
          in: () => b,
          then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve({ data: leads, error: null }).then(onF, onR),
        };
        return b;
      }
      if (tabela === "crm_stages") {
        const b = {
          select: () => b,
          eq: () => b,
          in: () => b,
          is: () => b,
          // A etapa de DESTINO do lote.
          maybeSingle: () =>
            Promise.resolve({
              data: { id: PERDIDO_ID, name: "Perdido", is_lost: true, is_won: false },
              error: null,
            }),
          // Os NOMES das etapas envolvidas (origem de cada card + destino).
          then: (onF: (v: unknown) => unknown) =>
            Promise.resolve({
              data: [
                { id: NEGOCIANDO_ID, name: "Negociando" },
                { id: PERDIDO_ANTIGO_ID, name: "Perdido (antigo)" },
                { id: PERDIDO_ID, name: "Perdido" },
              ],
              error: null,
            }).then(onF),
        };
        return b;
      }
      // `crm_pipelines`: settings vazio — a régua de reabertura e a de campos
      // não recusam, então o teste isola a perda em si.
      const d = {
        select: () => d,
        eq: () => d,
        in: () => d,
        is: () => d,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (onF: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onF),
      };
      return d;
    },
    rpc(nome: string, args: Record<string, unknown>) {
      if (nome !== "fn_mover_leads_em_lote") {
        return Promise.resolve({ data: null, error: null });
      }
      estado.rpcArgs = { nome, ...args };
      // A etapa de ORIGEM de cada card, como a função do banco devolve.
      return Promise.resolve({
        data: [
          { lead_id: CARD_ABERTO, from_stage_id: NEGOCIANDO_ID, pipeline_id: PIPELINE_ID },
          { lead_id: CARD_JA_PERDIDO, from_stage_id: PERDIDO_ANTIGO_ID, pipeline_id: PIPELINE_ID },
        ],
        error: null,
      });
    },
  };
}

function adminStub() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF),
  };
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) };
}

function sessao(estado: Estado) {
  const user: AuthUser = {
    id: USER_ID,
    email: "m@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG_ID, organization_name: "Org", role: "manager" as Role }],
  };
  vi.mocked(requireRole).mockImplementation(async () => ({
    ok: true,
    user,
    org: { orgId: ORG_ID, name: "Org", role: "manager" as Role },
  }));
  vi.mocked(createClient).mockResolvedValue(clienteStub(estado) as never);
  vi.mocked(createAdminClient).mockReturnValue(adminStub() as never);
}

function pedido() {
  return new NextRequest("http://local/api/v1/leads/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "move",
      lead_ids: [CARD_ABERTO, CARD_JA_PERDIDO],
      params: { stage_id: PERDIDO_ID, lost_reason: MOTIVO_DO_LOTE },
    }),
  });
}

describe("perder em lote (#2887) não sobrescreve o motivo de quem já estava perdido", () => {
  let estado: Estado;

  beforeEach(() => {
    estado = { rpcArgs: null };
    vi.clearAllMocks();
    sessao(estado);
  });

  it("o motivo do lote vai para a função do banco — quem decide a quem ele se aplica é a função", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);

    // O payload do lote manda UM motivo para N cards; a #2887 é sobre o banco
    // não o escrever em quem já tinha o dele.
    expect(estado.rpcArgs?.p_lost_reason).toBe(MOTIVO_DO_LOTE);
    expect(estado.rpcArgs?.p_lead_ids).toEqual([CARD_ABERTO, CARD_JA_PERDIDO]);
  });

  it("quem É perdido agora leva a linha da perda, com o motivo e o desfecho", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);

    const atividades = vi.mocked(emitLeadActivity).mock.calls.map((c) => c[1]);
    expect(atividades).toHaveLength(2);

    // O TIPO segue `stage_changed`: ele é a fonte de `lib/metrics/taxa-da-etapa.ts`
    // / `win-rates` (#1753). O que a #2887 cobra é o MOTIVO no `reason`.
    const doAberto = atividades.find((a) => a.leadId === CARD_ABERTO);
    expect(doAberto?.type).toBe("stage_changed");
    expect(doAberto?.reason).toBe(`Perdido — ${MOTIVO_DO_LOTE}`);
    expect(doAberto?.payload).toMatchObject({
      desfecho: "lost",
      from_stage_id: NEGOCIANDO_ID,
      to_stage_id: PERDIDO_ID,
      bulk: true,
    });
  });

  it("quem JÁ estava perdido leva a linha da TRANSIÇÃO — não uma perda que não houve", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);

    const atividades = vi.mocked(emitLeadActivity).mock.calls.map((c) => c[1]);
    // O motivo dele não mudou, então a linha é a do movimento: afirmar
    // "Perdido — <motivo do lote>" diria na timeline uma troca que o banco não
    // fez (é o par da linha 138 do teste de banco).
    const doJaPerdido = atividades.find((a) => a.leadId === CARD_JA_PERDIDO);
    expect(doJaPerdido?.type).toBe("stage_changed");
    expect(doJaPerdido?.reason).toBe("Movido de Perdido (antigo) para Perdido");
    expect(doJaPerdido?.reason).not.toContain(MOTIVO_DO_LOTE);
    expect(doJaPerdido?.payload).not.toHaveProperty("desfecho");
  });

  it("a auditoria da perda é `lead.lost` POR LEAD, e o agregado da operação continua", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);

    const chamadas = vi.mocked(audit).mock.calls.map((c) => c[0]);
    const porLead = chamadas.filter((c) => c.action === "lead.lost");
    expect(porLead).toHaveLength(1);
    expect(porLead[0]).toMatchObject({
      actorUserId: USER_ID,
      organizationId: ORG_ID,
      resourceType: "crm_lead",
      resourceId: CARD_ABERTO,
      metadata: {
        actor_type: "user",
        from_stage_id: NEGOCIANDO_ID,
        to_stage_id: PERDIDO_ID,
        lost_reason: MOTIVO_DO_LOTE,
      },
    });

    // O agregado da OPERAÇÃO continua: ele não é a perda de ninguém, é o
    // registro de que N negócios foram alterados numa chamada só.
    expect(chamadas.filter((c) => c.action === "lead.bulk_action")).toHaveLength(1);
  });
});

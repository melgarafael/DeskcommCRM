import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { moverLeadParaEtapaDeHandoff, SLUG_ETAPA_HANDOFF } from "@/lib/leads/handoff-stage-move";

vi.mock("@/lib/leads/activity-emitter", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads/activity-emitter")>()),
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

const ORG = "org-1";
const LEAD = {
  id: "lead-1",
  pipeline_id: "pipe-1",
  stage_id: "s1",
  contact_id: "contato-1",
  status: "open",
};
const ETAPA_HANDOFF = { id: "s-handoff", name: "Chamar Humano" };
const ETAPA_ORIGEM = { name: "Agendado" };

interface Resposta {
  data: unknown;
  error: { message: string } | null;
}
interface Cenario {
  lead: Resposta;
  etapaDestino: Resposta;
  update: Resposta;
  rpcError?: { message: string } | null;
}

function cenario(over: Partial<Cenario> = {}): Cenario {
  return {
    lead: { data: LEAD, error: null },
    etapaDestino: { data: ETAPA_HANDOFF, error: null },
    update: { data: [{ id: LEAD.id }], error: null },
    ...over,
  };
}

interface ChamadaRpc {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * Fake do query builder, no mesmo espírito do de `agent-stage-sync.test.ts`:
 * thenable, distingue SELECT de UPDATE, e diferencia as DUAS consultas em
 * `crm_stages` (etapa de destino vs. nome da etapa de origem) pelas chaves
 * passadas a `.eq()` — a de destino filtra por `slug`, a de origem não.
 */
function fakeAdmin(c: Cenario, rpcs: ChamadaRpc[] = []) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: c.rpcError ?? null });
    },
    from(tabela: string) {
      const b = {
        _update: false,
        _select: false,
        _eqKeys: [] as string[],
        select: () => {
          b._select = true;
          return b;
        },
        update: () => {
          b._update = true;
          return b;
        },
        eq: (key: string) => {
          b._eqKeys.push(key);
          return b;
        },
        maybeSingle: () => {
          if (tabela === "crm_leads") return Promise.resolve(c.lead);
          if (b._eqKeys.includes("slug")) return Promise.resolve(c.etapaDestino);
          return Promise.resolve({ data: ETAPA_ORIGEM, error: null });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const r = b._update ? c.update : c.lead;
          return Promise.resolve(r).then(onF, onR);
        },
      };
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const mover = (c: Cenario) =>
  moverLeadParaEtapaDeHandoff(fakeAdmin(c), {
    organizationId: ORG,
    leadId: LEAD.id,
    reason: "requested_human",
  });

async function moverObservando(c: Cenario) {
  const rpcs: ChamadaRpc[] = [];
  const r = await moverLeadParaEtapaDeHandoff(fakeAdmin(c, rpcs), {
    organizationId: ORG,
    leadId: LEAD.id,
    reason: "requested_human",
  });
  return { r, eventos: rpcs.filter((x) => x.fn === "emit_event") };
}

describe("moverLeadParaEtapaDeHandoff", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  it("caminho feliz: move para a etapa de handoff e emite atividade + evento", async () => {
    const { r, eventos } = await moverObservando(cenario());
    expect(r).toEqual({ moveu: true, motivo: "movido" });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.args).toMatchObject({
      p_event_type: "lead.stage_changed",
      p_payload: expect.objectContaining({ to_stage_id: ETAPA_HANDOFF.id }),
    });
  });

  it("pipeline sem etapa 'chamar-humano': no-op, sem mover nem gravar atividade", async () => {
    const r = await mover(cenario({ etapaDestino: { data: null, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "sem_etapa_de_handoff" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("lead já está na etapa de handoff: não move de novo", async () => {
    const r = await mover(
      cenario({ lead: { data: { ...LEAD, stage_id: ETAPA_HANDOFF.id }, error: null } }),
    );
    expect(r).toEqual({ moveu: false, motivo: "ja_esta_la" });
  });

  it("lead fechado (won/lost) não é movido — deal encerrado não volta ao funil", async () => {
    const r = await mover(cenario({ lead: { data: { ...LEAD, status: "won" }, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "lead_fechado" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("lead não encontrado (org errada ou deletado): não move, não é erro de sistema", async () => {
    const r = await mover(cenario({ lead: { data: null, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "lead_nao_encontrado" });
  });

  it("UPDATE sem linha afetada = humano moveu o card no meio da operação (trava otimista)", async () => {
    const r = await mover(cenario({ update: { data: [], error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "conflito_humano" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("erro no SELECT do lead é indisponibilidade, não 'lead_nao_encontrado'", async () => {
    const r = await mover(cenario({ lead: { data: null, error: { message: "fetch failed" } } }));
    expect(r).toEqual({ moveu: false, motivo: "indisponivel" });
  });

  it("erro no UPDATE é falha_de_escrita", async () => {
    const r = await mover(
      cenario({ update: { data: null, error: { message: "constraint violation" } } }),
    );
    expect(r).toEqual({ moveu: false, motivo: "falha_de_escrita" });
  });

  it("SLUG_ETAPA_HANDOFF é o slug estável que a tela de Provedores/Pipelines deve usar", () => {
    expect(SLUG_ETAPA_HANDOFF).toBe("chamar-humano");
  });
});

it("handoff derivado mantém a continuação do canal A sem observar/iniciar B", async () => {
  const rpcs: ChamadaRpc[] = [];
  const admin = fakeAdmin(cenario(), rpcs);
  const boundary = {
    organization_id: ORG,
    contact_id: LEAD.contact_id,
    conversation_id: "canal-A",
    service_revision: 1,
    demanda_id: null,
    demanda_revision: null,
  };
  admin.rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args });
    return {
      data:
        fn === "fn_service_boundary"
          ? { ...boundary, status: "open", demanda_fechada_em: null }
          : null,
      error: null,
    };
  };
  expect(
    (
      await moverLeadParaEtapaDeHandoff(admin, {
        organizationId: ORG,
        leadId: LEAD.id,
        reason: "requested_human",
        serviceBoundary: boundary,
      })
    ).moveu,
  ).toBe(true);
  const event = rpcs.find((call) => call.fn === "emit_event");
  expect(event?.args.p_payload).toMatchObject({
    service_origin: { kind: "continuation", boundary },
  });
  expect(rpcs.map((call) => call.fn)).not.toContain("fn_service_observe_command");
  expect(rpcs.map((call) => call.fn)).not.toContain("fn_service_begin");
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  moverLeadParaEtapaDeAgendamento,
  SLUG_ETAPA_POR_TRANSICAO,
} from "@/lib/leads/appointment-stage-move";

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
const ETAPA_AGENDADO = { id: "s-agendado", name: "Agendado" };
const ETAPA_ORIGEM = { name: "Agendamento solicitado" };

interface Resposta {
  data: unknown;
  error: { message: string } | null;
}
interface Cenario {
  lead: Resposta;
  etapaDestino: Resposta;
  update: Resposta;
  rpcError?: { message: string } | null;
  etapaPorSlug?: (slug: string) => Resposta;
  /** O `crm_pipelines.settings` que a régua de campos obrigatórios lê (#1536). */
  funil?: Resposta;
}

function cenario(over: Partial<Cenario> = {}): Cenario {
  return {
    lead: { data: LEAD, error: null },
    etapaDestino: { data: ETAPA_AGENDADO, error: null },
    update: { data: [{ id: LEAD.id }], error: null },
    ...over,
  };
}

interface ChamadaRpc {
  fn: string;
  args: Record<string, unknown>;
}

/** Mesmo fake de query builder de `handoff-stage-move.test.ts`. */
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
        _slugVal: undefined as string | undefined,
        select: () => {
          b._select = true;
          return b;
        },
        update: () => {
          b._update = true;
          return b;
        },
        eq: (key: string, val?: unknown) => {
          b._eqKeys.push(key);
          if (key === "slug" && typeof val === "string") b._slugVal = val;
          return b;
        },
        maybeSingle: () => {
          if (tabela === "crm_pipelines")
            return Promise.resolve(c.funil ?? { data: ETAPA_ORIGEM, error: null });
          if (tabela === "crm_leads") return Promise.resolve(c.lead);
          if (b._eqKeys.includes("slug")) {
            if (c.etapaPorSlug && b._slugVal) return Promise.resolve(c.etapaPorSlug(b._slugVal));
            return Promise.resolve(c.etapaDestino);
          }
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

const mover = (c: Cenario, transicao: "pending" | "confirmed" = "confirmed") =>
  moverLeadParaEtapaDeAgendamento(fakeAdmin(c), {
    organizationId: ORG,
    leadId: LEAD.id,
    transicao,
  });

async function moverObservando(c: Cenario, transicao: "pending" | "confirmed" = "confirmed") {
  const rpcs: ChamadaRpc[] = [];
  const r = await moverLeadParaEtapaDeAgendamento(fakeAdmin(c, rpcs), {
    organizationId: ORG,
    leadId: LEAD.id,
    transicao,
  });
  return { r, eventos: rpcs.filter((x) => x.fn === "emit_event") };
}

describe("moverLeadParaEtapaDeAgendamento", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  it("caminho feliz: confirmado move para 'agendado' e emite atividade + evento", async () => {
    const { r, eventos } = await moverObservando(cenario(), "confirmed");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.args).toMatchObject({
      p_event_type: "lead.stage_changed",
      p_payload: expect.objectContaining({ to_stage_id: ETAPA_AGENDADO.id }),
    });
  });

  it("pending move para 'agendamento-solicitado'", async () => {
    const etapa = { id: "s-solicitado", name: "Agendamento solicitado" };
    const r = await mover(cenario({ etapaDestino: { data: etapa, error: null } }), "pending");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
  });

  it("transição sem mapa (ex.: cancelled) é no-op sem tocar o banco", async () => {
    // @ts-expect-error -- transição fora do vocabulário mapeado, de propósito
    const r = await mover(cenario(), "cancelled");
    expect(r).toEqual({ moveu: false, motivo: "transicao_nao_mapeada" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("pipeline sem a etapa mapeada: no-op, sem mover nem gravar atividade", async () => {
    const r = await mover(cenario({ etapaDestino: { data: null, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "sem_etapa_mapeada" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("lead já está na etapa alvo: não move de novo", async () => {
    const r = await mover(
      cenario({ lead: { data: { ...LEAD, stage_id: ETAPA_AGENDADO.id }, error: null } }),
    );
    expect(r).toEqual({ moveu: false, motivo: "ja_esta_la" });
  });

  it("lead fechado (won/lost) não é movido — deal encerrado não volta ao funil", async () => {
    const r = await mover(cenario({ lead: { data: { ...LEAD, status: "lost" }, error: null } }));
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
    const r = await mover(cenario({ update: { data: null, error: { message: "constraint violation" } } }));
    expect(r).toEqual({ moveu: false, motivo: "falha_de_escrita" });
  });

  it("mapa de slugs é o contrato estável que a tela de Pipelines documenta", () => {
    expect(SLUG_ETAPA_POR_TRANSICAO).toEqual({
      pending: "agendamento-solicitado",
      confirmed: "agendado",
    });
  });

  it("encontra etapa legada com sublinhado ('agendamento_solicitado') se não houver etapa com hífen", async () => {
    const c = cenario({
      etapaPorSlug: (slug: string) => {
        if (slug === "agendamento_solicitado") {
          return { data: { id: "s-legada", name: "Agendamento Solicitado" }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const r = await mover(c, "pending");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
  });

  it("erro de banco na busca pelo slug legado é indisponibilidade, não 'sem_etapa_mapeada'", async () => {
    const c = cenario({
      etapaPorSlug: (slug: string) =>
        slug === "agendamento_solicitado"
          ? { data: null, error: { message: "fetch failed" } }
          : { data: null, error: null },
    });
    const r = await mover(c, "pending");
    expect(r).toEqual({ moveu: false, motivo: "indisponivel" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });
});

/* ── A RÉGUA DE CAMPOS OBRIGATÓRIOS NO AGENDAMENTO (CR do mantenedor, #1536) ─ */

/**
 * Marcar um horário também grava `stage_id`: sem a pergunta aqui, a agenda
 * seria a porta de trás da exigência declarada no funil. Mesmo desenho do
 * arrasto — não move, devolve o motivo e o que falta em `detalhe`. A etapa de
 * destino é UUID porque `obrigatorio_em.etapas` é `z.string().uuid()` e
 * `camposDoFunil` descarta o campo quando o id não passa do parse.
 */
describe("moverLeadParaEtapaDeAgendamento e a régua de campos obrigatórios", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  const ETAPA_UUID = "99999999-9999-4999-8999-999999999999";
  const destinoExigente = () =>
    cenario({
      etapaDestino: { data: { ...ETAPA_AGENDADO, id: ETAPA_UUID }, error: null },
      funil: {
        data: {
          settings: {
            fields: [
              {
                key: "concorrente",
                label: "Concorrente",
                type: "text",
                obrigatorio_em: { etapas: [ETAPA_UUID] },
              },
            ],
          },
        },
        error: null,
      },
    });

  it("não move: devolve `campos_obrigatorios` com o que falta, sem gravar nada", async () => {
    const r = await mover(destinoExigente());

    expect(r).toEqual({
      moveu: false,
      motivo: "campos_obrigatorios",
      detalhe: expect.stringContaining("Concorrente"),
    });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("funil SEM a exigência segue movendo como sempre (fail-open)", async () => {
    const r = await mover(
      cenario({ etapaDestino: { data: { ...ETAPA_AGENDADO, id: ETAPA_UUID }, error: null } }),
    );
    expect(r).toEqual({ moveu: true, motivo: "movido" });
  });
});

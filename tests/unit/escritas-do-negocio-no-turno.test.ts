import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpContext } from "@/lib/mcp/types";
import type * as ActivityEmitter from "@/lib/leads/activity-emitter";
import type * as ServiceBoundary from "@/lib/atendimento/fronteira-server";
import {
  chaveDaEscritaDoNegocio,
  criarFilaDeEscritasDoNegocio,
  PRAZO_ESCRITA_NEGOCIO_MS,
} from "@/lib/ai/runtime/escritas-do-negocio";

const dublês = vi.hoisted(() => ({ banco: null as unknown, comandoVigente: true }));
vi.mock("@/lib/atendimento/fronteira-server", async (original) => ({
  ...(await original() as typeof ServiceBoundary),
  guardServiceEffect: vi.fn(async () => {
    if (!dublês.comandoVigente) throw new Error("service_boundary_stale");
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => dublês.banco }));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/leads/activity-emitter", async (original) => ({
  ...(await original() as typeof ActivityEmitter),
  emitLeadActivity: vi.fn(async () => {
    (dublês.banco as ReturnType<typeof banco>).atividade();
    return { ok: true };
  }),
}));
vi.mock("@/lib/mcp/tools", async () => {
  const { crmUpdateLead, crmMoveLeadStage } = await import("@/lib/mcp/tools/leads");
  const { crmManageTags } = await import("@/lib/mcp/tools/governance");
  const tools = [crmUpdateLead, crmMoveLeadStage, crmManageTags];
  return { allTools: tools, getToolByName: (nome: string) => tools.find((t) => t.name === nome) };
});

const { crmUpdateLead, crmMoveLeadStage } = await import("@/lib/mcp/tools/leads");
const { pickToolsFromMcp } = await import("@/lib/ai/runtime/tools");
const { auditMcpToolCall } = await import("@/lib/mcp/audit");
const { audit } = await import("@/lib/audit");
const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const ETAPA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";

function porta() {
  let liberar!: () => void;
  const espera = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  return { espera, liberar };
}

/** Adaptador em memória: handlers e ferramentas reais; só consultas/efeitos externos simulados.
 * A comparação updated_at usa o filtro que moveLeadHandler realmente enviou.
 * A atividade reproduz o segundo bump de updated_at do trigger nativo.
 */
function banco({ segurarEdicao = false } = {}) {
  let revisao = 0;
  const leuEtapa = porta();
  const liberaEtapa = porta();
  const editou = porta();
  const liberaEdicao = porta();
  let leiturasEtapa = 0;
  let pausar = true;
  const lead: Record<string, unknown> = {
    id: LEAD,
    organization_id: ORG,
    pipeline_id: FUNIL,
    stage_id: "origem",
    status: "open",
    contact_id: null,
    updated_at: "r0",
    description: "Antes",
    custom_fields: {},
    tags: [],
    owner_user_id: null,
  };
  const bump = () => {
    lead.updated_at = `r${++revisao}`;
  };
  return {
    lead,
    leuEtapa,
    liberaEtapa,
    editou,
    liberaEdicao,
    get leiturasEtapa() { return leiturasEtapa; },
    atividade: () => bump(),
    humano: () => {
      lead.description = "Edição humana";
      bump();
    },
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      let patch: Record<string, unknown> | null = null;
      const q = {
        then: (resolver: (r: unknown) => unknown) => {
          if (patch) {
            Object.assign(lead, patch);
            bump();
          }
          return resolver({ data: [{ ...lead }], error: null });
        },
        select: () => q,
        eq: (campo: string, valor: unknown) => {
          filtros[campo] = valor;
          return q;
        },
        update: (valor: Record<string, unknown>) => {
          patch = valor;
          return q;
        },
        maybeSingle: async () => {
          if (tabela === "crm_pipelines") return { data: { settings: {} }, error: null };
          if (tabela === "crm_stages") {
            if (filtros.id === ETAPA) leiturasEtapa++;
            if (pausar && filtros.id === ETAPA) {
              pausar = false;
              leuEtapa.liberar();
              await liberaEtapa.espera;
            }
            return {
              data: {
                id: filtros.id,
                name: "Etapa",
                pipeline_id: FUNIL,
                organization_id: ORG,
                is_lost: false,
                is_won: false,
              },
              error: null,
            };
          }
          if (tabela !== "crm_leads") throw new Error(`consulta inesperada: ${tabela}`);
          if (filtros.organization_id && filtros.organization_id !== ORG)
            return { data: null, error: null };
          if (patch) {
            if (filtros.updated_at && filtros.updated_at !== lead.updated_at)
              return { data: null, error: null };
            Object.assign(lead, patch);
            bump();
            if (segurarEdicao && patch.description) {
              editou.liberar();
              await liberaEdicao.espera;
            }
          }
          return { data: { ...lead }, error: null };
        },
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function contexto(sb: unknown): McpContext {
  return {
    organizationId: ORG,
    role: "ai_operator",
    actor: { type: "ai_agent", id: "agente-ficticio", role: "ai_operator" },
    apiTokenId: "token-ficticio",
    requestId: "turno-ficticio",
    supabase: sb as SupabaseClient,
  };
}
function montar(sb: unknown, contatoDoTurno?: string, incluirTags = false) {
  const ctx = contexto(sb);
  return pickToolsFromMcp({
    supabase: ctx.supabase,
    ctx,
    auth: {
      organizationId: ORG,
      role: ctx.role,
      actor: ctx.actor,
      apiTokenId: ctx.apiTokenId,
      scopes: ["mcp:read", "mcp:write"],
    },
    toolIds: [crmUpdateLead.name, crmMoveLeadStage.name, ...(incluirTags ? ["crm_manage_tags"] : [])],
    pipelineIds: [FUNIL],
    handoffToolEnabled: false,
    handoffSignal: { triggered: false },
    ...(contatoDoTurno ? { contatoDoTurno } : {}),
  });
}
const mover = { lead_id: LEAD, to_stage_id: ETAPA, position_in_stage: 10 };
const editar = { lead_id: LEAD, description: "Atualização fictícia" };
const options = { toolCallId: "chamada-ficticia", messages: [], context: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  dublês.comandoVigente = true;
});

describe("reprodução com os handlers nativos", () => {
  it("edição seguida de movimento no mesmo passo relê a revisão após a atividade", async () => {
    const sb = banco({ segurarEdicao: true });
    dublês.banco = sb;
    sb.liberaEtapa.liberar();
    const tools = montar(sb);
    const edicao = tools.crm_update_lead!.execute!(editar, options);
    await sb.editou.espera;
    const movimento = tools.crm_move_lead_stage!.execute!(mover, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // O update já gravou; a atividade/auditoria da edição ainda não ocorreram.
    // Sem a fila, o movimento entra pela porta da etapa antes desta liberação.
    let resultados: unknown[];
    try {
      expect(sb.lead.description).toBe(editar.description);
      expect(sb.leiturasEtapa).toBe(0);
    } finally {
      sb.liberaEdicao.liberar();
      resultados = await Promise.all([edicao, movimento]);
    }
    expect(resultados.every((r) => !!r && typeof r === "object" && "lead" in r)).toBe(true);
    expect(sb.lead).toMatchObject({ stage_id: ETAPA, description: editar.description });
    expect(vi.mocked(audit).mock.calls.map(([a]) => a.action)).toEqual([
      "lead.updated",
      "lead.moved",
    ]);
  });

  it("id do contato traduzido e id do negócio compartilham a mesma fila", async () => {
    const sb = banco();
    dublês.banco = sb;
    const tools = montar(sb, CONTATO);
    const movimento = tools.crm_move_lead_stage!.execute!({ ...mover, lead_id: CONTATO }, options);
    await sb.leuEtapa.espera;
    const edicao = tools.crm_update_lead!.execute!(editar, options);
    // Drena as microtarefas; o movimento permanece parado na porta da etapa.
    await new Promise((resolve) => setTimeout(resolve, 0));
    sb.liberaEtapa.liberar();
    expect(await Promise.all([movimento, edicao])).toEqual([
      expect.objectContaining({ lead: expect.objectContaining({ id: LEAD, stage_id: ETAPA }) }),
      expect.objectContaining({
        lead: expect.objectContaining({ id: LEAD, description: editar.description }),
      }),
    ]);
  });

  it("sem a ponte, editar enquanto o movimento leu a revisão velha produz o 409", async () => {
    const sb = banco();
    dublês.banco = sb;
    const movimento = crmMoveLeadStage.handler(mover, contexto(sb));
    const erro = expect(movimento).rejects.toMatchObject({
      code: "lead_stage_changed_concurrent",
      status: 409,
    });
    await sb.leuEtapa.espera;
    await crmUpdateLead.handler(editar, contexto(sb));
    sb.liberaEtapa.liberar();
    await erro;
    expect(sb.lead.stage_id).toBe("origem");
  });

  it("na ponte, movimento e edição simultâneos terminam com ambos os efeitos e auditorias", async () => {
    const sb = banco();
    dublês.banco = sb;
    const tools = montar(sb);
    const movimento = tools.crm_move_lead_stage!.execute!(mover, options);
    await sb.leuEtapa.espera;
    const edicao = tools.crm_update_lead!.execute!(editar, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    sb.liberaEtapa.liberar();
    const resultados = await Promise.all([movimento, edicao]);
    expect(resultados).toEqual([
      expect.objectContaining({ lead: expect.objectContaining({ stage_id: ETAPA }) }),
      expect.objectContaining({
        lead: expect.objectContaining({ description: editar.description }),
      }),
    ]);
    expect(sb.lead).toMatchObject({ stage_id: ETAPA, description: editar.description });
    expect(vi.mocked(audit).mock.calls.map(([a]) => a.action)).toEqual([
      "lead.moved",
      "lead.updated",
    ]);
    expect(vi.mocked(auditMcpToolCall).mock.calls.map(([a]) => a.success)).toEqual([true, true]);
  });

  it("intervenção humana durante o movimento ainda recusa, e a fila continua", async () => {
    const sb = banco();
    dublês.banco = sb;
    const tools = montar(sb);
    const movimento = tools.crm_move_lead_stage!.execute!(mover, options);
    await sb.leuEtapa.espera;
    sb.humano();
    sb.liberaEtapa.liberar();
    expect(await movimento).toEqual({ error: "Lead foi modificado concorrentemente." });
    expect(sb.lead.stage_id).toBe("origem");
    expect(sb.lead.description).toBe("Edição humana");
    expect(await tools.crm_update_lead!.execute!(editar, options)).toHaveProperty("lead");
    expect(vi.mocked(auditMcpToolCall).mock.calls.map(([a]) => a.success)).toEqual([false, true]);
  });

  it("tags que aguardam outra escrita revalidam o comando antes de começar; o movimento que ainda não escreveu é recusado e um turno novo continua", async () => {
    const sb = banco();
    dublês.banco = sb;
    sb.lead.tags = ["vip"];
    const tools = montar(sb, undefined, true);
    const movimento = tools.crm_move_lead_stage!.execute!(mover, options);
    await sb.leuEtapa.espera;
    const args = { target_kind: "lead", target_id: LEAD, remove: ["vip"] };
    const tags = tools.crm_manage_tags!.execute!(args, options);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Remover não cria evento de tag nova nem ganha guarda via observeServiceOrigin.
    expect(sb.lead.tags).toEqual(["vip"]);
    dublês.comandoVigente = false;
    sb.liberaEtapa.liberar();
    // O movimento só leu: a revalidação antes da escrita (#2541) o recusa inteiro.
    expect(await movimento).toEqual({ error: "service_boundary_stale" });
    expect(sb.lead).toMatchObject({ stage_id: "origem", updated_at: "r0" });
    expect(await tags).toEqual({ error: "service_boundary_stale" });
    expect(sb.lead.tags).toEqual(["vip"]);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
    expect(vi.mocked(auditMcpToolCall).mock.calls.map(([a]) => a.success)).toEqual([false, false]);
    // A fila não confunde a revogação antiga com a autoridade de um turno novo.
    dublês.comandoVigente = true;
    expect(await montar(sb, undefined, true).crm_manage_tags!.execute!(args, options))
      .toMatchObject({ tags: [] });
    expect(sb.lead.tags).toEqual([]);
  });
});

describe("fila por negócio do turno", () => {
  it("espera até a primeira operação completar, não só até seu primeiro update", async () => {
    const fila = criarFilaDeEscritasDoNegocio();
    const bloqueio = porta();
    const ordem: string[] = [];
    const a = fila("org/card", async () => {
      ordem.push("update");
      await bloqueio.espera;
      ordem.push("atividade");
    });
    const b = fila("org/card", async () => {
      ordem.push("move");
    });
    await Promise.resolve();
    expect(ordem).toEqual(["update"]);
    bloqueio.liberar();
    await Promise.all([a, b]);
    expect(ordem).toEqual(["update", "atividade", "move"]);
  });
  it("negócios independentes e leituras não aguardam a escrita pendente", async () => {
    const fila = criarFilaDeEscritasDoNegocio();
    const bloqueio = porta();
    const a = fila("org/card-a", () => bloqueio.espera);
    expect(await fila("org/card-b", async () => "outro")).toBe("outro");
    expect(await fila(null, async () => "leitura")).toBe("leitura");
    bloqueio.liberar();
    await a;
  });
  it("falha da primeira devolve o erro e não contamina a próxima", async () => {
    const fila = criarFilaDeEscritasDoNegocio();
    const a = fila("org/card", async () => {
      throw new Error("recusa");
    });
    const b = fila("org/card", async () => "ok");
    await expect(a).rejects.toThrow("recusa");
    expect(await b).toBe("ok");
    expect(await fila("org/card", async () => "nova")).toBe("nova");
  });
  it("organizações distintas não compartilham chave mesmo com o mesmo id", async () => {
    const def = { name: "crm_update_lead", category: "write" as const };
    const a = chaveDaEscritaDoNegocio("org-a", def, editar)!;
    const b = chaveDaEscritaDoNegocio("org-b", def, editar)!;
    expect(a).not.toBe(b);
    const fila = criarFilaDeEscritasDoNegocio();
    const bloqueio = porta();
    const pendente = fila(a, () => bloqueio.espera);
    expect(await fila(b, async () => "independente")).toBe("independente");
    bloqueio.liberar();
    await pendente;
  });
  it("montagens distintas têm filas distintas", async () => {
    const a = criarFilaDeEscritasDoNegocio();
    const b = criarFilaDeEscritasDoNegocio();
    const bloqueio = porta();
    const pendente = a("org/card", () => bloqueio.espera);
    expect(await b("org/card", async () => "outro turno")).toBe("outro turno");
    bloqueio.liberar();
    await pendente;
  });
  it("chave reconhece lead explícito e tags de lead; leitura, contato e alvos indiretos ficam fora", () => {
    const def = { name: "crm_update_lead", category: "write" as const };
    expect(chaveDaEscritaDoNegocio(ORG, def, editar)).toBe(JSON.stringify([ORG, LEAD]));
    expect(
      chaveDaEscritaDoNegocio(
        ORG,
        { ...def, name: "crm_manage_tags" },
        { target_kind: "lead", target_id: LEAD },
      ),
    ).toBe(JSON.stringify([ORG, LEAD]));
    expect(chaveDaEscritaDoNegocio(ORG, { ...def, category: "read" }, editar)).toBeNull();
    expect(
      chaveDaEscritaDoNegocio(
        ORG,
        { ...def, name: "crm_manage_tags" },
        { target_kind: "contact", target_id: LEAD },
      ),
    ).toBeNull();
    expect(
      chaveDaEscritaDoNegocio(ORG, { ...def, name: "crm_book_appointment" }, { contact_id: LEAD }),
    ).toBeNull();
  });
});

describe("prazo sem liberar uma escrita em andamento", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("devolve resultado incerto, recusa queued e novo turno até a escrita tardia terminar", async () => {
    const fila = criarFilaDeEscritasDoNegocio();
    const bloqueio = porta();
    const ordem: string[] = [];
    const ativa = fila("prazo/card", async () => {
      ordem.push("iniciada");
      await bloqueio.espera;
      ordem.push("escrita tardia");
    });
    const seguinte = vi.fn(async () => ordem.push("não deve executar"));
    const espera = fila("prazo/card", seguinte);
    const recusaAtiva = expect(ativa).rejects.toThrow("lead_write_outcome_unknown");
    const recusaEspera = expect(espera).rejects.toThrow("lead_write_outcome_unknown");
    await vi.advanceTimersByTimeAsync(PRAZO_ESCRITA_NEGOCIO_MS);
    await Promise.all([recusaAtiva, recusaEspera]);
    expect(ordem).toEqual(["iniciada"]);
    const outroTurno = criarFilaDeEscritasDoNegocio();
    await expect(outroTurno("prazo/card", seguinte)).rejects.toThrow("lead_write_outcome_unknown");
    expect(await outroTurno("outra-org/card", async () => "outro tenant")).toBe("outro tenant");
    expect(await outroTurno("prazo/outro-card", async () => "outro card")).toBe("outro card");
    expect(await outroTurno(null, async () => "leitura")).toBe("leitura");
    bloqueio.liberar();
    await vi.advanceTimersByTimeAsync(0);
    expect(ordem).toEqual(["iniciada", "escrita tardia"]);
    expect(seguinte).not.toHaveBeenCalled();
    // O turno vencido não revive; a pendência verdadeira já liquidada libera um novo.
    await expect(fila("prazo/card", seguinte)).rejects.toThrow("lead_write_outcome_unknown");
    expect(await outroTurno("prazo/card", async () => "novo turno legítimo")).toBe("novo turno legítimo");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limpar a pendência mais antiga não apaga outra operação sem desfecho da mesma chave", async () => {
    // Montagens independentes podiam já estar executando antes da primeira expiração.
    const a = porta();
    const b = porta();
    const primeira = criarFilaDeEscritasDoNegocio()("identidade/card", () => a.espera);
    const segunda = criarFilaDeEscritasDoNegocio()("identidade/card", () => b.espera);
    const recusas = [primeira, segunda].map((p) => expect(p).rejects.toThrow("lead_write_outcome_unknown"));
    await vi.advanceTimersByTimeAsync(PRAZO_ESCRITA_NEGOCIO_MS);
    await Promise.all(recusas);
    a.liberar();
    await vi.advanceTimersByTimeAsync(0);
    const nova = criarFilaDeEscritasDoNegocio();
    const operacao = vi.fn(async () => "ok");
    await expect(nova("identidade/card", operacao)).rejects.toThrow("lead_write_outcome_unknown");
    expect(operacao).not.toHaveBeenCalled();
    b.liberar();
    await vi.advanceTimersByTimeAsync(0);
    expect(await nova("identidade/card", operacao)).toBe("ok");
  });

  it("rejeição tardia do handler também liquida a pendência sem erro não tratado nem retry", async () => {
    const bloqueio = porta();
    const operacao = vi.fn(async () => { await bloqueio.espera; throw new Error("recusa tardia"); });
    const ativa = criarFilaDeEscritasDoNegocio()("rejeicao/card", operacao);
    const recusa = expect(ativa).rejects.toThrow("lead_write_outcome_unknown");
    await vi.advanceTimersByTimeAsync(PRAZO_ESCRITA_NEGOCIO_MS);
    await recusa;
    bloqueio.liberar();
    await vi.advanceTimersByTimeAsync(0);
    expect(operacao).toHaveBeenCalledTimes(1);
    expect(await criarFilaDeEscritasDoNegocio()("rejeicao/card", async () => "ok")).toBe("ok");
  });

  it("na ponte nativa, auditoria marca falha e o modelo recebe incerteza sem iniciar movimento", async () => {
    const sb = banco({ segurarEdicao: true });
    dublês.banco = sb;
    sb.liberaEtapa.liberar();
    const tools = montar(sb);
    const edicao = tools.crm_update_lead!.execute!(editar, options);
    await sb.editou.espera;
    const movimento = tools.crm_move_lead_stage!.execute!(mover, options);
    await vi.advanceTimersByTimeAsync(PRAZO_ESCRITA_NEGOCIO_MS);
    const erro = expect.objectContaining({ error: "lead_write_outcome_unknown", resultado_incerto: true });
    expect(await edicao).toEqual(erro);
    expect(await movimento).toEqual(erro);
    expect(sb.leiturasEtapa).toBe(0);
    expect(await montar(sb).crm_move_lead_stage!.execute!(mover, options)).toEqual(erro);
    expect(vi.mocked(auditMcpToolCall).mock.calls.map(([a]) => [a.success, a.errorMessage])).toEqual([
      [false, "lead_write_outcome_unknown"],
      [false, "lead_write_outcome_unknown"],
      [false, "lead_write_outcome_unknown"],
    ]);
    sb.liberaEdicao.liberar();
    await vi.advanceTimersByTimeAsync(0);
    // Efeito tardio e auditoria nativa podem existir; a resposta nunca alegou cancelamento.
    expect(vi.mocked(audit).mock.calls.map(([a]) => a.action)).toEqual(["lead.updated"]);
    expect(sb.lead.stage_id).toBe("origem");
    expect(await montar(sb).crm_move_lead_stage!.execute!(mover, options)).toHaveProperty("lead");
    expect(sb.lead.stage_id).toBe(ETAPA);
  });
});

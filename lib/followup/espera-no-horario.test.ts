/**
 * A espera que só termina em horário comercial (`wait.ate_o_horario`).
 *
 * Medido numa instalação real: o fluxo "boas-vindas → 24 h
 * → lembrete → 48 h → último toque" mandaria o lembrete à MESMA hora do
 * formulário — quem se cadastrou às 2h recebe às 2h. A janela do canal não serve
 * (seguraria também a boas-vindas, que tem de sair na hora) e a faixa do agente
 * vale para a inscrição inteira. A régua certa mora na espera.
 *
 * Os instantes usam America/Sao_Paulo (UTC-3 fixo, sem horário de verão desde
 * 2019) para as contas exatas; o caso de Manaus confere a hora LOCAL do
 * resultado pelo próprio `Intl`, num fuso que não é o de São Paulo — o fuso que
 * conta é o que chega, nunca um fixo do código.
 */
import { describe, expect, it } from "vitest";

import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "./engine";
import {
  horarioDaEsperaValido,
  janelaDaEspera,
  primeiroInstanteNoHorario,
  type HorarioDaEspera,
} from "./espera-no-horario";
import { flowGraphSchema, waitConfigSchema, type FlowEdge, type FlowGraph, type FlowNode } from "./graph-schema";
import { processNode, type EnrollmentRow, type LeadFacts } from "./node-handlers";
import { validateFlowForPublish } from "./validate-publish";

const SP = "America/Sao_Paulo";
/** Segunda a sexta, 9h às 18h — dado sintético. */
const COMERCIAL: HorarioDaEspera = { start: "09:00", end: "18:00", weekdays: [1, 2, 3, 4, 5] };
const H = 3_600_000;

/** Hora local `HH:MM` e dia da semana (Mon…Sun) de um instante num fuso. */
function local(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instante);
}

describe("primeiroInstanteNoHorario — a conta do calendário", () => {
  const janela = janelaDaEspera(COMERCIAL, SP);

  it("dentro do horário, o instante não muda", () => {
    const terca15h = new Date("2026-10-27T18:00:00.000Z"); // ter 15:00 em SP
    expect(primeiroInstanteNoHorario(terca15h, janela)).toEqual(terca15h);
  });

  it("de noite, vai para as 9h do dia seguinte", () => {
    const terca2230 = new Date("2026-10-28T01:30:00.000Z"); // ter 22:30 em SP
    expect(primeiroInstanteNoHorario(terca2230, janela).toISOString()).toBe("2026-10-28T12:00:00.000Z"); // qua 09:00
  });

  it("de madrugada, vai para as 9h do mesmo dia", () => {
    const quarta0615 = new Date("2026-10-28T09:15:00.000Z"); // qua 06:15 em SP
    expect(primeiroInstanteNoHorario(quarta0615, janela).toISOString()).toBe("2026-10-28T12:00:00.000Z");
  });

  it("sexta à noite pula o fim de semana fechado e vai para segunda 9h", () => {
    const sexta21h = new Date("2026-10-31T00:00:00.000Z"); // sex 21:00 em SP
    expect(primeiroInstanteNoHorario(sexta21h, janela).toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });

  it("domingo, dia fechado, vai para segunda 9h", () => {
    const domingo10h = new Date("2026-11-01T13:00:00.000Z");
    expect(primeiroInstanteNoHorario(domingo10h, janela).toISOString()).toBe("2026-11-02T12:00:00.000Z");
  });

  it("o fim é exclusivo: 18:00 em ponto já está fechado", () => {
    const quarta18h = new Date("2026-10-28T21:00:00.000Z");
    expect(primeiroInstanteNoHorario(quarta18h, janela).toISOString()).toBe("2026-10-29T12:00:00.000Z");
  });

  it("sem horário, devolve o mesmo instante (a espera de sempre)", () => {
    const qualquer = new Date("2026-11-01T05:00:00.000Z");
    expect(primeiroInstanteNoHorario(qualquer, janelaDaEspera(undefined, SP))).toEqual(qualquer);
  });

  it("horário que não dá para obedecer falha ABERTO: nenhuma janela, o instante não muda", () => {
    const torto = { start: "18:00", end: "09:00", weekdays: [1] };
    const semDia = { start: "09:00", end: "18:00", weekdays: [] };
    expect(janelaDaEspera(torto, SP)).toBeNull();
    expect(janelaDaEspera(semDia, SP)).toBeNull();
    expect(horarioDaEsperaValido(torto)).toBe(false);
    expect(horarioDaEsperaValido(semDia)).toBe(false);
    expect(horarioDaEsperaValido({ start: "9h", end: "18:00", weekdays: [1] })).toBe(false);
    expect(horarioDaEsperaValido(COMERCIAL)).toBe(true);
  });

  it("fuso inútil cai no padrão do produto, como o resto do follow-up", () => {
    const sexta21h = new Date("2026-10-31T00:00:00.000Z");
    expect(primeiroInstanteNoHorario(sexta21h, janelaDaEspera(COMERCIAL, "Marte/Olimpo"))).toEqual(
      primeiroInstanteNoHorario(sexta21h, janelaDaEspera(COMERCIAL, SP)),
    );
  });

  it("Manaus: formulário no sábado às 2h + 24 h cai no domingo e vai para segunda 09:00 local", () => {
    const fuso = "America/Manaus";
    // Sábado 31/10 às 02:00 em Manaus — a guarda abaixo confere pelo `Intl`.
    const sabado2h = new Date("2026-10-31T06:00:00.000Z");
    expect(local(sabado2h, fuso)).toMatch(/^Sat,? 02:00$/);
    const fim = primeiroInstanteNoHorario(new Date(sabado2h.getTime() + 24 * H), janelaDaEspera(COMERCIAL, fuso));
    expect(local(fim, fuso)).toMatch(/^Mon,? 09:00$/);
  });
});

// ─── no motor: o nó de espera ───────────────────────────────────────────────

function inscricao(over: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: "enr-1", organization_id: "org-1", pointer_id: "ptr-1", version_id: "ver-1", contact_id: "contact-1",
    conversation_id: null, current_node_id: "espera", status: "active", next_eval_at: "2026-10-31T05:00:00.000Z",
    claimed_until: null, attempts: 0, max_attempts: 5, last_error: null, steps_taken: 3, outcome: null,
    cancel_reason: null, started_at: "2026-10-31T05:00:00.000Z", completed_at: null, updated_at: "2026-10-31T05:00:00.000Z",
    ...over,
  };
}
const lead = (over: Partial<LeadFacts> = {}): LeadFacts => ({ lead_stage: null, tags: [], steps_taken: 3, last_outcome: null, fuso: SP, ...over });
const espera = (config: Record<string, unknown>) => ({ id: "espera", type: "wait", label: "Espera", position: { x: 0, y: 0 }, config }) as unknown as FlowNode;
const ARESTAS: FlowEdge[] = [{ id: "e", source: "espera", target: "envio", priority: 0, condition: { type: "always" } }];

describe("processNode — espera com horário", () => {
  const sabado2h = new Date("2026-10-31T05:00:00.000Z"); // sáb 02:00 em SP

  it("na ENTRADA, o fim que cai no domingo já é gravado para segunda 09:00", () => {
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => sabado2h, waitElapsed: false,
    });
    expect(r).toEqual({ kind: "wait", next_eval_at: new Date("2026-11-02T12:00:00.000Z") });
  });

  it("controle: sem horário, a espera é a duração crua (domingo 02:00)", () => {
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => sabado2h, waitElapsed: false,
    });
    expect(r).toEqual({ kind: "wait", next_eval_at: new Date(sabado2h.getTime() + 24 * H) });
  });

  it("fim dentro do horário não muda nada", () => {
    const terca10h = new Date("2026-10-27T13:00:00.000Z");
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => terca10h, waitElapsed: false,
    });
    expect(r).toEqual({ kind: "wait", next_eval_at: new Date(terca10h.getTime() + 24 * H) });
  });

  it("na SAÍDA fora do horário (pausa retomada, adiamento), continua esperando até a abertura", () => {
    const domingo10h = new Date("2026-11-01T13:00:00.000Z");
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => domingo10h, waitElapsed: true,
    });
    expect(r).toEqual({ kind: "wait", next_eval_at: new Date("2026-11-02T12:00:00.000Z") });
  });

  it("na saída dentro do horário, avança", () => {
    const segunda9h = new Date("2026-11-02T12:00:30.000Z");
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => segunda9h, waitElapsed: true,
    });
    expect(r).toEqual({ kind: "advance", next_node_id: "envio", next_eval_at: segunda9h });
  });

  it("a resposta do cliente corta a espera mesmo de noite: o horário segura o toque proativo, não a resposta", () => {
    const domingo10h = new Date("2026-11-01T13:00:00.000Z");
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => domingo10h, waitElapsed: false, wokeEarly: true,
    });
    expect(r).toEqual({ kind: "advance", next_node_id: "envio", next_eval_at: domingo10h });
  });

  it("espera imune com horário continua dormindo e alinhada", () => {
    const r = processNode({
      node: espera({ mode: "fixed", duration_ms: 24 * H, immune_to_reply: true, ate_o_horario: COMERCIAL }),
      edges: ARESTAS, enrollment: inscricao(), lead: lead(), clock: () => sabado2h, waitElapsed: false,
    });
    expect(r).toEqual({ kind: "wait", next_eval_at: new Date("2026-11-02T12:00:00.000Z"), wake_status: "dormente" });
  });
});

describe("motor — o fuso da organização chega à espera com horário", () => {
  const sabado2h = new Date("2026-10-31T05:00:00.000Z");
  const grafo = (comHorario: boolean) =>
    ({
      nodes: [
        { id: "inicio", type: "trigger", config: {} },
        { id: "espera", type: "wait", config: { mode: "fixed", duration_ms: 24 * H, ...(comHorario ? { ate_o_horario: COMERCIAL } : {}) } },
        { id: "envio", type: "action", config: { mode: "text", body: "oi" } },
        { id: "fim", type: "end", config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e1", source: "inicio", target: "espera", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "espera", target: "envio", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "envio", target: "fim", priority: 0, condition: { type: "always" } },
      ],
    }) as unknown as FlowGraph;

  function montar(comHorario: boolean) {
    const patches: Record<string, unknown>[] = [];
    const fusosPedidos: string[] = [];
    const db = {
      loadFlowGraph: async () => grafo(comHorario),
      loadLeadFacts: async () => ({ lead_stage: null, tags: [] }),
      loadFusoDaOrganizacao: async (org: string) => {
        fusosPedidos.push(org);
        return SP;
      },
      loadEnrollmentEvents: async () => [],
      loadFlowPointerName: async () => "Fluxo",
      insertEnrollmentEvent: async () => ({ inserted: true }),
      updateEnrollment: async (_id: string, _org: string, patch: Record<string, unknown>) => {
        patches.push(patch);
      },
      insertDeadInboxItem: async () => {},
    } as unknown as AdminClient;
    return { db, patches, fusosPedidos };
  }

  it("com horário, o motor lê o fuso da organização e grava a abertura de segunda 09:00", async () => {
    const { db, patches, fusosPedidos } = montar(true);
    const deps: TickDeps = { db, clock: () => sabado2h, enqueueJob: async () => {} };
    await avancarEnrollmentAtivo(deps, inscricao());
    expect(fusosPedidos).toEqual(["org-1"]);
    expect(patches.at(-1)?.next_eval_at).toBe("2026-11-02T12:00:00.000Z");
  });

  it("controle: sem horário (e sem regra de data), o fuso nem é lido", async () => {
    const { db, patches, fusosPedidos } = montar(false);
    const deps: TickDeps = { db, clock: () => sabado2h, enqueueJob: async () => {} };
    await avancarEnrollmentAtivo(deps, inscricao());
    expect(fusosPedidos).toEqual([]);
    expect(patches.at(-1)?.next_eval_at).toBe(new Date(sabado2h.getTime() + 24 * H).toISOString());
  });
});

// ─── esquema e publicação ───────────────────────────────────────────────────

describe("esquema — o rascunho aceita, a publicação exige", () => {
  it("espera fixa aceita o horário; a adaptativa recusa a chave", () => {
    expect(waitConfigSchema.safeParse({ mode: "fixed", duration_ms: 24 * H, ate_o_horario: COMERCIAL }).success).toBe(true);
    expect(waitConfigSchema.safeParse({ mode: "smart", min_ms: H, max_ms: 2 * H, ate_o_horario: COMERCIAL }).success).toBe(false);
  });

  it("o rascunho aceita o horário torto (o painel grava a cada clique)", () => {
    expect(waitConfigSchema.safeParse({ mode: "fixed", duration_ms: H, ate_o_horario: { start: "18:00", end: "09:00", weekdays: [] } }).success).toBe(true);
  });

  const grafo = (horario: HorarioDaEspera) =>
    flowGraphSchema.parse({
      nodes: [
        { id: "inicio", type: "trigger", label: "Início", position: { x: 0, y: 0 }, config: {} },
        { id: "espera", type: "wait", label: "Espera", position: { x: 1, y: 0 }, config: { mode: "fixed", duration_ms: 24 * H, ate_o_horario: horario } },
        { id: "envio", type: "action", label: "Envio", position: { x: 2, y: 0 }, config: { mode: "text", body: "oi" } },
        { id: "fim", type: "end", label: "Fim", position: { x: 3, y: 0 }, config: { outcome: "exhausted" } },
      ],
      edges: [
        { id: "e1", source: "inicio", target: "espera", priority: 0, condition: { type: "always" } },
        { id: "e2", source: "espera", target: "envio", priority: 0, condition: { type: "always" } },
        { id: "e3", source: "envio", target: "fim", priority: 0, condition: { type: "always" } },
      ],
    });
  const codigos = (g: FlowGraph) => {
    const v = validateFlowForPublish(g);
    return v.ok ? [] : v.errors.map((e) => `${e.node_id}:${e.code}`);
  };

  it("horário que dá para obedecer publica", () => {
    expect(codigos(grafo(COMERCIAL))).toEqual([]);
  });

  it("início depois do fim e semana vazia não publicam, ancorados no nó", () => {
    expect(codigos(grafo({ start: "18:00", end: "09:00", weekdays: [1] }))).toEqual(["espera:horario_da_espera_invalido"]);
    expect(codigos(grafo({ start: "09:00", end: "18:00", weekdays: [] }))).toEqual(["espera:horario_da_espera_invalido"]);
  });
});

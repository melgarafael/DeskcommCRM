import { describe, expect, it } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { EnabledFollowupAgent, FollowupGateDb } from "./agent-followup-gate";
import {
  EVENTO_CASO_ABERTO,
  EVENTO_CASO_FECHADO,
  IDADE_MAXIMA_MS,
  aplicaGatilhoDeCaso,
  type GatilhoCasoDb,
  type PointerDeCaso,
} from "./gatilho-caso";

/**
 * A DECISÃO do gatilho de caso, isolada do banco: quando ignora, quando enrolla,
 * quando cancela e o que grava de proveniência. As garantias que só o Postgres
 * pode dar — o índice de um-vivo-por-contato, o gate contra `ai_agent_versions`
 * real, o trigger que emite — vivem no invariante, porque um fake que devolve
 * `inserted:false` prova apenas que o código lê a própria fixture.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER = "22222222-2222-2222-2222-222222222222";
const AGENT = "33333333-3333-3333-3333-333333333333";
const CONVERSA = "44444444-4444-4444-4444-444444444444";
const CONTATO = "55555555-5555-5555-5555-555555555555";
const CASO = "66666666-6666-6666-6666-666666666666";
const VERSION = "99999999-9999-9999-9999-999999999999";
const ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const AGORA = new Date("2026-08-11T12:00:00.000Z");

interface Registro {
  contatoConsultado: number;
  enrollments: Array<Record<string, unknown>>;
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
  cancelados: string[];
}

function registro(): Registro {
  return { contatoConsultado: 0, enrollments: [], eventos: [], cancelados: [] };
}

function fakeDb(opts: {
  pointers?: PointerDeCaso[];
  contato?: string | null;
  noDeGatilho?: string | null;
  jaVivo?: boolean;
  stale?: boolean;
  vivos?: Array<{ id: string; current_node_id: string | null }>;
  cancelaFalha?: boolean;
  reg: Registro;
}): GatilhoCasoDb {
  return {
    async carregaPointersDeCaso() {
      return opts.pointers ?? [{ id: POINTER, organization_id: ORG, active_version_id: VERSION }];
    },
    async carregaContatoDaConversa() {
      opts.reg.contatoConsultado++;
      return opts.contato === undefined ? CONTATO : opts.contato;
    },
    async carregaNoDeGatilho() {
      return opts.noDeGatilho === undefined ? "t1" : opts.noDeGatilho;
    },
    async insereEnrollment(input) {
      if (opts.stale) return { inserted: false, id: null, reason: "stale_origin" };
      if (opts.jaVivo) return { inserted: false, id: null };
      opts.reg.enrollments.push(input as unknown as Record<string, unknown>);
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment(evento) {
      opts.reg.eventos.push({
        event_type: evento.event_type,
        payload: evento.payload,
        idempotency_key: evento.idempotency_key,
      });
    },
    async carregaVivosDoCaso() {
      return opts.vivos ?? [];
    },
    async cancelaEnrollment(_org, id) {
      if (opts.cancelaFalha) return false;
      opts.reg.cancelados.push(id);
      return true;
    },
  };
}

function fakeGate(agentes: EnabledFollowupAgent[]): FollowupGateDb {
  return {
    async loadEnabledPublishedFollowupAgents() {
      return agentes;
    },
  };
}

const AGENTE_PUBLICADO: EnabledFollowupAgent = { agentId: AGENT, pointerIds: [POINTER] };

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: EVENTO_CASO_ABERTO,
    entity_kind: "agent_case",
    entity_id: CASO,
    payload: {
      case_id: CASO,
      conversation_id: CONVERSA,
      contact_id: CONTATO,
      source: "agent",
      status: "awaiting_human",
    },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: AGORA.toISOString(),
    ...over,
  };
}

function deps(db: GatilhoCasoDb, gate = fakeGate([AGENTE_PUBLICADO])) {
  return { db, gateDb: gate, clock: () => AGORA };
}

describe("gatilho de caso — abertura", () => {
  it("enrolla e grava a proveniência com o caso e a conversa", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg })), evento());

    expect(s.enrolled).toBe(1);
    expect(s.matched).toBe(true);

    // ⚠️ ESTE PRODUTOR É O PRIMEIRO DO REPO A ESCREVER `conversation_id`. A
    // coluna existia desde a 0054, era LIDA pelo motor, e ninguém gravava. Sem
    // ela o cancelamento pelo fechamento não teria por onde achar a linha.
    expect(reg.enrollments[0]).toMatchObject({
      conversation_id: CONVERSA,
      contact_id: CONTATO,
      agent_id: AGENT,
    });
    // `next_eval_at` não pode ir: o "agora" do processo é FUTURO para o now()
    // do Postgres e o claim pularia o tick (migration 0147).
    expect(reg.enrollments[0]).not.toHaveProperty("next_eval_at");

    expect(reg.eventos[0]?.event_type).toBe("enrolled_by_case_opened");
    expect(reg.eventos[0]?.payload).toMatchObject({ case_id: CASO, source: "agent" });
  });

  it("usa o contato do PAYLOAD e não vai ao banco por ele", async () => {
    const reg = registro();
    await aplicaGatilhoDeCaso(deps(fakeDb({ reg })), evento());
    expect(reg.contatoConsultado, "o payload do trigger já traz o contato").toBe(0);
  });

  it("cai no banco quando o payload não traz contato", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(
      deps(fakeDb({ reg })),
      evento({ payload: { case_id: CASO, conversation_id: CONVERSA } }),
    );
    expect(reg.contatoConsultado).toBe(1);
    expect(s.enrolled).toBe(1);
  });

  it("conversa sem contato é CONTADA, não engolida", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(
      deps(fakeDb({ reg, contato: null })),
      evento({ payload: { case_id: CASO, conversation_id: CONVERSA } }),
    );
    expect(s.sem_contato).toBe(1);
    expect(s.enrolled).toBe(0);
  });

  it("sem agente publicado o gate barra, e o barramento aparece no resumo", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg }), fakeGate([])), evento());
    expect(s.pointers_barrados_pelo_gate).toBe(1);
    expect(s.enrolled).toBe(0);
  });

  it("contato já vivo em outro fluxo vira skip, nunca erro", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg, jaVivo: true })), evento());
    expect(s.skipped_existing).toBe(1);
    expect(s.enrolled).toBe(0);
  });

  it("evento sem conversa não é do meu feitio — matched:false", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg })), evento({ payload: { case_id: CASO } }));
    expect(s.matched).toBe(false);
    expect(s.enrolled).toBe(0);
  });
});

describe("gatilho de caso — teto de idade", () => {
  /**
   * O drain leva 50 por tick e não tem janela de recência: tipo sem handler fica
   * `pending` para sempre. Se a migration subir antes do código, o primeiro
   * drain enrollaria casos de dias atrás de uma vez.
   */
  it("evento além do teto é DESCARTADO e contado em vencidos", async () => {
    const reg = registro();
    const velho = new Date(AGORA.getTime() - IDADE_MAXIMA_MS - 1_000).toISOString();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg })), evento({ created_at: velho }));

    expect(s.vencidos, "descartar é decisão, e decisão aparece no resumo").toBe(1);
    expect(s.enrolled).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("evento dentro do teto passa (o limite não é decorativo dos dois lados)", async () => {
    const reg = registro();
    const quase = new Date(AGORA.getTime() - IDADE_MAXIMA_MS + 60_000).toISOString();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg })), evento({ created_at: quase }));
    expect(s.enrolled).toBe(1);
    expect(s.vencidos).toBe(0);
  });

  it("SEM created_at o evento passa — falhar aberto na informação", async () => {
    // `EventRow.created_at` é opcional (26 arquivos constroem fixtures). Sem a
    // idade não dá para AFIRMAR que o evento é velho, e descartar na dúvida
    // perderia um evento bom. O caminho de produção sempre traz o campo.
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(deps(fakeDb({ reg })), evento({ created_at: undefined }));
    expect(s.enrolled).toBe(1);
    expect(s.vencidos).toBe(0);
  });
});

describe("gatilho de caso — fechamento", () => {
  it("cancela o que nasceu do caso e grava por quê", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(
      deps(fakeDb({ reg, vivos: [{ id: ENROLLMENT, current_node_id: "n2" }] })),
      evento({ event_type: EVENTO_CASO_FECHADO, payload: { case_id: CASO, conversation_id: CONVERSA, status: "resolved" } }),
    );

    expect(s.cancelados).toBe(1);
    expect(reg.cancelados).toEqual([ENROLLMENT]);
    expect(reg.eventos[0]?.event_type).toBe("cancelled_by_case_closed");
    expect(reg.eventos[0]?.payload).toMatchObject({ status_do_caso: "resolved" });
  });

  it("não cancela nada quando não há follow-up nascido de caso", async () => {
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(
      deps(fakeDb({ reg, vivos: [] })),
      evento({ event_type: EVENTO_CASO_FECHADO, payload: { case_id: CASO, conversation_id: CONVERSA } }),
    );
    expect(s.cancelados).toBe(0);
    expect(reg.eventos).toHaveLength(0);
  });

  it("perdeu a corrida com o motor: não conta como cancelado nem grava evento", async () => {
    // `cancelaEnrollment` devolve false quando o UPDATE não casa a linha — o
    // tick concluiu o enrollment entre a leitura e a escrita. Contar assim mesmo
    // faria o resumo afirmar um efeito que não houve.
    const reg = registro();
    const s = await aplicaGatilhoDeCaso(
      deps(fakeDb({ reg, vivos: [{ id: ENROLLMENT, current_node_id: null }], cancelaFalha: true })),
      evento({ event_type: EVENTO_CASO_FECHADO, payload: { case_id: CASO, conversation_id: CONVERSA } }),
    );
    expect(s.cancelados).toBe(0);
    expect(reg.eventos).toHaveLength(0);
  });

  it("o teto de idade NÃO vale para o fechamento", async () => {
    // Cancelar tarde é melhor que não cancelar: o efeito de um fechamento velho
    // é PARAR de incomodar alguém, nunca começar.
    const reg = registro();
    const velho = new Date(AGORA.getTime() - IDADE_MAXIMA_MS * 48).toISOString();
    const s = await aplicaGatilhoDeCaso(
      deps(fakeDb({ reg, vivos: [{ id: ENROLLMENT, current_node_id: "n2" }] })),
      evento({
        event_type: EVENTO_CASO_FECHADO,
        created_at: velho,
        payload: { case_id: CASO, conversation_id: CONVERSA },
      }),
    );
    expect(s.cancelados).toBe(1);
    expect(s.vencidos).toBe(0);
  });
});


it("origem obsoleta não é contabilizada como enrollment existente", async () => {
  const reg = registro();
  const result = await aplicaGatilhoDeCaso(deps(fakeDb({ reg, stale: true })), evento());
  expect(result.skipped_stale_origin).toBe(1);
  expect(result.skipped_existing).toBe(0);
  expect(reg.enrollments).toEqual([]);
});

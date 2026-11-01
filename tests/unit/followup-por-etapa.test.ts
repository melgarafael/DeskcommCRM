import { describe, expect, it } from "vitest";

import { getRegisteredHandlers, type EventRow } from "@/lib/event-log/dispatcher";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";
import type { EnabledFollowupAgent, FollowupGateDb } from "@/lib/followup/agent-followup-gate";
import {
  EVENTO_DE_ETAPA,
  aplicaGatilhoDeEtapa,
  type GatilhoEtapaDb,
  type PointerDeEtapa,
} from "@/lib/followup/gatilho-etapa";
import {
  EVENTO_DE_SAIDA,
  MOTIVO_DA_SAIDA,
  aplicaSaidaDaEtapa,
  type InscricaoAlcancavel,
  type PointerDaSaida,
  type SaidaDaEtapaDb,
} from "@/lib/followup/saida-da-etapa";

/**
 * A TABELA DO FOLLOW-UP POR ETAPA — as duas metades do mesmo fato, num arquivo.
 *
 * O que este teste congela é o EFEITO POR ETAPA, não a implementação de um
 * módulo: o card ENTRA na etapa marcada e o toque nasce (metade que já estava na
 * `main`, `gatilho-etapa.ts`), o card SAI da etapa e o toque pendente morre
 * (metade desta entrega, `saida-da-etapa.ts`), e — o mais importante — nada
 * acontece quando a etapa não está marcada ou a organização não configurou
 * follow-up nenhum.
 *
 * ⚠️ POR QUE OS CASOS DE ENTRADA MORAM AQUI. Eles já têm casa própria em
 * `lib/followup/gatilho-etapa.test.ts`. Ficam repetidos de propósito, em versão
 * mínima, porque a régua da fatia é a TABELA ("agenda 1 toque", "não agenda",
 * "não duplica") e uma régua partida em dois arquivos deixa de ser régua: quem
 * revisar a fatia precisa ver o ciclo inteiro num lugar só, com as duas metades
 * lado a lado. O que é garantia de banco (índice único, gate contra
 * `ai_agent_versions` real) continua onde estava, em `tests/invariants/`.
 *
 * O que o fake NÃO prova: o índice `idx_followup_enrollments_one_live`, o CHECK
 * de status e o UPDATE com guarda contra Postgres. Um fake que devolve
 * `inserted:false` prova só que o código lê a própria fixture — a prova de
 * banco é a da fatia irmã, e este arquivo não a substitui.
 */

const ORG = "11111111-1111-1111-1111-111111111111";
const POINTER = "22222222-2222-2222-2222-222222222222";
const OUTRO_POINTER = "22222222-2222-2222-2222-2222222222aa";
const NEGOCIO = "44444444-4444-4444-4444-444444444444";
const CONTATO = "55555555-5555-5555-5555-555555555555";
const ETAPA_MARCADA = "66666666-6666-6666-6666-666666666666";
const ETAPA_NEUTRA = "77777777-7777-7777-7777-777777777777";
const ETAPA_PERDA = "88888888-8888-8888-8888-888888888888";
const VERSION = "99999999-9999-9999-9999-999999999999";
const ENROLLMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENROLLMENT_2 = "aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb";

const CLOCK = () => new Date("2026-10-28T15:00:00.000Z");

function evento(over: Partial<EventRow> = {}): EventRow {
  return {
    id: "e0000000-0000-4000-8000-000000000001",
    organization_id: ORG,
    event_type: EVENTO_DE_ETAPA,
    entity_kind: "crm_lead",
    entity_id: NEGOCIO,
    payload: { from_stage_id: ETAPA_MARCADA, to_stage_id: ETAPA_NEUTRA },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    ...over,
  };
}

// ───────────────────────────── metade ENTRADA ──────────────────────────────

interface RegEntrada {
  contatoConsultado: number;
  enrollments: unknown[];
  eventos: string[];
}

function fakeEntrada(opts: {
  pointers?: PointerDeEtapa[];
  jaVivo?: boolean;
  reg: RegEntrada;
}): GatilhoEtapaDb {
  return {
    async carregaPointersDeEtapa() {
      return opts.pointers ?? [];
    },
    async carregaContatoDoNegocio() {
      opts.reg.contatoConsultado += 1;
      return CONTATO;
    },
    async carregaNoDeGatilho() {
      return { id: "t1", pedeAgente: false };
    },
    async insereEnrollment(input) {
      if (opts.jaVivo) return { inserted: false, id: null };
      opts.reg.enrollments.push(input);
      return { inserted: true, id: ENROLLMENT };
    },
    async insereEventoDoEnrollment(e) {
      opts.reg.eventos.push(e.event_type);
    },
  };
}

function fakeGate(): FollowupGateDb {
  const vazio: EnabledFollowupAgent[] = [];
  return {
    async loadEnabledPublishedFollowupAgents() {
      return vazio;
    },
  };
}

const pointerEntrada: PointerDeEtapa = {
  id: POINTER,
  organization_id: ORG,
  active_version_id: VERSION,
  stage_id: ETAPA_MARCADA,
};

async function entrada(opts: { pointers?: PointerDeEtapa[]; jaVivo?: boolean; over?: Partial<EventRow> }) {
  const reg: RegEntrada = { contatoConsultado: 0, enrollments: [], eventos: [] };
  const summary = await aplicaGatilhoDeEtapa(
    { db: fakeEntrada({ pointers: opts.pointers, jaVivo: opts.jaVivo, reg }), gateDb: fakeGate(), clock: CLOCK },
    // entrar na ETAPA_MARCADA
    evento({ payload: { from_stage_id: ETAPA_NEUTRA, to_stage_id: ETAPA_MARCADA }, ...opts.over }),
  );
  return { summary, reg };
}

// ────────────────────────────── metade SAÍDA ───────────────────────────────

interface RegSaida {
  pointersPorEtapa: Array<{ org: string; etapa: string }>;
  contatoConsultado: number;
  contatoPassado: string[];
  inscricoesPassadas: string[][];
  canceladas: Array<{ id: string; patch: Record<string, unknown> }>;
  eventos: Array<{ event_type: string; payload: Record<string, unknown>; idempotency_key: string }>;
}

function registroSaida(): RegSaida {
  return {
    pointersPorEtapa: [],
    contatoConsultado: 0,
    contatoPassado: [],
    inscricoesPassadas: [],
    canceladas: [],
    eventos: [],
  };
}

function fakeSaida(opts: {
  pointers?: PointerDaSaida[];
  inscricoes?: InscricaoAlcancavel[];
  contato?: string | null;
  jaInserido?: boolean;
  cancelamentoConcorrente?: boolean;
  reg: RegSaida;
}): SaidaDaEtapaDb {
  return {
    async carregaPointersDaEtapa(org, etapa) {
      opts.reg.pointersPorEtapa.push({ org, etapa });
      return opts.pointers ?? [];
    },
    async carregaContatoDoNegocio(org, lead) {
      opts.reg.contatoConsultado += 1;
      opts.reg.contatoPassado.push(`${org}/${lead}`);
      return opts.contato === undefined ? CONTATO : opts.contato;
    },
    async carregaInscricoesVivas(org, contato, pointerIds) {
      opts.reg.inscricoesPassadas.push([...pointerIds]);
      return (opts.inscricoes ?? []).filter((i) => pointerIds.includes(i.pointer_id));
    },
    async insereEventoDoEnrollment(e) {
      if (opts.jaInserido) return { inserted: false };
      opts.reg.eventos.push({
        event_type: e.event_type,
        payload: e.payload,
        idempotency_key: e.idempotency_key,
      });
      return { inserted: true };
    },
    async cancelaInscricao(id, _org, patch) {
      if (opts.cancelamentoConcorrente) return false;
      opts.reg.canceladas.push({ id, patch: patch as Record<string, unknown> });
      return true;
    },
  };
}

const pointerDaSaida: PointerDaSaida = { id: POINTER, stage_id: ETAPA_MARCADA };

function inscricao(over: Partial<InscricaoAlcancavel> = {}): InscricaoAlcancavel {
  return { id: ENROLLMENT, pointer_id: POINTER, status: "active", current_node_id: "w1", ...over };
}

async function saida(opts: {
  pointers?: PointerDaSaida[];
  inscricoes?: InscricaoAlcancavel[];
  contato?: string | null;
  jaInserido?: boolean;
  cancelamentoConcorrente?: boolean;
  over?: Partial<EventRow>;
}) {
  const reg = registroSaida();
  const summary = await aplicaSaidaDaEtapa(
    {
      db: fakeSaida({
        pointers: opts.pointers ?? [pointerDaSaida],
        inscricoes: opts.inscricoes ?? [inscricao()],
        contato: opts.contato,
        jaInserido: opts.jaInserido,
        cancelamentoConcorrente: opts.cancelamentoConcorrente,
        reg,
      }),
      clock: CLOCK,
    },
    evento(opts.over),
  );
  return { summary, reg };
}

// ═══════════════════════════════ TABELA ════════════════════════════════════

describe("follow-up por etapa — ENTRADA: mover para a etapa marcada agenda o toque", () => {
  it("⭐ mover para a etapa marcada agenda exatamente 1 toque", async () => {
    const { summary, reg } = await entrada({ pointers: [pointerEntrada] });
    expect(summary.enrolled).toBe(1);
    expect(reg.enrollments).toHaveLength(1);
    expect(reg.enrollments[0]).toMatchObject({ pointer_id: POINTER, contact_id: CONTATO });
    expect(reg.eventos).toEqual(["enrolled_by_stage_change"]);
  });

  it("etapa NÃO marcada não agenda nada — e nem consulta o negócio (controle)", async () => {
    const { summary, reg } = await entrada({ pointers: [] });
    expect(summary.matched).toBe(true);
    expect(summary.enrolled).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
    // o corte acontece ANTES da ida ao banco que busca o contato do negócio
    expect(reg.contatoConsultado).toBe(0);
  });

  it("⭐ organização sem follow-up configurado não muda de comportamento (controle)", async () => {
    const { summary, reg } = await entrada({});
    expect(summary).toMatchObject({ matched: true, pointers_armados: 0, enrolled: 0 });
    expect(reg.contatoConsultado).toBe(0);
    expect(reg.enrollments).toHaveLength(0);
  });

  it("⭐ voltar à etapa duas vezes não duplica o toque (idempotência)", async () => {
    const { summary, reg } = await entrada({ pointers: [pointerEntrada], jaVivo: true });
    expect(summary.enrolled).toBe(0);
    expect(summary.skipped_existing).toBe(1);
    expect(reg.enrollments).toHaveLength(0);
    expect(reg.eventos).toHaveLength(0);
  });
});

describe("follow-up por etapa — SAÍDA: sair da etapa cancela o toque pendente", () => {
  it("⭐ sair da etapa cancela o toque pendente", async () => {
    const { summary, reg } = await saida({});
    expect(summary.matched).toBe(true);
    expect(summary.canceladas).toBe(1);
    expect(reg.canceladas).toHaveLength(1);
    expect(reg.canceladas[0]).toMatchObject({
      id: ENROLLMENT,
      patch: {
        status: "cancelled",
        cancel_reason: MOTIVO_DA_SAIDA,
        next_eval_at: null,
        claimed_until: null,
        completed_at: "2026-10-28T15:00:00.000Z",
      },
    });
  });

  it("cancela também a espera por resposta (`waiting_reply`)", async () => {
    const { summary, reg } = await saida({ inscricoes: [inscricao({ status: "waiting_reply" })] });
    expect(summary.canceladas).toBe(1);
    expect(reg.canceladas).toHaveLength(1);
  });

  it("cancela também a espera longa adormecida (`dormente`)", async () => {
    const { summary, reg } = await saida({ inscricoes: [inscricao({ status: "dormente" })] });
    expect(summary.canceladas).toBe(1);
    expect(reg.canceladas).toHaveLength(1);
  });

  it("mover para etapa de PERDA cancela igual: o toque da etapa de origem morre", async () => {
    const { summary } = await saida({ over: { payload: { from_stage_id: ETAPA_MARCADA, to_stage_id: ETAPA_PERDA } } });
    expect(summary.canceladas).toBe(1);
  });

  it("a proveniência `cancelled_by_stage_change` guarda o negócio e as duas etapas", async () => {
    const { reg } = await saida({});
    expect(reg.eventos).toHaveLength(1);
    expect(reg.eventos[0]).toMatchObject({
      event_type: EVENTO_DE_SAIDA,
      idempotency_key: `saida-da-etapa:e0000000-0000-4000-8000-000000000001:${ENROLLMENT}`,
      payload: {
        lead_id: NEGOCIO,
        from_stage_id: ETAPA_MARCADA,
        to_stage_id: ETAPA_NEUTRA,
        pointer_id: POINTER,
      },
    });
  });

  it("⭐ o próprio fluxo movendo o card NÃO cancela a si mesmo", async () => {
    // O nó `move_lead` grava `metadata.actor_id = followup:<enrollment>` no
    // `lead.stage_changed`; sem o corte, o toque morreria por ter sido obedecido.
    const { summary, reg } = await saida({
      over: { metadata: { actor_type: "webhook_source", actor_id: `followup:${ENROLLMENT}` } },
    });
    expect(summary.matched).toBe(true);
    expect(summary.inscricoes_encontradas).toBe(1);
    expect(summary.proprio_ator).toBe(1);
    expect(summary.canceladas).toBe(0);
    expect(reg.canceladas).toHaveLength(0);
    // nem a proveniência da saída é gravada: nada aconteceu com esta inscrição
    expect(reg.eventos).toHaveLength(0);
  });

  it("o ator poupa só a PRÓPRIA inscrição — o outro fluxo do mesmo contato cai", async () => {
    const { summary, reg } = await saida({
      pointers: [pointerDaSaida, { id: OUTRO_POINTER, stage_id: ETAPA_MARCADA }],
      inscricoes: [inscricao(), inscricao({ id: ENROLLMENT_2, pointer_id: OUTRO_POINTER })],
      over: { metadata: { actor_type: "webhook_source", actor_id: `followup:${ENROLLMENT}` } },
    });
    expect(summary.proprio_ator).toBe(1);
    expect(summary.canceladas).toBe(1);
    expect(reg.canceladas).toHaveLength(1);
    expect(reg.canceladas[0]).toMatchObject({ id: ENROLLMENT_2 });
  });

  it("mão que não é o fluxo (ator humano ou sem metadata) cancela normalmente", async () => {
    const semAtor = await saida({ over: { metadata: { actor_type: "user" } } });
    expect(semAtor.summary.canceladas).toBe(1);
    expect(semAtor.summary.proprio_ator).toBe(0);

    const humano = await saida({ over: { metadata: { actor_type: "user", actor_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } } });
    expect(humano.summary.canceladas).toBe(1);
    expect(humano.summary.proprio_ator).toBe(0);
  });

  it("só consulta as inscrições dos fluxos armados NA etapa de origem", async () => {
    const { reg } = await saida({ inscricoes: [inscricao()] });
    // a consulta de inscrições é restrita aos pointers da etapa de origem
    expect(reg.inscricoesPassadas).toEqual([[POINTER]]);
    // e a busca de pointers é pela etapa de ORIGEM, não pela de destino
    expect(reg.pointersPorEtapa).toEqual([{ org: ORG, etapa: ETAPA_MARCADA }]);
  });

  it("⭐ re-drain do mesmo evento não cancela duas vezes (idempotência)", async () => {
    const { summary, reg } = await saida({ jaInserido: true });
    expect(summary.canceladas).toBe(0);
    expect(reg.canceladas).toHaveLength(0);
  });

  it("cancelamento concorrente (opt-out chegou antes) não é sobrescrito nem contado como cancelado", async () => {
    const { summary, reg } = await saida({ cancelamentoConcorrente: true });
    expect(summary.canceladas).toBe(0);
    expect(summary.ja_encerradas).toBe(1);
    expect(reg.canceladas).toHaveLength(0);
  });

  it("negócio sem contato não tem a quem cancelar — e isso é contado, não calado", async () => {
    const { summary } = await saida({ contato: null, inscricoes: [] });
    expect(summary.sem_contato).toBe(1);
    expect(summary.canceladas).toBe(0);
  });
});

describe("follow-up por etapa — SAÍDA: quando NADA deve acontecer (controles)", () => {
  it("⭐ etapa de origem NÃO marcada não cancela nada — e nem consulta o negócio (controle)", async () => {
    const { summary, reg } = await saida({ pointers: [], inscricoes: [] });
    expect(summary.matched).toBe(true);
    expect(summary.pointers_armados).toBe(0);
    expect(reg.contatoConsultado).toBe(0);
    expect(reg.canceladas).toHaveLength(0);
    expect(reg.eventos).toHaveLength(0);
  });

  it("⭐ organização sem follow-up configurado: nenhuma consulta ao banco (controle)", async () => {
    const { summary, reg } = await saida({ pointers: [], inscricoes: [] });
    expect(summary).toMatchObject({ pointers_armados: 0, canceladas: 0, inscricoes_encontradas: 0 });
    expect(reg.inscricoesPassadas).toHaveLength(0);
    expect(reg.canceladas).toHaveLength(0);
  });

  it("negócio NASCENDO na etapa (sem `from_stage_id`) não é saída — nada acontece", async () => {
    const { summary, reg } = await saida({ over: { payload: { to_stage_id: ETAPA_MARCADA } } });
    expect(summary.matched).toBe(false);
    expect(reg.pointersPorEtapa).toHaveLength(0);
    expect(reg.canceladas).toHaveLength(0);
  });

  it("carimbo de reordenação (from === to) não é saída — nada acontece", async () => {
    const { summary, reg } = await saida({ over: { payload: { from_stage_id: ETAPA_MARCADA, to_stage_id: ETAPA_MARCADA } } });
    expect(summary.matched).toBe(false);
    expect(reg.pointersPorEtapa).toHaveLength(0);
  });

  it("evento de outro tipo não é reconhecido", async () => {
    const { summary, reg } = await saida({ over: { event_type: "lead.created" } });
    expect(summary.matched).toBe(false);
    expect(reg.pointersPorEtapa).toHaveLength(0);
  });

  it("⭐ pausa pedida por uma PESSOA não é desfeita por um arrasto de card (controle)", async () => {
    const { summary, reg } = await saida({ inscricoes: [inscricao({ status: "paused_manual" })] });
    expect(summary.inscricoes_encontradas).toBe(1);
    expect(summary.canceladas).toBe(0);
    expect(reg.canceladas).toHaveLength(0);
    expect(reg.eventos).toHaveLength(0);
  });

  it("atendimento em handoff (pausa do humano) também não é cancelado pelo card", async () => {
    const { summary, reg } = await saida({ inscricoes: [inscricao({ status: "paused_handoff" })] });
    expect(summary.canceladas).toBe(0);
    expect(reg.canceladas).toHaveLength(0);
  });

  it("dois fluxos armados na mesma etapa: os dois toques caem", async () => {
    const { summary } = await saida({
      pointers: [pointerDaSaida, { id: OUTRO_POINTER, stage_id: ETAPA_MARCADA }],
      inscricoes: [inscricao(), inscricao({ id: ENROLLMENT_2, pointer_id: OUTRO_POINTER })],
    });
    expect(summary.inscricoes_encontradas).toBe(2);
    expect(summary.canceladas).toBe(2);
  });
});

describe("follow-up por etapa — o ciclo inteiro: entra, sai, e o toque não sai", () => {
  it("⭐ entra (arma 1) → volta a etapa neutra (cancela 1) → a fila não tem toque vivo", async () => {
    const armou = await entrada({ pointers: [pointerEntrada] });
    expect(armou.summary.enrolled).toBe(1);

    const desarmou = await saida({});
    expect(desarmou.summary.canceladas).toBe(1);
    expect(desarmou.reg.canceladas[0]).toMatchObject({ id: ENROLLMENT, patch: { status: "cancelled" } });
  });
});

describe("follow-up por etapa — etapa armada → etapa armada: o fluxo da nova etapa assume", () => {
  /**
   * O dispatcher roda os consumidores de `lead.stage_changed` em sequência, na
   * ordem do registro. Este caso usa a ordem REAL (lida do registro, não escrita
   * à mão) sobre um estado compartilhado pelas duas metades, com um dublê que
   * imita `idx_followup_enrollments_one_live` (um toque vivo por contato — os
   * status vivos do índice no baseline). Se o gatilho rodar antes da saída, o
   * fluxo da etapa de destino bate no índice, o da origem é cancelado em
   * seguida, e o contato fica sem follow-up nenhum.
   */
  const ETAPA_DESTINO = ETAPA_NEUTRA;
  const POINTER_DESTINO = OUTRO_POINTER;
  const VIVOS_NO_INDICE = ["active", "waiting_reply", "paused_handoff", "paused_manual"];

  function ordemDoRegistro(): Array<"gatilho" | "saida"> {
    ensureHandlersRegistered();
    return getRegisteredHandlers()
      .filter((h) => h.events.includes(EVENTO_DE_ETAPA))
      .map((h) => h.key)
      .filter((k) => k.startsWith("followup-gatilho-etapa") || k.startsWith("followup-saida-da-etapa"))
      .map((k) => (k.startsWith("followup-saida-da-etapa") ? "saida" : "gatilho"));
  }

  it("a saída está registrada antes do gatilho de etapa", () => {
    expect(ordemDoRegistro()).toEqual(["saida", "gatilho"]);
  });

  it("⭐ card vai da etapa com fluxo A para a etapa com fluxo B: B fica armado", async () => {
    const inscricoes: Array<{ id: string; pointer_id: string; status: string }> = [
      { id: ENROLLMENT, pointer_id: POINTER, status: "active" },
    ];
    const ev = evento({ payload: { from_stage_id: ETAPA_MARCADA, to_stage_id: ETAPA_DESTINO } });

    const dbEntrada: GatilhoEtapaDb = {
      async carregaPointersDeEtapa() {
        return [pointerEntrada, { ...pointerEntrada, id: POINTER_DESTINO, stage_id: ETAPA_DESTINO }];
      },
      async carregaContatoDoNegocio() {
        return CONTATO;
      },
      async carregaNoDeGatilho() {
        return { id: "t1", pedeAgente: false };
      },
      async insereEnrollment(input) {
        if (inscricoes.some((i) => VIVOS_NO_INDICE.includes(i.status))) return { inserted: false, id: null };
        inscricoes.push({ id: ENROLLMENT_2, pointer_id: input.pointer_id, status: "active" });
        return { inserted: true, id: ENROLLMENT_2 };
      },
      async insereEventoDoEnrollment() {},
    };
    const dbSaida: SaidaDaEtapaDb = {
      async carregaPointersDaEtapa(_org, etapa) {
        return etapa === ETAPA_MARCADA ? [pointerDaSaida] : [];
      },
      async carregaContatoDoNegocio() {
        return CONTATO;
      },
      async carregaInscricoesVivas(_org, _contato, pointerIds) {
        return inscricoes
          .filter((i) => pointerIds.includes(i.pointer_id) && i.status === "active")
          .map((i) => inscricao({ id: i.id, pointer_id: i.pointer_id }));
      },
      async insereEventoDoEnrollment() {
        return { inserted: true };
      },
      async cancelaInscricao(id) {
        const alvo = inscricoes.find((i) => i.id === id);
        if (!alvo) return false;
        alvo.status = "cancelled";
        return true;
      },
    };

    const ordem = ordemDoRegistro();
    expect(ordem).toHaveLength(2);
    for (const passo of ordem) {
      if (passo === "saida") await aplicaSaidaDaEtapa({ db: dbSaida, clock: CLOCK }, ev);
      else await aplicaGatilhoDeEtapa({ db: dbEntrada, gateDb: fakeGate(), clock: CLOCK }, ev);
    }

    const vivos = inscricoes.filter((i) => VIVOS_NO_INDICE.includes(i.status)).map((i) => i.pointer_id);
    expect(vivos).toEqual([POINTER_DESTINO]);
  });
});

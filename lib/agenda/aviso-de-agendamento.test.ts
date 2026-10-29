/**
 * A REGRA do aviso de agendamento no WhatsApp do dono — sem banco e sem rede.
 *
 * Cada caso mede uma promessa do pedido: desligado por padrão, madrugada vai
 * para o resumo, cada evento é avisado uma vez, evento velho é descartado,
 * cancelar segura o aviso que não saiu, o anti-ban do número é respeitado, o
 * destino nunca é número da própria organização, e nenhum desfecho é `error`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { CanalDoAviso, DecisaoDePacing } from "@/lib/escalacao/aviso-ao-suporte";
import type { EventRow } from "@/lib/event-log/dispatcher";

import {
  aplicaAvisoDeAgendamento,
  aplicaResumoDoDia,
  ehMadrugada,
  type AgendamentoDoAviso,
  type AvisoDeAgendamentoDb,
  type AvisoDeAgendamentoDeps,
  type ConfigDoAvisoDeAgendamento,
  type EntregaDeAgendamento,
} from "./aviso-de-agendamento";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const AG = "33333333-3333-4333-8333-333333333333";
const FUSO = "America/Sao_Paulo";
/** 14h em São Paulo (UTC-3). */
const TARDE = new Date("2026-10-21T17:00:00.000Z");
/** 23h em São Paulo. */
const NOITE = new Date("2026-10-22T02:00:00.000Z");
/** 7h10 em São Paulo. */
const SETE_E_DEZ = new Date("2026-10-22T10:10:00.000Z");

interface Mundo {
  config: ConfigDoAvisoDeAgendamento | null;
  agendamento: AgendamentoDoAviso | null;
  canal: CanalDoAviso | null;
  pacing: DecisaoDePacing;
  destinoProprio: boolean;
  anonimizado: boolean;
  entregas: Map<string, EntregaDeAgendamento & { event_id?: string; dia?: string }>;
  enviadas: string[];
  auditadas: string[];
  envioFalha: boolean;
  /** O relógio da rodada, visível ao fake da reivindicação. */
  relogio: Date;
}

function novoMundo(): Mundo {
  return {
    config: { organization_id: ORG, channel_session_id: CANAL, telefone_destino: "+5531999998888", ligado: true },
    agendamento: {
      id: AG,
      status: "confirmed",
      starts_at: "2026-10-23T13:30:00.000Z",
      contact_id: "c1",
      owner_user_id: "u1",
      event_type_id: "t1",
      title: "Consulta",
      created_by_kind: "ai",
    },
    canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true },
    pacing: { liberado: true },
    destinoProprio: false,
    anonimizado: false,
    entregas: new Map(),
    enviadas: [],
    auditadas: [],
    envioFalha: false,
    relogio: TARDE,
  };
}

let mundo: Mundo;
let seq = 0;

function db(): AvisoDeAgendamentoDb {
  const nova = (campos: Partial<EntregaDeAgendamento> & { event_id?: string; dia?: string }) => {
    seq += 1;
    const agora = new Date().toISOString();
    const e = {
      id: `e${seq}`,
      organization_id: ORG,
      appointment_id: null,
      evento: null,
      destino: "+5531999998888",
      status: "pendente",
      tentativas: 0,
      created_at: agora,
      updated_at: "2000-01-01T00:00:00.000Z",
      ...campos,
    };
    mundo.entregas.set(e.id, e);
    return e;
  };
  return {
    carregaCanal: async () => mundo.canal,
    destinoEhDaPropriaOrganizacao: async () => mundo.destinoProprio,
    contatoAnonimizado: async () => mundo.anonimizado,
    nomeDoContato: async () => "Maria Souza",
    marcaDaOrganizacao: async () => ({ nome: "Clínica Sol", idioma: "pt-BR" }),
    carregaConfig: async () => mundo.config,
    fusoDaOrganizacao: async () => FUSO,
    carregaAgendamento: async () => mundo.agendamento,
    nomeDoServico: async () => "Limpeza",
    nomeDoProfissional: async () => "Ana Lima",
    reivindicaAviso: async (e) => {
      const ja = [...mundo.entregas.values()].find((x) => x.event_id === e.eventId);
      if (ja) return { criada: false, entrega: ja };
      return {
        criada: true,
        entrega: nova({
          event_id: e.eventId,
          appointment_id: e.appointmentId,
          evento: e.evento,
          destino: e.destino,
          status: e.status,
          created_at: mundo.relogio.toISOString(),
        }),
      };
    },
    reivindicaResumo: async (e) => {
      const ja = [...mundo.entregas.values()].find((x) => x.dia === e.dia);
      if (ja) return { criada: false, entrega: ja };
      return { criada: true, entrega: nova({ dia: e.dia, created_at: mundo.relogio.toISOString() }) };
    },
    atualizaEntrega: async (_o, id, patch) => {
      const e = mundo.entregas.get(id);
      if (e) Object.assign(e, patch, { updated_at: mundo.relogio.toISOString() });
    },
    cancelaPendentesDoAgendamento: async (_o, appointmentId, excetoEventId) => {
      let n = 0;
      for (const e of mundo.entregas.values()) {
        if (e.appointment_id === appointmentId && e.event_id !== excetoEventId &&
            (e.status === "pendente" || e.status === "para_o_resumo")) {
          e.status = "cancelado";
          n += 1;
        }
      }
      return n;
    },
    houveAvisoEnviado: async (_o, appointmentId) =>
      [...mundo.entregas.values()].some((e) => e.appointment_id === appointmentId && e.status === "enviado"),
    agendaEntre: async () => (mundo.agendamento ? [mundo.agendamento] : []),
    represadasParaOResumo: async () =>
      [...mundo.entregas.values()]
        .filter((e) => e.status === "para_o_resumo")
        .map((entrega) => ({ entrega, agendamento: mundo.agendamento })),
    marcaNoResumo: async (_o, ids) => {
      for (const id of ids) {
        const e = mundo.entregas.get(id);
        if (e) e.status = "no_resumo";
      }
    },
  };
}

function deps(agora: Date, origem: "worker" | "request" = "worker"): AvisoDeAgendamentoDeps {
  mundo.relogio = agora;
  return {
    db: db(),
    transporte: {
      configurado: async () => true,
      resolveDestino: async (_o, _c, tel) => `${tel.replace("+", "")}@c.us`,
      envia: async (_o, _c, _to, body) => {
        if (mundo.envioFalha) throw new Error("recusado");
        mundo.enviadas.push(body);
        return { externalId: `x${mundo.enviadas.length}` };
      },
    },
    pacing: { decide: async () => mundo.pacing, registraEnvio: async () => undefined },
    clock: () => agora,
    origemDoDreno: () => origem,
    audita: (a) => {
      mundo.auditadas.push(a.action);
    },
  };
}

function evento(tipo: string, id: string, emitidoEm: Date, payload: Record<string, unknown> = {}): EventRow {
  return {
    id,
    organization_id: ORG,
    event_type: tipo,
    entity_kind: "calendar_appointment",
    entity_id: AG,
    payload: { appointment_id: AG, ...payload },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: emitidoEm.toISOString(),
  };
}

beforeEach(() => {
  mundo = novoMundo();
  seq = 0;
});

describe("ehMadrugada — das 22h às 7h", () => {
  it.each([
    [21, false],
    [22, true],
    [23, true],
    [0, true],
    [6, true],
    [7, false],
    [12, false],
  ])("%ih → %s", (hora, esperado) => {
    expect(ehMadrugada(hora)).toBe(esperado);
  });
});

describe("aplicaAvisoDeAgendamento", () => {
  it("desligado por padrão: sem configuração não envia nada e não é erro", async () => {
    mundo.config = null;
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r).toEqual({ status: "skipped", detail: "sem_configuracao" });
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("configuração pausada (`ligado=false`) também não envia", async () => {
    mundo.config = { ...mundo.config!, ligado: false };
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("skipped");
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("marcado de tarde: envia o aviso com cliente, serviço, hora local, profissional e origem", async () => {
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
    const corpo = mundo.enviadas[0]!;
    expect(corpo).toContain("novo agendamento");
    expect(corpo).toContain("Cliente: Maria");
    expect(corpo).not.toContain("Souza");
    expect(corpo).toContain("Serviço: Limpeza");
    // 13:30 UTC = 10:30 em São Paulo.
    expect(corpo).toContain("10:30");
    expect(corpo).toContain("Profissional: Ana");
    expect(corpo).toContain("Origem: IA");
    expect(mundo.auditadas).toEqual(["agenda.aviso_whatsapp_enviado"]);
  });

  it("o autor da mudança no payload decide a origem (Google Agenda)", async () => {
    await aplicaAvisoDeAgendamento(
      deps(TARDE),
      evento("appointment.rescheduled", "ev1", TARDE, { autor: "google" }),
    );
    expect(mundo.enviadas[0]).toContain("Origem: Google Agenda");
    expect(mundo.enviadas[0]).toContain("agendamento remarcado");
  });

  it("o MESMO evento entregue duas vezes sai uma vez só", async () => {
    await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    const segunda = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(segunda).toEqual({ status: "skipped", detail: "ja_resolvido:enviado" });
    expect(mundo.enviadas).toHaveLength(1);
  });

  it("remarcar é outra notícia: evento novo, aviso novo", async () => {
    await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.rescheduled", "ev2", TARDE));
    expect(mundo.enviadas).toHaveLength(2);
  });

  it("evento com mais de 30 minutos é descartado", async () => {
    const emitido = new Date(TARDE.getTime() - 31 * 60 * 1000);
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", emitido));
    expect(r).toEqual({ status: "skipped", detail: "evento_velho" });
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("de madrugada não envia: a entrega fica para o resumo das 7h", async () => {
    const r = await aplicaAvisoDeAgendamento(deps(NOITE), evento("appointment.created", "ev1", NOITE));
    expect(r).toEqual({ status: "skipped", detail: "madrugada:vai_no_resumo" });
    expect(mundo.enviadas).toHaveLength(0);
    expect([...mundo.entregas.values()][0]?.status).toBe("para_o_resumo");
  });

  it("cancelado antes de o aviso sair: o pendente é cancelado e o cancelamento não é avisado", async () => {
    mundo.pacing = { liberado: false, motivo: "espacamento", liberaEm: new Date(TARDE.getTime() + 2000) };
    const primeiro = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(primeiro.status).toBe("retry");

    mundo.pacing = { liberado: true };
    mundo.agendamento = { ...mundo.agendamento!, status: "cancelled" };
    const cancel = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.cancelled", "ev2", TARDE));
    expect(cancel).toEqual({ status: "ok", detail: "cancelado=1:nada_a_avisar" });

    // O retry do primeiro evento acha a entrega cancelada e não envia.
    const retomada = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(retomada.status).toBe("skipped");
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("cancelado DEPOIS de avisado: o cancelamento é avisado", async () => {
    await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    mundo.agendamento = { ...mundo.agendamento!, status: "cancelled" };
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.cancelled", "ev2", TARDE));
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(2);
    expect(mundo.enviadas[1]).toContain("agendamento cancelado");
  });

  it("marcado e já cancelado quando o dreno chega: não avisa a marcação", async () => {
    mundo.agendamento = { ...mundo.agendamento!, status: "cancelled" };
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r).toEqual({ status: "skipped", detail: "agendamento_cancelled" });
  });

  it("respeita o espaçamento e o teto diário do número (retry, nunca erro)", async () => {
    const libera = new Date(TARDE.getTime() + 60 * 60 * 1000);
    mundo.pacing = { liberado: false, motivo: "teto_diario", liberaEm: libera };
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r).toMatchObject({ status: "retry", retry_at: libera.toISOString() });
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("recusa destino que virou número de uma conexão da própria organização", async () => {
    mundo.destinoProprio = true;
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r).toEqual({ status: "skipped", detail: "falhou:destino_da_propria_organizacao" });
    expect(mundo.enviadas).toHaveLength(0);
    expect(mundo.auditadas).toEqual(["agenda.aviso_whatsapp_falhou"]);
  });

  it("canal fora do ar adia; transporte que recusa adia — nenhum é `error`", async () => {
    mundo.canal = { ...mundo.canal!, status: "STOPPED" };
    expect((await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE))).status).toBe(
      "retry",
    );
    mundo.canal = { ...mundo.canal!, status: "WORKING" };
    mundo.envioFalha = true;
    const depois = new Date(TARDE.getTime() + 3 * 60 * 1000);
    expect((await aplicaAvisoDeAgendamento(deps(depois), evento("appointment.created", "ev1", TARDE))).status).toBe(
      "retry",
    );
  });

  it("dreno dentro do webhook adia sem tocar a rede", async () => {
    const r = await aplicaAvisoDeAgendamento(deps(TARDE, "request"), evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("retry");
    expect(mundo.entregas.size).toBe(0);
  });

  it("contato anonimizado não é avisado", async () => {
    mundo.anonimizado = true;
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r).toEqual({ status: "skipped", detail: "titular_anonimizado" });
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("evento fora do aviso é ignorado", async () => {
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.no_show", "ev1", TARDE));
    expect(r).toEqual({ status: "skipped", detail: "evento_ignorado" });
  });
});

describe("aplicaResumoDoDia", () => {
  it("fora das 7h–10h locais não faz nada", async () => {
    const r = await aplicaResumoDoDia(deps(TARDE), ORG);
    expect(r).toEqual({ status: "skipped", detail: "fora_da_hora" });
    expect(mundo.enviadas).toHaveLength(0);
  });

  it("às 7h envia o resumo, com o que a madrugada represou, e só uma vez", async () => {
    await aplicaAvisoDeAgendamento(deps(NOITE), evento("appointment.created", "ev1", NOITE));
    const r = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
    const corpo = mundo.enviadas[0]!;
    expect(corpo).toContain("agenda de hoje");
    expect(corpo).toContain("Total: 1");
    expect(corpo).toContain("Durante a noite (22h às 7h):");
    expect([...mundo.entregas.values()].find((e) => e.event_id === "ev1")?.status).toBe("no_resumo");

    const segunda = await aplicaResumoDoDia(deps(new Date(SETE_E_DEZ.getTime() + 10 * 60 * 1000)), ORG);
    expect(segunda).toEqual({ status: "skipped", detail: "ja_resolvido:enviado" });
    expect(mundo.enviadas).toHaveLength(1);
  });

  it("sem configuração não envia resumo", async () => {
    mundo.config = null;
    expect(await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG)).toEqual({ status: "skipped", detail: "sem_configuracao" });
  });

  it("o resumo também respeita o teto do número", async () => {
    mundo.pacing = { liberado: false, motivo: "teto_diario", liberaEm: new Date(SETE_E_DEZ.getTime() + 3600_000) };
    const r = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(r.status).toBe("retry");
    expect(mundo.enviadas).toHaveLength(0);
  });
});

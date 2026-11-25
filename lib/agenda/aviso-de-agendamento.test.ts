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
  entregas: Map<string, EntregaDeAgendamento & { event_id?: string; dia?: string; alvo?: string }>;
  enviadas: string[];
  /** O endereço de cada envio, na mesma ordem de `enviadas`. */
  para: string[];
  /** O grupo recusa o envio (saiu do grupo, grupo apagado). */
  grupoFalha: boolean;
  auditadas: string[];
  /** O `metadata` de cada auditoria, na mesma ordem de `auditadas`. */
  auditMeta: Array<Record<string, unknown>>;
  envioFalha: boolean;
  /** O relógio da rodada, visível ao fake da reivindicação. */
  relogio: Date;
}

function novoMundo(): Mundo {
  return {
    config: {
      organization_id: ORG,
      channel_session_id: CANAL,
      telefone_destino: "+5531999998888",
      grupo_destino: null,
      ligado: true,
    },
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
    para: [],
    grupoFalha: false,
    auditadas: [],
    auditMeta: [],
    envioFalha: false,
    relogio: TARDE,
  };
}

let mundo: Mundo;
let seq = 0;

function db(): AvisoDeAgendamentoDb {
  const nova = (campos: Partial<EntregaDeAgendamento> & { event_id?: string; dia?: string; alvo?: string }) => {
    seq += 1;
    const agora = new Date().toISOString();
    const e = {
      id: `e${seq}`,
      organization_id: ORG,
      appointment_id: null,
      evento: null,
      alvo: "numero" as const,
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
      const ja = [...mundo.entregas.values()].find((x) => x.event_id === e.eventId && x.alvo === e.alvo);
      if (ja) return { criada: false, entrega: ja };
      return {
        criada: true,
        entrega: nova({
          event_id: e.eventId,
          appointment_id: e.appointmentId,
          evento: e.evento,
          alvo: e.alvo,
          destino: e.destino,
          status: e.status,
          created_at: mundo.relogio.toISOString(),
        }),
      };
    },
    reivindicaResumo: async (e) => {
      const ja = [...mundo.entregas.values()].find((x) => x.dia === e.dia && x.alvo === e.alvo);
      if (ja) return { criada: false, entrega: ja };
      return {
        criada: true,
        entrega: nova({ dia: e.dia, alvo: e.alvo, destino: e.destino, created_at: mundo.relogio.toISOString() }),
      };
    },
    resumoJaReivindicado: async (_o, dia, alvo) =>
      [...mundo.entregas.values()].some((x) => x.dia === dia && x.alvo === alvo),
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
    houveAvisoEnviado: async (_o, appointmentId, alvo) =>
      [...mundo.entregas.values()].some(
        (e) => e.appointment_id === appointmentId && e.alvo === alvo && (e.status === "enviado" || e.status === "no_resumo"),
      ),
    agendaEntre: async () => (mundo.agendamento ? [mundo.agendamento] : []),
    represadasParaOResumo: async (_o, alvo) =>
      [...mundo.entregas.values()]
        .filter((e) => e.status === "para_o_resumo" && e.alvo === alvo)
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
      resolveDestino: async (_o, _c, tel) => (tel.endsWith("@g.us") ? tel : `${tel.replace("+", "")}@c.us`),
      envia: async (_o, _c, to, body) => {
        if (mundo.envioFalha || (mundo.grupoFalha && to.endsWith("@g.us"))) throw new Error("recusado");
        mundo.enviadas.push(body);
        mundo.para.push(to);
        return { externalId: `x${mundo.enviadas.length}` };
      },
    },
    pacing: { decide: async () => mundo.pacing, registraEnvio: async () => undefined },
    clock: () => agora,
    origemDoDreno: () => origem,
    audita: (a) => {
      mundo.auditadas.push(a.action);
      mundo.auditMeta.push(a.metadata);
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

describe("aplicaResumoDoDia — só quando houver agendamento (#4988)", () => {
  it("desligado (o padrão): o dia vazio continua recebendo o resumo com Total: 0", async () => {
    mundo.agendamento = null;
    const r = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toContain("Nenhum agendamento para hoje.");
  });

  it("ligado e dia vazio: não envia e não grava entrega do dia", async () => {
    mundo.config = { ...mundo.config!, resumo_so_com_agendamento: true };
    mundo.agendamento = null;
    const r = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(r).toEqual({ status: "skipped", detail: "dia_vazio" });
    expect(mundo.enviadas).toHaveLength(0);
    // Sem linha: "Últimos avisos" não ganha uma linha por dia quieto.
    expect(mundo.entregas.size).toBe(0);
  });

  it("ligado e dia com agendamento: o resumo sai como sempre, e só uma vez", async () => {
    mundo.config = { ...mundo.config!, resumo_so_com_agendamento: true };
    const r = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toContain("Total: 1");

    const segunda = await aplicaResumoDoDia(deps(new Date(SETE_E_DEZ.getTime() + 10 * 60 * 1000)), ORG);
    expect(segunda).toEqual({ status: "skipped", detail: "ja_resolvido:enviado" });
    expect(mundo.enviadas).toHaveLength(1);
  });

  it("ligado, agenda de hoje vazia, mas houve mudança de madrugada: o resumo sai e conta a mudança", async () => {
    mundo.config = { ...mundo.config!, resumo_so_com_agendamento: true };
    // Marcado às 23h para outro dia: entra represado, e a agenda de HOJE fica vazia.
    await aplicaAvisoDeAgendamento(deps(NOITE), evento("appointment.created", "ev1", NOITE));
    const d = deps(SETE_E_DEZ);
    d.db.agendaEntre = async () => [];
    const r = await aplicaResumoDoDia(d, ORG);
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toContain("Nenhum agendamento para hoje.");
    expect(mundo.enviadas[0]).toContain("Durante a noite (22h às 7h):");
    expect([...mundo.entregas.values()].find((e) => e.event_id === "ev1")?.status).toBe("no_resumo");
  });

  it("ligado: vazio às 7h10, e um horário marcado para hoje antes das 10h faz o resumo sair na rodada seguinte", async () => {
    mundo.config = { ...mundo.config!, resumo_so_com_agendamento: true };
    const agendamento = mundo.agendamento;
    mundo.agendamento = null;
    expect(await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG)).toEqual({ status: "skipped", detail: "dia_vazio" });

    mundo.agendamento = agendamento;
    const r = await aplicaResumoDoDia(deps(new Date(SETE_E_DEZ.getTime() + 10 * 60 * 1000)), ORG);
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
  });

  it("ligado: o resumo já reivindicado que esperava o canal sai mesmo se o dia esvaziou, e não fica pendente", async () => {
    mundo.config = { ...mundo.config!, resumo_so_com_agendamento: true };
    mundo.canal = { ...mundo.canal!, status: "STOPPED" };
    const primeira = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(primeira.status).toBe("retry");
    expect(mundo.entregas.size).toBe(1);

    // O único horário foi cancelado enquanto o canal estava fora do ar.
    mundo.agendamento = null;
    mundo.canal = { ...mundo.canal!, status: "WORKING" };
    const r = await aplicaResumoDoDia(deps(new Date(SETE_E_DEZ.getTime() + 20 * 60 * 1000)), ORG);
    expect(r.status).toBe("ok");
    expect(mundo.enviadas).toHaveLength(1);
    expect([...mundo.entregas.values()][0]?.status).toBe("enviado");
  });

  it("ligado, com grupo: cada destino decide pelas próprias represadas", async () => {
    mundo.config = { ...mundo.config!, grupo_destino: "120363000000000001@g.us", resumo_so_com_agendamento: true };
    const d = deps(SETE_E_DEZ);
    d.db.agendaEntre = async () => [];
    // Só o número tem uma represada (o grupo foi ligado depois da madrugada).
    mundo.entregas.set("r1", {
      id: "r1",
      organization_id: ORG,
      appointment_id: AG,
      evento: "appointment.created",
      event_id: "ev-noite",
      alvo: "numero",
      destino: "+5531999998888",
      status: "para_o_resumo",
      tentativas: 0,
      created_at: NOITE.toISOString(),
      updated_at: NOITE.toISOString(),
    });
    const r = await aplicaResumoDoDia(d, ORG);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("grupo:dia_vazio");
    expect(mundo.para).toEqual(["5531999998888@c.us"]);
  });
});

describe("aviso também no grupo do WhatsApp", () => {
  const GRUPO = "120363025246125486@g.us";
  const NUMERO = "5531999998888@c.us";

  beforeEach(() => {
    mundo.config = { ...mundo.config!, grupo_destino: GRUPO };
  });

  it.each(["appointment.created", "appointment.rescheduled"])(
    "%s: uma entrega para o número e uma para o grupo, cada uma uma vez só",
    async (tipo) => {
      const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento(tipo, "ev1", TARDE));
      expect(r.status).toBe("ok");
      expect(mundo.para).toEqual([NUMERO, GRUPO]);

      const segunda = await aplicaAvisoDeAgendamento(deps(TARDE), evento(tipo, "ev1", TARDE));
      expect(segunda.status).toBe("skipped");
      expect(mundo.para).toHaveLength(2);
      expect([...mundo.entregas.values()].map((e) => e.alvo)).toEqual(["numero", "grupo"]);
      expect(mundo.auditMeta.map((m) => m.alvo)).toEqual(["numero", "grupo"]);
    },
  );

  it("cancelado depois de avisado: o cancelamento vai para os dois, uma vez cada", async () => {
    await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    mundo.agendamento = { ...mundo.agendamento!, status: "cancelled" };
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.cancelled", "ev2", TARDE));
    await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.cancelled", "ev2", TARDE));
    expect(r.status).toBe("ok");
    expect(mundo.para).toEqual([NUMERO, GRUPO, NUMERO, GRUPO]);
    expect(mundo.enviadas[3]).toContain("agendamento cancelado");
  });

  it("cancelado quando só o número tinha recebido: o grupo não recebe cancelamento de horário que não viu", async () => {
    mundo.grupoFalha = true;
    const primeiro = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(primeiro.status).toBe("retry");
    expect(mundo.para).toEqual([NUMERO]);

    mundo.grupoFalha = false;
    mundo.agendamento = { ...mundo.agendamento!, status: "cancelled" };
    const depois = new Date(TARDE.getTime() + 3 * 60 * 1000);
    const cancel = await aplicaAvisoDeAgendamento(deps(depois), evento("appointment.cancelled", "ev2", depois));
    expect(cancel.status).toBe("ok");
    expect(cancel.detail).toContain("grupo:cancelado=1:nada_a_avisar");
    expect(mundo.para).toEqual([NUMERO, NUMERO]);
    expect(mundo.enviadas[1]).toContain("agendamento cancelado");

    // A retomada do primeiro evento acha a entrega do grupo cancelada e não envia.
    await aplicaAvisoDeAgendamento(deps(depois), evento("appointment.created", "ev1", TARDE));
    expect(mundo.para).toEqual([NUMERO, NUMERO]);
  });

  it("só o grupo, sem número: o aviso sai para o grupo", async () => {
    mundo.config = { ...mundo.config!, telefone_destino: null };
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("ok");
    expect(mundo.para).toEqual([GRUPO]);
  });

  it("de madrugada o grupo também espera, e o resumo das 7h sai para os dois uma vez", async () => {
    const r = await aplicaAvisoDeAgendamento(deps(NOITE), evento("appointment.created", "ev1", NOITE));
    expect(r.status).toBe("skipped");
    expect(mundo.para).toHaveLength(0);
    expect([...mundo.entregas.values()].map((e) => `${e.alvo}:${e.status}`)).toEqual([
      "numero:para_o_resumo",
      "grupo:para_o_resumo",
    ]);

    const resumo = await aplicaResumoDoDia(deps(SETE_E_DEZ), ORG);
    expect(resumo.status).toBe("ok");
    expect(mundo.para).toEqual([NUMERO, GRUPO]);
    for (const corpo of mundo.enviadas) expect(corpo).toContain("Durante a noite (22h às 7h):");
    expect([...mundo.entregas.values()].filter((e) => e.event_id).map((e) => e.status)).toEqual([
      "no_resumo",
      "no_resumo",
    ]);

    await aplicaResumoDoDia(deps(new Date(SETE_E_DEZ.getTime() + 10 * 60 * 1000)), ORG);
    expect(mundo.para).toHaveLength(2);
  });

  it("grupo que recusa o envio adia só o grupo: o número sai, e não sai de novo", async () => {
    mundo.grupoFalha = true;
    const r = await aplicaAvisoDeAgendamento(deps(TARDE), evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("retry");
    expect(mundo.para).toEqual([NUMERO]);

    mundo.grupoFalha = false;
    const depois = new Date(TARDE.getTime() + 3 * 60 * 1000);
    const retomada = await aplicaAvisoDeAgendamento(deps(depois), evento("appointment.created", "ev1", TARDE));
    expect(retomada.status).toBe("ok");
    expect(mundo.para).toEqual([NUMERO, GRUPO]);
  });

  it("grupo sem endereço possível cai só ele; o número sai e nada é `error`", async () => {
    const d = deps(TARDE);
    const resolve = d.transporte.resolveDestino;
    d.transporte.resolveDestino = async (o, c, tel) => (tel.endsWith("@g.us") ? null : resolve(o, c, tel));
    const r = await aplicaAvisoDeAgendamento(d, evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("grupo:falhou:destino_invalido");
    expect(mundo.para).toEqual([NUMERO]);
    // A falha do grupo se distingue da do número no registro.
    expect(mundo.auditadas).toEqual(["agenda.aviso_whatsapp_enviado", "agenda.aviso_whatsapp_falhou"]);
    expect(mundo.auditMeta.map((m) => m.alvo)).toEqual(["numero", "grupo"]);
  });

  it("leitura que lança no caminho do grupo vira retry do grupo, nunca `error`", async () => {
    const d = deps(TARDE);
    const reivindica = d.db.reivindicaAviso;
    d.db.reivindicaAviso = async (e) => {
      if (e.alvo === "grupo") throw new Error("banco fora");
      return reivindica(e);
    };
    const r = await aplicaAvisoDeAgendamento(d, evento("appointment.created", "ev1", TARDE));
    expect(r.status).toBe("retry");
    expect(mundo.para).toEqual([NUMERO]);
  });
});

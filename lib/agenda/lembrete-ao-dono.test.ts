/**
 * O lembrete ao dono: a régua de envio, sem banco e sem rede.
 *
 * O mundo é um fake que guarda as entregas com a MESMA chave única do banco
 * (compromisso, destino, degrau, início) — é ela que garante "sem aviso em
 * dobro", e o teste a exercita com duas rodadas seguidas.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { CanalDoAviso, DecisaoDePacing } from "@/lib/escalacao/aviso-ao-suporte";

import type { AvisoDeAgendamentoDb, AvisoDeAgendamentoDeps, ConfigDoAvisoDeAgendamento, EntregaDeAgendamento } from "./aviso-de-agendamento";
import { aplicaLembretesAoDono, type CompromissoDoLembrete, type LembreteAoDonoDb } from "./lembrete-ao-dono";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const AG = "33333333-3333-4333-8333-333333333333";
const H = 60 * 60_000;
/** Terça, 10/11/2026, 14h em São Paulo. */
const INICIO = new Date("2026-11-10T17:00:00.000Z");
const MEET = "https://meet.google.com/abc-defg-hij";

type Entrega = EntregaDeAgendamento & { degrau: number; inicio: string; enviado_em: string | null };

interface Mundo {
  config: ConfigDoAvisoDeAgendamento | null;
  compromisso: CompromissoDoLembrete & { status: string };
  entregas: Entrega[];
  enviadas: string[];
  para: string[];
  anonimizado: boolean;
  canal: CanalDoAviso;
  pacing: DecisaoDePacing;
}

let mundo: Mundo;
let seq = 0;

function novoMundo(): Mundo {
  return {
    config: {
      organization_id: ORG,
      channel_session_id: CANAL,
      telefone_destino: "+5519971636881",
      grupo_destino: null,
      ligado: true,
      lembrar_antes: true,
    },
    compromisso: {
      id: AG,
      status: "confirmed",
      starts_at: INICIO.toISOString(),
      created_at: "2026-11-06T13:00:00.000Z",
      starts_at_marked_at: null,
      contact_id: "c1",
      event_type_id: "t1",
      title: "Reunião comercial",
      location_kind: "google_meet",
      meeting_state: "ready",
      meeting_url: MEET,
      degraus: [1440, 60],
    },
    entregas: [],
    enviadas: [],
    para: [],
    anonimizado: false,
    canal: { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true },
    pacing: { liberado: true },
  };
}

function dbDoAviso(agora: Date): AvisoDeAgendamentoDb {
  const nada = async () => {
    throw new Error("não usado pelo lembrete");
  };
  return {
    carregaCanal: async () => mundo.canal,
    destinoEhDaPropriaOrganizacao: async () => false,
    contatoAnonimizado: async () => mundo.anonimizado,
    nomeDoContato: async () => "Maria Souza",
    marcaDaOrganizacao: async () => ({ nome: "Ricardo Mendes", idioma: "pt-BR" }),
    carregaConfig: async () => mundo.config,
    fusoDaOrganizacao: async () => "America/Sao_Paulo",
    carregaAgendamento: nada,
    nomeDoServico: async () => "Reunião comercial",
    nomeDoProfissional: async () => null,
    reivindicaAviso: nada,
    reivindicaResumo: nada,
    atualizaEntrega: async (_o, id, patch) => {
      const e = mundo.entregas.find((x) => x.id === id);
      if (e) Object.assign(e, patch, { updated_at: agora.toISOString() });
    },
    cancelaPendentesDoAgendamento: nada,
    houveAvisoEnviado: nada,
    agendaEntre: nada,
    represadasParaOResumo: nada,
    marcaNoResumo: nada,
  };
}

function dbDoLembrete(agora: Date): LembreteAoDonoDb {
  return {
    compromissosALembrar: async (_o, desde, ate) => {
      const c = mundo.compromisso;
      const t = Date.parse(c.starts_at);
      return c.status === "confirmed" && t > desde.getTime() && t <= ate.getTime() ? [c] : [];
    },
    lembretesDoCompromisso: async (_o, id, alvo) =>
      mundo.entregas
        .filter((e) => e.appointment_id === id && e.alvo === alvo)
        .map((e) => ({ degrau: e.degrau, inicio: e.inicio, status: e.status, enviadoEm: e.enviado_em })),
    reivindicaLembrete: async (e) => {
      const ja = mundo.entregas.find(
        (x) => x.appointment_id === e.appointmentId && x.alvo === e.alvo && x.degrau === e.degrau && x.inicio === e.inicio,
      );
      if (ja) return { criada: false, entrega: ja };
      seq += 1;
      const nova: Entrega = {
        id: `e${seq}`,
        organization_id: ORG,
        appointment_id: e.appointmentId,
        evento: null,
        alvo: e.alvo,
        destino: e.destino,
        status: "pendente",
        tentativas: 0,
        created_at: agora.toISOString(),
        updated_at: "2000-01-01T00:00:00.000Z",
        degrau: e.degrau,
        inicio: e.inicio,
        enviado_em: null,
      };
      mundo.entregas.push(nova);
      return { criada: true, entrega: nova };
    },
    cancelaLembretesOrfaos: async () => {
      let n = 0;
      for (const e of mundo.entregas) {
        if (e.status !== "pendente") continue;
        const c = mundo.compromisso;
        if (c.status !== "confirmed" || Date.parse(c.starts_at) !== Date.parse(e.inicio)) {
          e.status = "cancelado";
          n += 1;
        }
      }
      return n;
    },
  };
}

function rodada(agora: Date) {
  const deps: Omit<AvisoDeAgendamentoDeps, "origemDoDreno"> = {
    db: dbDoAviso(agora),
    transporte: {
      configurado: async () => true,
      resolveDestino: async (_o, _c, tel) => `${tel.replace("+", "")}@c.us`,
      envia: async (_o, _c, to, body) => {
        mundo.enviadas.push(body);
        mundo.para.push(to);
        return { externalId: `x${mundo.enviadas.length}` };
      },
    },
    pacing: { decide: async () => mundo.pacing, registraEnvio: async () => undefined },
    clock: () => agora,
    audita: () => undefined,
  };
  return aplicaLembretesAoDono(deps, dbDoLembrete(agora), ORG);
}

beforeEach(() => {
  mundo = novoMundo();
});

describe("lembrete ao dono — 24 h e 1 h antes, com o link", () => {
  it("24 h antes: sai UM lembrete para o número do aviso, com o link do Meet e a hora de São Paulo", async () => {
    const r = await rodada(new Date(INICIO.getTime() - 24 * H + 5 * 60_000));
    expect(r.enviados).toBe(1);
    expect(mundo.para).toEqual(["5519971636881@c.us"]);
    expect(mundo.enviadas[0]).toContain("lembrete de compromisso em 1 dia");
    expect(mundo.enviadas[0]).toContain(`Link da reunião: ${MEET}`);
    expect(mundo.enviadas[0]).toContain("Maria");
    // 17:00 UTC = 14:00 em São Paulo: o texto nunca mostra o UTC.
    expect(mundo.enviadas[0]).toMatch(/14:00/);
  });

  it("1 h antes: sai o segundo lembrete; a véspera não se repete", async () => {
    await rodada(new Date(INICIO.getTime() - 24 * H + 5 * 60_000));
    await rodada(new Date(INICIO.getTime() - 55 * 60_000));
    expect(mundo.enviadas).toHaveLength(2);
    expect(mundo.enviadas[1]).toContain("em 1 hora");
    expect(mundo.enviadas[1]).toContain(MEET);
  });

  it("sem aviso em dobro: duas rodadas no mesmo degrau enviam UMA vez", async () => {
    const agora = new Date(INICIO.getTime() - 50 * 60_000);
    await rodada(agora);
    await rodada(new Date(agora.getTime() + 10 * 60_000));
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.entregas.filter((e) => e.status === "enviado")).toHaveLength(1);
  });

  it("os dois degraus vencidos juntos saem como UM lembrete (o de 1 h)", async () => {
    mundo.compromisso.created_at = new Date(INICIO.getTime() - 26 * H).toISOString();
    await rodada(new Date(INICIO.getTime() - 40 * 60_000));
    await rodada(new Date(INICIO.getTime() - 30 * 60_000));
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toContain("em 1 hora");
  });
});

describe("lembrete ao dono — desligado não envia", () => {
  it("sem `lembrar_antes` nada sai, mesmo com o aviso de agendamento ligado", async () => {
    mundo.config = { ...mundo.config!, lembrar_antes: false };
    const r = await rodada(new Date(INICIO.getTime() - 55 * 60_000));
    expect(r.enviados).toBe(0);
    expect(r.desfechos.sem_configuracao).toBe(1);
    expect(mundo.enviadas).toEqual([]);
  });

  it("com o aviso de agendamento desligado nada sai", async () => {
    mundo.config = { ...mundo.config!, ligado: false };
    await rodada(new Date(INICIO.getTime() - 55 * 60_000));
    expect(mundo.enviadas).toEqual([]);
  });
});

describe("lembrete ao dono — link do Meet ainda pendente", () => {
  it("espera o link sem reivindicar o degrau; quando fica pronto, sai COM o link", async () => {
    mundo.compromisso.meeting_state = "pending";
    mundo.compromisso.meeting_url = null;
    const r = await rodada(new Date(INICIO.getTime() - 55 * 60_000));
    expect(r.enviados).toBe(0);
    expect(mundo.entregas).toHaveLength(0);

    mundo.compromisso.meeting_state = "ready";
    mundo.compromisso.meeting_url = MEET;
    await rodada(new Date(INICIO.getTime() - 45 * 60_000));
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toContain(MEET);
  });

  it("a 15 min do início sai mesmo sem link, dizendo onde ele está", async () => {
    mundo.compromisso.meeting_state = "pending";
    mundo.compromisso.meeting_url = null;
    await rodada(new Date(INICIO.getTime() - 14 * 60_000));
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toContain("ainda está sendo criado");
    expect(mundo.enviadas[0]).not.toContain("https://");
  });
});

describe("lembrete ao dono — cancelamento e remarcação", () => {
  it("compromisso cancelado não é lembrado, e o lembrete pendente dele é cancelado", async () => {
    mundo.pacing = { liberado: false, motivo: "espacamento", liberaEm: new Date(INICIO.getTime()) } as DecisaoDePacing;
    await rodada(new Date(INICIO.getTime() - 55 * 60_000));
    expect(mundo.entregas[0]?.status).toBe("pendente");

    mundo.compromisso.status = "cancelled";
    mundo.pacing = { liberado: true };
    const r = await rodada(new Date(INICIO.getTime() - 45 * 60_000));
    expect(r.desfechos.cancelados_por_mudanca).toBe(1);
    expect(mundo.entregas[0]?.status).toBe("cancelado");
    expect(mundo.enviadas).toEqual([]);
  });

  it("remarcado para outro dia: a data nova ganha os próprios lembretes", async () => {
    await rodada(new Date(INICIO.getTime() - 24 * H + 5 * 60_000));
    const novo = new Date(INICIO.getTime() + 48 * H);
    mundo.compromisso.starts_at = novo.toISOString();
    mundo.compromisso.starts_at_marked_at = new Date(INICIO.getTime() - 20 * H).toISOString();
    await rodada(new Date(novo.getTime() - 24 * H + 5 * 60_000));
    await rodada(new Date(novo.getTime() - 55 * 60_000));
    expect(mundo.enviadas).toHaveLength(3);
    expect(mundo.enviadas[1]).toMatch(/qui\.?, 12\/11/);
  });

  it("empurrado 30 min logo depois da véspera: não manda outra véspera em seguida", async () => {
    const primeira = new Date(INICIO.getTime() - 24 * H + 5 * 60_000);
    await rodada(primeira);
    mundo.compromisso.starts_at = new Date(INICIO.getTime() + 30 * 60_000).toISOString();
    mundo.compromisso.starts_at_marked_at = new Date(primeira.getTime() + 60_000).toISOString();
    await rodada(new Date(primeira.getTime() + 40 * 60_000));
    expect(mundo.enviadas).toHaveLength(1);
  });
});

describe("lembrete ao dono — fuso e madrugada", () => {
  it("na madrugada de São Paulo não reivindica nada; às 7h o lembrete ainda vencido sai", async () => {
    // Reunião às 8h (11:00 UTC); o degrau de 1 h vence às 7h, o de 1 dia às 8h da véspera.
    const cedo = new Date("2026-11-10T11:00:00.000Z");
    mundo.compromisso.starts_at = cedo.toISOString();
    mundo.compromisso.degraus = [120];
    await rodada(new Date("2026-11-10T09:30:00.000Z")); // 6h30 em SP
    expect(mundo.entregas).toHaveLength(0);
    await rodada(new Date("2026-11-10T10:05:00.000Z")); // 7h05 em SP
    expect(mundo.enviadas).toHaveLength(1);
    expect(mundo.enviadas[0]).toMatch(/08:00/);
  });
});

describe("lembrete ao dono — LGPD", () => {
  it("titular anonimizado: a entrega é cancelada e nada sai", async () => {
    mundo.anonimizado = true;
    await rodada(new Date(INICIO.getTime() - 55 * 60_000));
    expect(mundo.enviadas).toEqual([]);
    expect(mundo.entregas[0]?.status).toBe("cancelado");
  });
});

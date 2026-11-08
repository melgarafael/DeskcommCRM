/**
 * O ENCAIXE EM FILA — oferece, segura, e passa para o próximo.
 *
 * O que este arquivo protege são os LAÇOS, que é onde a lista de espera erra
 * caro:
 *
 * 1. **A mesma vaga não pode voltar para quem acabou de recusá-la.** Soltar,
 *    chamar o próximo e SÓ DEPOIS devolver a pessoa à fila é a ordem que evita
 *    o vaivém; inverter as duas linhas produz um laço que só aparece quando
 *    alguém diz não.
 * 2. **Oferta vencida não é aceita**, mesmo com o SIM chegando — entre o prazo
 *    e a resposta, a varredura pode já ter chamado outra pessoa.
 * 3. **Nada de horário preso**: quem não pode ser avisado não recebe vaga, e o
 *    aviso que não sai solta a vaga na hora.
 * 4. **A vaga não encolhe**: o próximo enxerga o buraco original, não a duração
 *    do serviço de quem recusou.
 *
 * A porta é falsa de propósito: aqui se prova a ordem dos passos. A atomicidade
 * da oferta e a concorrência são provadas em Postgres, em
 * `tests/invariants/lista-de-espera-encaixe.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  aceitarEncaixe,
  oferecerVagaQueAbriu,
  recusarEncaixe,
  vencerOfertas,
  type PedidoDeOferta,
  type PortaDoEncaixe,
} from "@/lib/agenda/encaixe";
import type {
  ConfigDaListaDeEspera,
  InscricaoNaEspera,
  ServicoDaEspera,
  VagaAberta,
} from "@/lib/agenda/lista-de-espera";

const ORG = "org-1";
const FUSO = "America/Sao_Paulo";
/** Terça 03/11/2026, 09:00 em São Paulo. */
const VAGA_INICIO = new Date("2026-11-03T12:00:00.000Z");
const AGORA = new Date("2026-11-03T09:00:00.000Z");
const CONFIG: ConfigDaListaDeEspera = {
  ativa: true,
  prazo_maximo_minutos: 90,
  margem_antes_minutos: 10,
  prazo_minimo_minutos: 20,
};
/** Quem confirma, no lugar da porta de alteração da agenda. */
const confirmaSempre = async () => true;

interface CompromissoFalso {
  id: string;
  startsAt: Date;
  endsAt: Date;
  ownerUserId: string | null;
  status: "pending" | "confirmed" | "cancelled";
}

function inscricao(id: string, over: Partial<InscricaoNaEspera> = {}): InscricaoNaEspera {
  return {
    id,
    contactId: `contato-${id}`,
    eventTypeId: "limpeza",
    ownerUserId: null,
    janelas: [],
    antecedenciaMinimaHoras: 0,
    validoAte: null,
    urgencia: 0,
    createdAt: new Date(`2026-11-0${id === "a" ? 1 : 2}T10:00:00.000Z`),
    ...over,
  };
}

function servico(over: Partial<ServicoDaEspera> = {}): ServicoDaEspera {
  return { eventTypeId: "limpeza", nome: "Limpeza", duracaoMinutos: 60, avisoMinimoMinutos: 0, ...over };
}

/** A fila e os compromissos como o fluxo os vê. `chamadas` registra a ORDEM. */
function criarPorta(estado: {
  fila: InscricaoNaEspera[];
  servicos?: Record<string, ServicoDaEspera>;
  compromissos?: Map<string, CompromissoFalso>;
  colisao?: boolean;
  inscricaoMudou?: boolean;
  semAviso?: readonly string[];
  avisoFalha?: readonly string[];
  config?: ConfigDaListaDeEspera | null;
  situacoes?: Map<string, string>;
}) {
  const compromissos =
    estado.compromissos ??
    new Map<string, CompromissoFalso>([
      [
        "vaga-1",
        {
          id: "vaga-1",
          startsAt: VAGA_INICIO,
          endsAt: new Date(VAGA_INICIO.getTime() + 60 * 60_000),
          ownerUserId: "doutora-ana",
          status: "cancelled",
        },
      ],
    ]);
  const situacoes =
    estado.situacoes ??
    new Map<string, string>(estado.fila.map((i) => [i.id, "waiting"] as const));
  const servicos = estado.servicos ?? { limpeza: servico() };
  const chamadas: string[] = [];
  const segurados: PedidoDeOferta[] = [];
  let proximoId = 0;

  const esperaIdDono = new Map<string, string>();
  const prazos = new Map<string, Date>();
  const buracos = new Map<string, Date>();
  const recusadas = new Map<string, Date>();

  const ofertaCorrente = (esperaId: string) => {
    for (const [id, c] of compromissos) {
      if (c.status !== "pending") continue;
      // O rastro liga a vaga segurada de volta à inscrição.
      if (esperaIdDono.get(id) !== esperaId) continue;
      return {
        esperaId,
        contatoId: `contato-${esperaId}`,
        compromissoId: id,
        compromissoStatus: c.status as string,
        contatoDisponivel: true,
        expiraEm: prazos.get(id) ?? new Date(0),
        vagaFim: buracos.get(id) ?? c.endsAt,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        ownerUserId: c.ownerUserId,
        timeZone: FUSO,
      };
    }
    return null;
  };

  const porta: PortaDoEncaixe & { chamadas: string[]; segurados: PedidoDeOferta[] } = {
    chamadas,
    segurados,
    async config() {
      return estado.config === undefined ? CONFIG : estado.config;
    },
    async vaga(_org, appointmentId) {
      const c = compromissos.get(appointmentId);
      if (!c || c.status !== "cancelled") return null;
      const vaga: VagaAberta = {
        appointmentId: c.id,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        ownerUserId: c.ownerUserId,
        timeZone: FUSO,
      };
      return vaga;
    },
    async fila() {
      return estado.fila
        .filter((i) => situacoes.get(i.id) === "waiting")
        .map((i) => ({ ...i, vagaRecusadaInicio: recusadas.get(i.id) ?? null }));
    },
    async servico(_org, eventTypeId) {
      return servicos[eventTypeId] ?? null;
    },
    async podeAvisar(_org, contatoId) {
      return !estado.semAviso?.includes(contatoId);
    },
    async ofertar(pedido) {
      chamadas.push(`ofertar:${pedido.esperaId}`);
      if (estado.colisao) return { ok: false, motivo: "vaga_ja_ocupada" };
      if (estado.inscricaoMudou) return { ok: false, motivo: "inscricao_mudou" };
      segurados.push(pedido);
      const id = `hold-${(proximoId += 1)}`;
      compromissos.set(id, {
        id,
        startsAt: pedido.inicio,
        endsAt: pedido.fim,
        ownerUserId: pedido.ownerUserId,
        status: "pending",
      });
      esperaIdDono.set(id, pedido.esperaId);
      prazos.set(id, pedido.expiraEm);
      buracos.set(id, pedido.vagaFim);
      situacoes.set(pedido.esperaId, "offered");
      return { ok: true, compromissoId: id };
    },
    async avisar(_org, contatoId) {
      chamadas.push(`avisar:${contatoId}`);
      return !estado.avisoFalha?.includes(contatoId);
    },
    async oferta(_org, esperaId) {
      if (situacoes.get(esperaId) !== "offered") return null;
      return ofertaCorrente(esperaId);
    },
    async ofertasVencidas(_org, agora) {
      const vencidas = [];
      for (const i of estado.fila) {
        if (situacoes.get(i.id) !== "offered") continue;
        const oferta = ofertaCorrente(i.id);
        if (oferta && oferta.expiraEm.getTime() <= agora.getTime()) vencidas.push(oferta);
      }
      return vencidas;
    },
    async soltar(_org, compromissoId, _motivo) {
      chamadas.push(`soltar:${compromissoId}`);
      const c = compromissos.get(compromissoId);
      if (c && c.status === "pending") c.status = "cancelled";
    },
    async situar(_org, esperaId, situacao, vagaRecusada) {
      chamadas.push(`situar:${esperaId}:${situacao}`);
      situacoes.set(esperaId, situacao);
      if (vagaRecusada) recusadas.set(esperaId, vagaRecusada);
    },
  };

  return porta;
}

let fila: InscricaoNaEspera[];

beforeEach(() => {
  fila = [inscricao("a"), inscricao("b")];
});

describe("oferecer a vaga que abriu", () => {
  it("segura o horário para a primeira pessoa da fila que cabe", async () => {
    const porta = criarPorta({ fila });
    const r = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });

    expect(r.ofertada).toBe(true);
    if (!r.ofertada) return;
    expect(r.esperaId).toBe("a");
    expect(r.contatoId).toBe("contato-a");
    expect(r.expiraEm.getTime()).toBe(AGORA.getTime() + 90 * 60_000);
    expect(r.texto).toContain("Limpeza");
    // A vaga segurada dura o SERVIÇO, não o buraco inteiro.
    expect(porta.segurados[0]?.inicio.getTime()).toBe(VAGA_INICIO.getTime());
    expect(porta.segurados[0]?.fim.getTime()).toBe(VAGA_INICIO.getTime() + 60 * 60_000);
    expect(porta.segurados[0]?.ownerUserId).toBe("doutora-ana");
    expect(porta.chamadas).toEqual(["ofertar:a", "avisar:contato-a"]);
  });

  it("com a organização desligada, ou sem prazos, nada é lido nem segurado", async () => {
    const porta = criarPorta({ fila, config: null });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r).toEqual({ ofertada: false, motivo: "desligada" });
    expect(porta.chamadas).toEqual([]);
  });

  it("quem não pode ser avisado agora não recebe a vaga: chama o próximo", async () => {
    const porta = criarPorta({ fila, semAviso: ["contato-a"] });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r.ofertada && r.esperaId).toBe("b");
    expect(porta.chamadas).not.toContain("ofertar:a");
  });

  it("aviso que não saiu solta a vaga, devolve a pessoa e segue a fila", async () => {
    const porta = criarPorta({ fila, avisoFalha: ["contato-a"] });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r.ofertada && r.esperaId).toBe("b");
    expect(porta.chamadas).toEqual([
      "ofertar:a",
      "avisar:contato-a",
      "soltar:hold-1",
      "situar:a:waiting",
      "ofertar:b",
      "avisar:contato-b",
    ]);
  });

  it("pula quem não cabe e chama o próximo — o primeiro da fila não é o primeiro que serve", async () => {
    fila = [inscricao("a", { eventTypeId: "longo" }), inscricao("b")];
    const porta = criarPorta({
      fila,
      servicos: {
        limpeza: servico(),
        longo: servico({ eventTypeId: "longo", duracaoMinutos: 90 }),
      },
    });
    const r = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    expect(r.ofertada && r.esperaId).toBe("b");
  });

  it("sem ninguém que caiba, NINGUÉM fica com o horário segurado", async () => {
    fila = [inscricao("a", { antecedenciaMinimaHoras: 72 })];
    const porta = criarPorta({ fila });
    const r = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    expect(r).toEqual({ ofertada: false, motivo: "sem_candidato" });
    expect(porta.chamadas).toEqual([]);
    expect(porta.segurados).toHaveLength(0);
  });

  it("compromisso que não está desmarcado não abre vaga", async () => {
    const porta = criarPorta({
      fila,
      compromissos: new Map([
        ["vaga-1", { id: "vaga-1", startsAt: VAGA_INICIO, endsAt: VAGA_INICIO, ownerUserId: null, status: "confirmed" }],
      ]),
    });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r).toEqual({ ofertada: false, motivo: "vaga_indisponivel" });
  });

  it("vaga que começa em 20 minutos não é oferecida", async () => {
    const inicio = new Date(AGORA.getTime() + 20 * 60_000);
    const porta = criarPorta({
      fila,
      compromissos: new Map([
        [
          "vaga-1",
          { id: "vaga-1", startsAt: inicio, endsAt: new Date(inicio.getTime() + 60 * 60_000), ownerUserId: null, status: "cancelled" },
        ],
      ]),
    });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r).toEqual({ ofertada: false, motivo: "vaga_perto_demais" });
  });

  it("se outra marcação pegou o instante, o encaixe desiste em vez de prometer", async () => {
    const porta = criarPorta({ fila, colisao: true });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r).toEqual({ ofertada: false, motivo: "vaga_ja_ocupada" });
  });

  it("inscrição que saiu da fila na corrida não segura nada", async () => {
    const porta = criarPorta({ fila, inscricaoMudou: true });
    const r = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    expect(r).toEqual({ ofertada: false, motivo: "sem_candidato" });
    expect(porta.segurados).toHaveLength(0);
  });
});

describe("a pessoa respondeu SIM", () => {
  it("confirma o compromisso segurado e tira a inscrição da fila", async () => {
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    expect(oferta.ofertada).toBe(true);
    if (!oferta.ofertada) return;

    const confirmados: string[] = [];
    const r = await aceitarEncaixe(
      porta,
      { organizationId: ORG, esperaId: oferta.esperaId, agora: AGORA },
      async (id) => {
        confirmados.push(id);
        return true;
      },
    );
    expect(r).toEqual({ aceito: true, compromissoId: oferta.compromissoId });
    expect(confirmados).toEqual([oferta.compromissoId]);
    expect(porta.chamadas).toContain(`situar:${oferta.esperaId}:booked`);
  });

  it("compromisso que caiu antes do SIM NÃO vira aceito, e a pessoa volta à fila", async () => {
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    if (!oferta.ofertada) throw new Error("esperava oferta");

    const r = await aceitarEncaixe(
      porta,
      { organizationId: ORG, esperaId: oferta.esperaId, agora: AGORA },
      async () => false,
    );
    expect(r).toEqual({ aceito: false, motivo: "vaga_perdida" });
    expect(porta.chamadas).not.toContain(`situar:${oferta.esperaId}:booked`);
    expect(porta.chamadas).toContain(`situar:${oferta.esperaId}:waiting`);
  });

  it("SIM depois do prazo NÃO confirma — a vaga pode já ter ido para o próximo", async () => {
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    if (!oferta.ofertada) throw new Error("esperava oferta");

    const depois = new Date(oferta.expiraEm.getTime() + 1);
    let confirmou = false;
    const r = await aceitarEncaixe(
      porta,
      { organizationId: ORG, esperaId: oferta.esperaId, agora: depois },
      async () => {
        confirmou = true;
        return true;
      },
    );
    expect(r).toEqual({ aceito: false, motivo: "oferta_vencida" });
    expect(confirmou).toBe(false);
  });

  it("SIM sem oferta de pé não inventa compromisso", async () => {
    const porta = criarPorta({ fila });
    const r = await aceitarEncaixe(porta, { organizationId: ORG, esperaId: "a", agora: AGORA }, confirmaSempre);
    expect(r).toEqual({ aceito: false, motivo: "sem_oferta" });
  });
});

describe("a pessoa respondeu NÃO", () => {
  it("solta a vaga, chama o PRÓXIMO e só então devolve ela à fila", async () => {
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    if (!oferta.ofertada) throw new Error("esperava oferta");
    expect(oferta.esperaId).toBe("a");

    const r = await recusarEncaixe(porta, {
      organizationId: ORG,
      esperaId: "a",
      definitivo: false,
      agora: AGORA,
    });

    expect(r.solta).toBe(true);
    expect(r.proximo?.ofertada).toBe(true);
    if (!r.proximo?.ofertada) return;
    // O laço que este teste existe para impedir: a mesma pessoa de novo.
    expect(r.proximo.esperaId).toBe("b");

    // A ORDEM, medida: soltou → ofereceu ao próximo → reativou quem recusou.
    const indiceSoltar = porta.chamadas.indexOf(`soltar:${oferta.compromissoId}`);
    const indiceProximo = porta.chamadas.indexOf("ofertar:b");
    const indiceReativar = porta.chamadas.indexOf("situar:a:waiting");
    expect(indiceSoltar).toBeGreaterThanOrEqual(0);
    expect(indiceProximo).toBeGreaterThan(indiceSoltar);
    expect(indiceReativar).toBeGreaterThan(indiceProximo);
  });

  it("a vaga NÃO encolhe: o próximo enxerga o buraco original, não o serviço de quem recusou", async () => {
    fila = [inscricao("a", { eventTypeId: "curto" }), inscricao("b")];
    const porta = criarPorta({
      fila,
      servicos: { curto: servico({ eventTypeId: "curto", duracaoMinutos: 30 }), limpeza: servico() },
    });
    const oferta = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    if (!oferta.ofertada) throw new Error("esperava oferta");
    expect(porta.segurados[0]?.fim.getTime()).toBe(VAGA_INICIO.getTime() + 30 * 60_000);

    const r = await recusarEncaixe(porta, { organizationId: ORG, esperaId: "a", definitivo: false, agora: AGORA });
    expect(r.proximo?.ofertada && r.proximo.esperaId).toBe("b");
    expect(porta.segurados[1]?.fim.getTime()).toBe(VAGA_INICIO.getTime() + 60 * 60_000);
  });

  it("a vaga recusada não volta a quem a recusou quando o próximo também recusa", async () => {
    const porta = criarPorta({ fila });
    await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    await recusarEncaixe(porta, { organizationId: ORG, esperaId: "a", definitivo: false, agora: AGORA });
    const r = await recusarEncaixe(porta, { organizationId: ORG, esperaId: "b", definitivo: false, agora: AGORA });
    expect(r.proximo).toEqual({ ofertada: false, motivo: "sem_candidato" });
    expect(porta.chamadas.filter((c) => c === "ofertar:a")).toHaveLength(1);
  });

  it("'não quero mais encaixe' tira a pessoa da fila em vez de reativá-la", async () => {
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    if (!oferta.ofertada) throw new Error("esperava oferta");

    await recusarEncaixe(porta, { organizationId: ORG, esperaId: "a", definitivo: true, agora: AGORA });
    expect(porta.chamadas).toContain("situar:a:cancelled");
    expect(porta.chamadas).not.toContain("situar:a:waiting");
  });

  it("sem oferta de pé não há vaga para soltar", async () => {
    const porta = criarPorta({ fila });
    const r = await recusarEncaixe(porta, {
      organizationId: ORG,
      esperaId: "a",
      definitivo: false,
      agora: AGORA,
    });
    expect(r).toEqual({ solta: false, proximo: null });
  });
});

describe("a oferta venceu sem resposta", () => {
  it("solta a vaga, chama o próximo e devolve quem não respondeu à fila", async () => {
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    if (!oferta.ofertada) throw new Error("esperava oferta");

    const depois = new Date(oferta.expiraEm.getTime() + 60_000);
    const r = await vencerOfertas(porta, { organizationId: ORG, agora: depois });

    expect(r.vencidas).toBe(1);
    expect(r.reoferecidas).toBe(1);
    expect(porta.chamadas).toContain(`soltar:${oferta.compromissoId}`);
    expect(porta.chamadas).toContain("ofertar:b");
    expect(porta.chamadas).toContain("situar:a:waiting");
  });

  it("vencida que não acha próximo deixa o horário LIVRE — vazio e disponível é melhor que preso", async () => {
    fila = [inscricao("a")];
    const porta = criarPorta({ fila });
    const oferta = await oferecerVagaQueAbriu(porta, {
      organizationId: ORG,
      appointmentId: "vaga-1",
      agora: AGORA,
    });
    if (!oferta.ofertada) throw new Error("esperava oferta");

    const r = await vencerOfertas(porta, {
      organizationId: ORG,
      agora: new Date(oferta.expiraEm.getTime() + 60_000),
    });
    expect(r).toEqual({ vencidas: 1, reoferecidas: 0 });
  });

  it("compromisso confirmado cujo fecho não aconteceu vira `booked`, não volta à fila", async () => {
    const compromissos = new Map<string, CompromissoFalso>([
      ["vaga-1", { id: "vaga-1", startsAt: VAGA_INICIO, endsAt: new Date(VAGA_INICIO.getTime() + 3_600_000), ownerUserId: "x", status: "cancelled" }],
    ]);
    const porta = criarPorta({ fila, compromissos });
    const oferta = await oferecerVagaQueAbriu(porta, { organizationId: ORG, appointmentId: "vaga-1", agora: AGORA });
    if (!oferta.ofertada) throw new Error("esperava oferta");
    const hold = compromissos.get(oferta.compromissoId);
    if (hold) hold.status = "pending";
    const r0 = await porta.oferta(ORG, oferta.esperaId);
    expect(r0?.compromissoStatus).toBe("pending");

    porta.ofertasVencidas = async () => [{ ...r0!, compromissoStatus: "confirmed" }];
    const r = await vencerOfertas(porta, { organizationId: ORG, agora: new Date(oferta.expiraEm.getTime() + 60_000) });
    expect(r).toEqual({ vencidas: 1, reoferecidas: 0 });
    expect(porta.chamadas).toContain("situar:a:booked");
    expect(porta.chamadas).not.toContain(`soltar:${oferta.compromissoId}`);
  });

  it("nada vencido não mexe em nada", async () => {
    const porta = criarPorta({ fila });
    const r = await vencerOfertas(porta, { organizationId: ORG, agora: AGORA });
    expect(r).toEqual({ vencidas: 0, reoferecidas: 0 });
    expect(porta.chamadas).toEqual([]);
  });
});

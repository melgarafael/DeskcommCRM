/**
 * QUEM CABE NA VAGA QUE ABRIU — e em que ordem a fila é chamada.
 *
 * A régua que este arquivo protege é a do ISSUE #3414: uma desmarcação abre um
 * horário, e quem pediu encaixe tem de ser chamado por URGÊNCIA e ORDEM DE
 * CHEGADA, mas só se o atendimento INTEIRO couber no buraco, no profissional
 * pedido, dentro da janela que a pessoa ofereceu e com antecedência suficiente
 * para ela se organizar.
 *
 * Cada caso aqui é um jeito de encaixar errado, e o jeito de encaixar errado é
 * sempre o mesmo sintoma para o cliente: o CRM oferece um horário que não dá
 * para cumprir, ele responde SIM, e alguém descobre no dia.
 */
import { describe, expect, it } from "vitest";

import type { ScheduleWindow } from "@/lib/schemas/routing";

import {
  cabeNaJanela,
  decideEncaixe,
  escolherCandidato,
  ordenarFila,
  prazoDaOferta,
  textoDaOferta,
  type InscricaoNaEspera,
  type ServicoDaEspera,
  type VagaAberta,
} from "@/lib/agenda/lista-de-espera";

const FUSO = "America/Sao_Paulo";
/** Terça 03/11/2026, 09:00 em São Paulo (UTC-3). */
const TERCA_9H = new Date("2026-11-03T12:00:00.000Z");
const AGORA = new Date("2026-11-03T09:00:00.000Z");

function vaga(over: Partial<VagaAberta> = {}): VagaAberta {
  return {
    appointmentId: "vaga-1",
    startsAt: TERCA_9H,
    endsAt: new Date(TERCA_9H.getTime() + 60 * 60_000),
    ownerUserId: "doutora-ana",
    timeZone: FUSO,
    ...over,
  };
}

function servico(over: Partial<ServicoDaEspera> = {}): ServicoDaEspera {
  return {
    eventTypeId: "servico-limpeza",
    nome: "Limpeza",
    duracaoMinutos: 60,
    avisoMinimoMinutos: 0,
    ...over,
  };
}

function inscricao(over: Partial<InscricaoNaEspera> = {}): InscricaoNaEspera {
  return {
    id: "espera-1",
    contactId: "contato-1",
    eventTypeId: "servico-limpeza",
    ownerUserId: null,
    janelas: [],
    antecedenciaMinimaHoras: 0,
    validoAte: null,
    urgencia: 0,
    createdAt: new Date("2026-11-01T10:00:00.000Z"),
    ...over,
  };
}

const TERCA_DE_MANHA: ScheduleWindow = { dow: 2, start: "09:00", end: "12:00" };

describe("o que a vaga comporta", () => {
  it("recusa serviço mais longo que o buraco — 90 min num buraco de 60", () => {
    const decisao = decideEncaixe(vaga(), servico({ duracaoMinutos: 90 }), inscricao(), AGORA);
    expect(decisao).toEqual({ cabe: false, motivo: "servico_nao_cabe" });
  });

  it("aceita serviço que termina EXATAMENTE no fim da vaga", () => {
    const decisao = decideEncaixe(vaga(), servico({ duracaoMinutos: 60 }), inscricao(), AGORA);
    expect(decisao).toEqual({ cabe: true });
  });

  it("vaga de 2h aceita dois encaixes de 1h diferentes — a duração é do serviço, não da vaga", () => {
    const vagaDeDuasHoras = vaga({ endsAt: new Date(TERCA_9H.getTime() + 120 * 60_000) });
    expect(decideEncaixe(vagaDeDuasHoras, servico({ duracaoMinutos: 60 }), inscricao(), AGORA)).toEqual({
      cabe: true,
    });
  });
});

describe("o profissional", () => {
  it("recusa quando a pessoa pediu outro profissional", () => {
    const decisao = decideEncaixe(
      vaga(),
      servico(),
      inscricao({ ownerUserId: "doutor-bruno" }),
      AGORA,
    );
    expect(decisao).toEqual({ cabe: false, motivo: "profissional_diferente" });
  });

  it("aceita quando a pessoa pediu aquele profissional", () => {
    expect(
      decideEncaixe(vaga(), servico(), inscricao({ ownerUserId: "doutora-ana" }), AGORA),
    ).toEqual({ cabe: true });
  });

  it("'qualquer profissional' aceita a vaga de quem abriu", () => {
    expect(decideEncaixe(vaga(), servico(), inscricao({ ownerUserId: null }), AGORA)).toEqual({
      cabe: true,
    });
  });
});

describe("as janelas que a pessoa ofereceu", () => {
  it("lista vazia é 'qualquer horário', e não 'nenhum'", () => {
    const deMadrugada = vaga({
      startsAt: new Date("2026-11-04T06:00:00.000Z"),
      endsAt: new Date("2026-11-04T07:00:00.000Z"),
    });
    expect(decideEncaixe(deMadrugada, servico(), inscricao({ janelas: [] }), AGORA)).toEqual({
      cabe: true,
    });
  });

  it("aceita dentro da janela do dia certo", () => {
    const inscricaoComJanela = inscricao({ janelas: [TERCA_DE_MANHA] });
    expect(decideEncaixe(vaga(), servico(), inscricaoComJanela, AGORA)).toEqual({ cabe: true });
  });

  it("recusa em outro dia da semana", () => {
    const quarta: ScheduleWindow = { dow: 3, start: "09:00", end: "12:00" };
    expect(decideEncaixe(vaga(), servico(), inscricao({ janelas: [quarta] }), AGORA)).toEqual({
      cabe: false,
      motivo: "fora_da_janela",
    });
  });

  it("recusa 11:30 num serviço de 60 min quando a janela termina ao meio-dia", () => {
    // O caso que a primeira versão deixava passar: comparava só o INÍCIO, e o
    // atendimento terminaria 12:30 — fora do que a pessoa disse que podia.
    const onzeEMeia = vaga({
      startsAt: new Date("2026-11-03T14:30:00.000Z"),
      endsAt: new Date("2026-11-03T15:30:00.000Z"),
    });
    expect(decideEncaixe(onzeEMeia, servico(), inscricao({ janelas: [TERCA_DE_MANHA] }), AGORA)).toEqual({
      cabe: false,
      motivo: "fora_da_janela",
    });
    // Controle: no mesmo dia, 10:00 cabe.
    const dez = vaga({
      startsAt: new Date("2026-11-03T13:00:00.000Z"),
      endsAt: new Date("2026-11-03T14:00:00.000Z"),
    });
    expect(decideEncaixe(dez, servico(), inscricao({ janelas: [TERCA_DE_MANHA] }), AGORA)).toEqual({
      cabe: true,
    });
  });

  it("janela com texto que não é hora não vira regra: é descartada", () => {
    const quebrada = [{ dow: 2, start: "manhã", end: "12:00" }] as unknown as ScheduleWindow[];
    expect(cabeNaJanela(quebrada, TERCA_9H, 60, FUSO)).toBe(false);
    // E sozinha ela não pode abrir a régua: a lista não é vazia, então não é
    // "qualquer horário" — é "nenhuma janela válida".
    expect(decideEncaixe(vaga(), servico(), inscricao({ janelas: quebrada }), AGORA)).toEqual({
      cabe: false,
      motivo: "fora_da_janela",
    });
  });
});

describe("a antecedência", () => {
  it("recusa quando a pessoa pediu 48h e a vaga é daqui a 3h", () => {
    const decisao = decideEncaixe(vaga(), servico(), inscricao({ antecedenciaMinimaHoras: 48 }), AGORA);
    expect(decisao).toEqual({ cabe: false, motivo: "antecedencia_insuficiente" });
  });

  it("a antecedência do SERVIÇO também vale — quem precisa de 2h não é chamado para daqui a 1h", () => {
    const vagaDaquiAUmaHora = vaga({
      startsAt: new Date(AGORA.getTime() + 60 * 60_000),
      endsAt: new Date(AGORA.getTime() + 120 * 60_000),
    });
    const decisao = decideEncaixe(
      vagaDaquiAUmaHora,
      servico({ avisoMinimoMinutos: 120 }),
      inscricao(),
      AGORA,
    );
    expect(decisao).toEqual({ cabe: false, motivo: "antecedencia_insuficiente" });
  });

  it("as duas antecedências somam por MAIOR: 48h da pessoa vence as 2h do serviço", () => {
    const vagaDaquiA3h = vaga({
      startsAt: new Date(AGORA.getTime() + 3 * 60 * 60_000),
      endsAt: new Date(AGORA.getTime() + 4 * 60 * 60_000),
    });
    expect(
      decideEncaixe(
        vagaDaquiA3h,
        servico({ avisoMinimoMinutos: 120 }),
        inscricao({ antecedenciaMinimaHoras: 48 }),
        AGORA,
      ),
    ).toEqual({ cabe: false, motivo: "antecedencia_insuficiente" });
    // Controle: com 2h de antecedência da pessoa, a mesma vaga de 3h serve.
    expect(
      decideEncaixe(
        vagaDaquiA3h,
        servico({ avisoMinimoMinutos: 120 }),
        inscricao({ antecedenciaMinimaHoras: 2 }),
        AGORA,
      ),
    ).toEqual({ cabe: true });
  });
});

describe("prazo e validade", () => {
  it("inscrição vencida não é chamada", () => {
    const decisao = decideEncaixe(
      vaga(),
      servico(),
      inscricao({ validoAte: new Date("2026-11-02T00:00:00.000Z") }),
      AGORA,
    );
    expect(decisao).toEqual({ cabe: false, motivo: "inscricao_vencida" });
  });

  it("vaga que já começou não é oferecida", () => {
    const decisao = decideEncaixe(vaga({ startsAt: new Date("2026-11-03T08:00:00.000Z") }), servico(), inscricao(), AGORA);
    expect(decisao).toEqual({ cabe: false, motivo: "vaga_no_passado" });
  });
});

describe("a ordem da fila", () => {
  it("urgência vence ordem de chegada", () => {
    const antiga = inscricao({ id: "a", urgencia: 0, createdAt: new Date("2026-10-01T10:00:00.000Z") });
    const urgente = inscricao({ id: "b", urgencia: 5, createdAt: new Date("2026-11-01T10:00:00.000Z") });
    expect(ordenarFila([antiga, urgente]).map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("no empate de urgência, quem chegou primeiro", () => {
    const primeira = inscricao({ id: "a", createdAt: new Date("2026-10-01T10:00:00.000Z") });
    const segunda = inscricao({ id: "b", createdAt: new Date("2026-10-02T10:00:00.000Z") });
    expect(ordenarFila([segunda, primeira]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("empate total é desempatado pelo id — a ordem não pode alternar entre rodadas", () => {
    const x = inscricao({ id: "b" });
    const y = inscricao({ id: "a" });
    expect(ordenarFila([x, y]).map((i) => i.id)).toEqual(["a", "b"]);
    expect(ordenarFila([y, x]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("escolhe o primeiro que CABE, e não o primeiro da fila", () => {
    const naoCabe = inscricao({ id: "a", eventTypeId: "servico-longa" });
    const cabe = inscricao({ id: "b", eventTypeId: "servico-limpeza" });
    const escolhido = escolherCandidato(
      vaga(),
      [naoCabe, cabe],
      (id) => (id === "servico-longa" ? servico({ eventTypeId: id, duracaoMinutos: 90 }) : servico({ eventTypeId: id })),
      AGORA,
    );
    expect(escolhido?.inscricao.id).toBe("b");
  });

  it("serviço que não existe mais não entra na conta", () => {
    const escolhido = escolherCandidato(
      vaga(),
      [inscricao({ id: "a", eventTypeId: "apagado" })],
      () => null,
      AGORA,
    );
    expect(escolhido).toBeNull();
  });
});

describe("o prazo da oferta", () => {
  it("para vaga distante, o teto é de duas horas", () => {
    const vagaDaquiA3Dias = vaga({
      startsAt: new Date(AGORA.getTime() + 72 * 60 * 60_000),
      endsAt: new Date(AGORA.getTime() + 73 * 60 * 60_000),
    });
    expect(prazoDaOferta(vagaDaquiA3Dias, AGORA)?.getTime()).toBe(
      AGORA.getTime() + 2 * 60 * 60_000,
    );
  });

  it("para vaga próxima, o prazo fecha 15 min antes dela — e não depois do início", () => {
    const vagaDaquiA3h = vaga({
      startsAt: new Date(AGORA.getTime() + 3 * 60 * 60_000),
      endsAt: new Date(AGORA.getTime() + 4 * 60 * 60_000),
    });
    expect(prazoDaOferta(vagaDaquiA3h, AGORA)?.getTime()).toBe(
      AGORA.getTime() + 2 * 60 * 60_000,
    );
    const vagaDaquiAUmaHoraEMeia = vaga({
      startsAt: new Date(AGORA.getTime() + 90 * 60_000),
      endsAt: new Date(AGORA.getTime() + 150 * 60_000),
    });
    expect(prazoDaOferta(vagaDaquiAUmaHoraEMeia, AGORA)?.getTime()).toBe(
      AGORA.getTime() + 75 * 60_000,
    );
  });

  it("vaga perto demais não é oferecida — promessa que já nasce vencida", () => {
    const vagaDaquiA20Min = vaga({
      startsAt: new Date(AGORA.getTime() + 20 * 60_000),
      endsAt: new Date(AGORA.getTime() + 80 * 60_000),
    });
    expect(prazoDaOferta(vagaDaquiA20Min, AGORA)).toBeNull();
  });

});

describe("o texto da oferta", () => {
  it("diz o dia, a hora, o serviço, a duração e ATÉ QUANDO responder", () => {
    const expiraEm = new Date("2026-11-03T11:45:00.000Z"); // 08:45 local
    const texto = textoDaOferta(vaga(), servico(), expiraEm);
    expect(texto).toContain("terça-feira 03/11 às 09:00");
    expect(texto).toContain("Limpeza");
    expect(texto).toContain("60 min");
    expect(texto).toContain("08:45");
    expect(texto.toLowerCase()).toContain("sim");
  });
});

/**
 * A tradução de campos entre um agendamento nosso e um evento do Google.
 *
 * Sync não falha com barulho — falha gravando o horário errado. Cada caso aqui
 * é uma forma medida de escrever ou ler a hora errada, e nenhuma delas aparece
 * como erro: aparece como cliente chegando no dia errado.
 */
import { describe, expect, it } from "vitest";

import { ehEventoNosso, idDeEventoDoGoogle } from "@/lib/agenda/google/escrita";

import {
  type AgendamentoParaGoogle,
  type EventoDoGoogle,
  type EventoExternoLido,
  type LeituraDeEvento,
  doEventoDoGoogle,
  paraEventoDoGoogle,
} from "@/lib/agenda/google/evento";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENDAMENTO = "22222222-2222-4222-8222-222222222222";

function agendamento(sobrescreve: Partial<AgendamentoParaGoogle> = {}): AgendamentoParaGoogle {
  return {
    id: AGENDAMENTO,
    organization_id: ORG,
    title: "Consulta de avaliação",
    description: "Primeira consulta",
    starts_at: "2026-09-02T17:00:00.000Z",
    ends_at: "2026-09-02T17:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    location_kind: "in_person",
    location_details: "Rua das Acácias, 120",
    ...sobrescreve,
  };
}

/** Estreita a união sem deixar o teste passar por desvio. */
function eventoLido(r: LeituraDeEvento): EventoExternoLido {
  if (r.tipo !== "evento") throw new Error(`esperava um evento legível, veio "${r.tipo}"`);
  return r.evento;
}

const FUSO_DO_CALENDARIO = { fusoDoCalendario: "America/Sao_Paulo" };

// ─── IDA ───────────────────────────────────────────────────────────────────

describe("paraEventoDoGoogle", () => {
  it("escreve instante com fuso, e o instante é o nosso", () => {
    const corpo = paraEventoDoGoogle(agendamento());
    expect(corpo.start).toEqual({ dateTime: "2026-09-02T17:00:00.000Z", timeZone: "America/Sao_Paulo" });
    expect(corpo.end).toEqual({ dateTime: "2026-09-02T17:30:00.000Z", timeZone: "America/Sao_Paulo" });
  });

  it("nunca escreve dia inteiro: um agendamento nosso sempre tem hora", () => {
    const corpo = paraEventoDoGoogle(agendamento());
    expect(corpo.start).not.toHaveProperty("date");
    expect(corpo.end).not.toHaveProperty("date");
  });

  it("normaliza o instante venha ele em UTC ou com deslocamento", () => {
    const comOffset = paraEventoDoGoogle(
      agendamento({ starts_at: "2026-09-02T14:00:00-03:00", ends_at: "2026-09-02T14:30:00-03:00" }),
    );
    expect(comOffset.start.dateTime).toBe("2026-09-02T17:00:00.000Z");
    expect(comOffset.end.dateTime).toBe("2026-09-02T17:30:00.000Z");
  });

  it("o compromisso SEMPRE ocupa a agenda", () => {
    expect(paraEventoDoGoogle(agendamento()).transparency).toBe("opaque");
  });

  it("traduz os cinco status nossos nos três do Google", () => {
    const de = (status: AgendamentoParaGoogle["status"]) => paraEventoDoGoogle(agendamento({ status })).status;
    expect(de("pending")).toBe("tentative");
    expect(de("confirmed")).toBe("confirmed");
    expect(de("cancelled")).toBe("cancelled");
    // `completed` e `no_show` descrevem o DEPOIS. O horário esteve ocupado, e
    // rebaixá-los a `cancelled` reescreveria a agenda do atendente no passado.
    expect(de("completed")).toBe("confirmed");
    expect(de("no_show")).toBe("confirmed");
  });

  it("⚠️ o corpo NÃO leva iCalUID — mandá-lo junto do id é o que produzia 400", () => {
    // ─── A ASSERÇÃO INVERTIDA, e o porquê ────────────────────────────────
    //
    // Este caso exigia `iCalUID` no corpo. A referência do `events.insert` diz
    // que `id` e `iCalUID` "only one of them should be supplied at event
    // creation time" — e o push manda o `id` sempre.
    //
    // Medido em produção em 2026-09-01, a cada 5 minutos, por horas:
    //
    //   HTTP 400 — {"reason":"invalid","message":"Invalid resource id value."}
    //
    // O `id` foi medido e É válido (43 caracteres, todos em [a-v0-9]). O que
    // violava contrato era a COPRESENÇA. Nenhum compromisso jamais chegou ao
    // Google, em instalação nenhuma — e este teste passava verde o tempo todo,
    // porque media o corpo contra si mesmo e nunca contra a API.
    const corpo = paraEventoDoGoogle(agendamento());
    expect(corpo, "iCalUID de volta ao corpo — o 400 volta junto").not.toHaveProperty("iCalUID");

    // O que amarra o evento de lá à linha daqui passa a ser o ID, que é nosso
    // por construção e que o Google preserva.
    expect(idDeEventoDoGoogle(AGENDAMENTO).startsWith("deskcommapp")).toBe(true);
    expect(ehEventoNosso(idDeEventoDoGoogle(AGENDAMENTO))).toBe(true);
    // E o controle: evento de terceiro não é reconhecido como nosso.
    expect(ehEventoNosso("abc123doGoogle")).toBe(false);
    expect(ehEventoNosso(null)).toBe(false);
  });

  it("carrega a identidade do tenant nas propriedades privadas", () => {
    // Sem isto não há como perguntar ao Google "quais eventos desta agenda são
    // meus" sem varrer o calendário inteiro.
    const corpo = paraEventoDoGoogle(agendamento());
    expect(corpo.extendedProperties.private).toMatchObject({
      deskcomm_org: ORG,
      deskcomm_appointment: AGENDAMENTO,
    });
  });

  it("não manda `sequence` nem `recurrence` — e isso é decisão, não esquecimento", () => {
    // `sequence` é do Google: mandar número menor que o de lá devolve 400.
    // `recurrence` está fora do escopo desta entrega.
    const corpo = paraEventoDoGoogle(agendamento());
    expect(corpo).not.toHaveProperty("sequence");
    expect(corpo).not.toHaveProperty("recurrence");
  });

  it("o alarme que vai é o do dono da agenda, não o do cliente", () => {
    // O lembrete do cliente sai pela nossa cadeia de envio (WhatsApp). Este é o
    // pop-up que o atendente já configurou no calendário dele.
    expect(paraEventoDoGoogle(agendamento()).reminders).toEqual({ useDefault: true });
  });

  it("escreve o local de acordo com o tipo, e não inventa link que ainda não existe", () => {
    const local = (a: Partial<AgendamentoParaGoogle>) => paraEventoDoGoogle(agendamento(a)).location;
    expect(local({ location_kind: "in_person" })).toBe("Rua das Acácias, 120");
    expect(local({ location_kind: "phone", location_details: "+55 11 90000-0000" })).toBe("+55 11 90000-0000");
    expect(local({ location_kind: "whatsapp", location_details: null })).toBe("WhatsApp");
    expect(local({ location_kind: "video_link", meeting_url: "https://meet.exemplo/abc" })).toBe(
      "https://meet.exemplo/abc",
    );
    // O link do Meet só nasce DEPOIS do insert; antes dele, não há local.
    expect(local({ location_kind: "google_meet", location_details: null, meeting_url: null })).toBeUndefined();
  });

  it("marca o organizador e já confirma todo mundo", () => {
    const corpo = paraEventoDoGoogle(
      agendamento({
        participantes: [
          { email: "atendente@clinica.com.br", nome: "Dra. Ana", organizador: true },
          { email: "cliente@exemplo.com" },
        ],
      }),
    );
    expect(corpo.attendees).toEqual([
      {
        email: "atendente@clinica.com.br",
        responseStatus: "accepted",
        displayName: "Dra. Ana",
        organizer: true,
      },
      { email: "cliente@exemplo.com", responseStatus: "accepted" },
    ]);
  });

  it("agendamento sem convidado não manda a chave — é o caso comum do WhatsApp", () => {
    // Lead que veio do WhatsApp costuma ter só telefone. Ele não vira convidado
    // e o evento continua válido.
    const corpo = paraEventoDoGoogle(agendamento());
    expect(corpo).not.toHaveProperty("attendees");
  });

  it("recusa a linha que não é traduzível, em vez de mandar evento pela metade", () => {
    expect(() => paraEventoDoGoogle(agendamento({ title: "   " }))).toThrow(/sem título/);
    expect(() => paraEventoDoGoogle(agendamento({ starts_at: "ontem" }))).toThrow(/starts_at inválido/);
    expect(() => paraEventoDoGoogle(agendamento({ ends_at: "2026-09-02T16:00:00.000Z" }))).toThrow(
      /fim antes do início/,
    );
    expect(() => paraEventoDoGoogle(agendamento({ time_zone: "" }))).toThrow(/sem time_zone/);
    expect(() =>
      paraEventoDoGoogle(agendamento({ participantes: [{ email: "  " }] })),
    ).toThrow(/participante sem e-mail/);
  });
});

// ─── VOLTA ─────────────────────────────────────────────────────────────────

describe("doEventoDoGoogle", () => {
  it("lê evento com hora e marca que ele ocupa", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-1",
          summary: "Reunião do condomínio",
          start: { dateTime: "2026-09-02T14:00:00-03:00", timeZone: "America/Sao_Paulo" },
          end: { dateTime: "2026-09-02T15:00:00-03:00", timeZone: "America/Sao_Paulo" },
          updated: "2026-08-26T12:00:00.000Z",
          sequence: 3,
          iCalUID: "abc@google.com",
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e).toMatchObject({
      external_event_id: "evt-1",
      title: "Reunião do condomínio",
      starts_at: "2026-09-02T17:00:00.000Z",
      ends_at: "2026-09-02T18:00:00.000Z",
      is_all_day: false,
      status: "confirmed",
      transparency: "opaque",
      external_updated_at: "2026-08-26T12:00:00.000Z",
      ical_uid: "abc@google.com",
      sequence: 3,
      ocupa: true,
    });
  });

  it("dia inteiro usa `date` e é convertido no fuso do calendário", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-dia",
          summary: "Feriado",
          // O `end.date` do Google é EXCLUSIVO: o dia 2 termina no início do 3.
          start: { date: "2026-09-02" },
          end: { date: "2026-09-03" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.is_all_day).toBe(true);
    expect(e.starts_at).toBe("2026-09-02T03:00:00.000Z");
    expect(e.ends_at).toBe("2026-09-03T03:00:00.000Z");
    // A leitura ingênua daria 2026-09-02T00:00Z, que em São Paulo é 21h do
    // dia 1º: o dia inteiro ocuparia o dia errado.
    expect(e.starts_at).not.toBe("2026-09-02T00:00:00.000Z");
    expect(e.ocupa).toBe(true);
  });

  it("dia inteiro no dia sem meia-noite continua caindo no dia certo", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        { id: "evt-dst", start: { date: "2018-11-04" }, end: { date: "2018-11-05" } },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.starts_at).toBe("2018-11-04T03:00:00.000Z");
    expect(e.ends_at).toBe("2018-11-05T02:00:00.000Z");
  });

  it("evento marcado como Disponível NÃO tira horário", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-livre",
          transparency: "transparent",
          start: { dateTime: "2026-09-02T14:00:00-03:00" },
          end: { dateTime: "2026-09-02T15:00:00-03:00" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.transparency).toBe("transparent");
    expect(e.ocupa).toBe(false);
  });

  it("valor desconhecido de transparência ou status conta como ocupado", () => {
    // Errar para "livre" marca em cima de compromisso real; errar para "ocupa"
    // só esconde um horário. Só um dos dois desmarca cliente.
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-estranho",
          transparency: "translucido",
          status: "quem_sabe",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.transparency).toBe("opaque");
    expect(e.status).toBe("confirmed");
    expect(e.ocupa).toBe(true);
  });

  it("guarda o `tentative` como é: existe, e ocupa", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-talvez",
          status: "tentative",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.status).toBe("tentative");
    expect(e.ocupa).toBe(true);
  });

  it("a lápide de exclusão é lida como cancelamento, mesmo sem horário nenhum", () => {
    // Na sincronização incremental o Google anuncia exclusão assim. Exigir
    // `start` aqui deixaria o evento apagado ocupando horário para sempre.
    const r = doEventoDoGoogle({ id: "evt-morto", status: "cancelled" }, FUSO_DO_CALENDARIO);
    expect(r).toEqual({ tipo: "cancelado", externalEventId: "evt-morto" });
  });

  it("cancelado COM horário também deixa de ocupar", () => {
    const r = doEventoDoGoogle(
      {
        id: "evt-morto-2",
        status: "cancelled",
        start: { dateTime: "2026-09-02T14:00:00Z" },
        end: { dateTime: "2026-09-02T15:00:00Z" },
      },
      FUSO_DO_CALENDARIO,
    );
    expect(r.tipo).toBe("cancelado");
  });

  it("recusa o mestre de uma série, porque ele esconde as outras ocorrências", () => {
    // O mestre descreve só a PRIMEIRA ocorrência. Guardá-lo como ocupação
    // isolada faria a agenda dizer "livre" em cima de compromisso semanal.
    const r = doEventoDoGoogle(
      {
        id: "evt-serie",
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"],
        start: { dateTime: "2026-09-02T14:00:00Z" },
        end: { dateTime: "2026-09-02T15:00:00Z" },
      },
      FUSO_DO_CALENDARIO,
    );
    expect(r).toMatchObject({ tipo: "recusado", motivo: "recorrencia_nao_expandida" });
  });

  it("aceita a INSTÂNCIA de uma série, que é o que `singleEvents` entrega", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-serie_20260902",
          recurringEventId: "evt-serie",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.external_event_id).toBe("evt-serie_20260902");
    expect(e.ocupa).toBe(true);
  });

  it("recusa com motivo nomeado em vez de chutar um instante", () => {
    const motivo = (r: LeituraDeEvento) => (r.tipo === "recusado" ? r.motivo : `não recusou: ${r.tipo}`);

    expect(motivo(doEventoDoGoogle({ status: "confirmed" }, FUSO_DO_CALENDARIO))).toBe("sem_id");
    expect(motivo(doEventoDoGoogle({ id: "x" }, FUSO_DO_CALENDARIO))).toBe("sem_instante");
    expect(
      motivo(doEventoDoGoogle({ id: "x", start: { dateTime: "2026-09-02T14:00:00Z" } }, FUSO_DO_CALENDARIO)),
    ).toBe("sem_instante");
    expect(
      motivo(
        doEventoDoGoogle(
          { id: "x", start: { dateTime: "hoje de tarde" }, end: { dateTime: "2026-09-02T15:00:00Z" } },
          FUSO_DO_CALENDARIO,
        ),
      ),
    ).toBe("instante_invalido");
    expect(
      motivo(
        doEventoDoGoogle(
          {
            id: "x",
            start: { dateTime: "2026-09-02T15:00:00Z" },
            end: { dateTime: "2026-09-02T14:00:00Z" },
          },
          FUSO_DO_CALENDARIO,
        ),
      ),
    ).toBe("instante_invalido");
    expect(
      motivo(doEventoDoGoogle({ id: "x", start: { date: "2026-09-02" }, end: {} }, FUSO_DO_CALENDARIO)),
    ).toBe("instante_invalido");
    // Fuso que este runtime não conhece é problema da CONEXÃO, não do evento —
    // e a mensagem tem de dizer qual dos dois, senão a triagem procura no lugar
    // errado.
    expect(
      motivo(
        doEventoDoGoogle(
          { id: "x", start: { date: "2026-09-02" }, end: { date: "2026-09-03" } },
          { fusoDoCalendario: "America/Asunción" },
        ),
      ),
    ).toBe("fuso_invalido");
  });

  it("`dateTime` SEM deslocamento é hora de parede, e usa o fuso do evento", () => {
    // ⚠️ `new Date("2026-09-02T14:00:00")` — sem Z e sem -03:00 — é lido pela
    // especificação como hora LOCAL DO PROCESSO. O mesmo evento viraria
    // instantes diferentes conforme o fuso da máquina onde a imagem roda: a
    // agenda de um self-hoster em Manaus ocuparia horário diferente da de um em
    // São Paulo, com o mesmo dado. Esta asserção é absoluta de propósito — ela
    // vale igual em qualquer fuso de processo.
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-sem-offset",
          start: { dateTime: "2026-09-02T14:00:00", timeZone: "America/Sao_Paulo" },
          end: { dateTime: "2026-09-02T15:00:00", timeZone: "America/Sao_Paulo" },
        },
        { fusoDoCalendario: "UTC" },
      ),
    );
    expect(e.starts_at).toBe("2026-09-02T17:00:00.000Z");
    expect(e.ends_at).toBe("2026-09-02T18:00:00.000Z");
  });

  it("sem `timeZone` no evento, a hora de parede cai no fuso do CALENDÁRIO", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-sem-tz",
          start: { dateTime: "2026-09-02T14:00:00" },
          end: { dateTime: "2026-09-02T15:00:00" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.starts_at).toBe("2026-09-02T17:00:00.000Z");
  });

  it("data pura chegando no campo `dateTime` não reproduz o bug da meia-noite UTC", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        { id: "evt-torto", start: { dateTime: "2026-09-02" }, end: { dateTime: "2026-09-03" } },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.starts_at).toBe("2026-09-02T03:00:00.000Z");
    expect(e.starts_at).not.toBe("2026-09-02T00:00:00.000Z");
  });

  it("compromisso que o DONO da agenda recusou não ocupa o horário dele", () => {
    // Deixar ocupando some com horário livre por causa de convite que a pessoa
    // nem aceitou — e é o tipo de sumiço que ninguém liga ao Google.
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-recusado",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
          attendees: [
            { email: "outro@exemplo.com", responseStatus: "accepted" },
            { email: "dono@clinica.com.br", self: true, responseStatus: "declined" },
          ],
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.ocupa).toBe(false);
    // Recusa de OUTRO participante não muda nada — o horário do dono segue tomado.
    const deOutro = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-outro-recusou",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
          attendees: [{ email: "outro@exemplo.com", responseStatus: "declined" }],
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(deOutro.ocupa).toBe(true);
  });

  it("`workingLocation` é marcador de onde a pessoa trabalha, não compromisso", () => {
    // Ele cobre o dia inteiro; contá-lo como ocupação apagaria a agenda de quem
    // apenas marcou que hoje está no escritório.
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-local",
          eventType: "workingLocation",
          start: { date: "2026-09-02" },
          end: { date: "2026-09-03" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.ocupa).toBe(false);
  });

  it("caixa alta não muda o significado — `CANCELLED` não vira compromisso", () => {
    const cancelado = doEventoDoGoogle({ id: "evt-CX", status: "CANCELLED" }, FUSO_DO_CALENDARIO);
    expect(cancelado.tipo).toBe("cancelado");
    const livre = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-CX2",
          transparency: "TRANSPARENT",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(livre.ocupa).toBe(false);
  });

  it("não chuta `updated` ilegível — devolve nulo", () => {
    const e = eventoLido(
      doEventoDoGoogle(
        {
          id: "evt-u",
          updated: "outro dia",
          start: { dateTime: "2026-09-02T14:00:00Z" },
          end: { dateTime: "2026-09-02T15:00:00Z" },
        },
        FUSO_DO_CALENDARIO,
      ),
    );
    expect(e.external_updated_at).toBeNull();
  });

  it("nunca lança, por pior que venha o evento", () => {
    const lixo: EventoDoGoogle[] = [
      {},
      { id: "a", start: null, end: null },
      { id: "b", start: { dateTime: null }, end: { dateTime: null } },
      { id: "c", start: { date: "31/02/2026" }, end: { date: "2026-09-03" } },
    ];
    for (const evento of lixo) {
      expect(() => doEventoDoGoogle(evento, FUSO_DO_CALENDARIO)).not.toThrow();
    }
  });
});

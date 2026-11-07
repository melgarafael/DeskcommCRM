/**
 * CONVIDADOS DA EQUIPE CHEGAM AO EVENTO DO GOOGLE (#4006).
 *
 * ─── O defeito, medido ────────────────────────────────────────────────────
 *
 * O compromisso só montava `attendees` com o e-mail da ficha e UM convidado
 * digitado. Convidar alguém da equipe era impossível — e, mesmo que a lista
 * existisse no banco, o hash do grupo `guest` não a veria: o evento nunca seria
 * reenviado, e o convidado não apareceria na agenda dele.
 *
 * ─── O que este arquivo prova ─────────────────────────────────────────────
 *
 * 1. A lista de participantes deduplica equipe × ficha × convidado digitado
 *    (o Google recusa o evento INTEIRO com e-mail repetido) e todos pedem RSVP.
 * 2. Convidar mais alguém muda a projeção → `compare` devolve `publish` do
 *    grupo `guest`.
 * 3. O aceite/recusa do convidado no Google NÃO é conflito: o hash do grupo é
 *    só de e-mails, nunca do `responseStatus`.
 * 4. Tirar alguém da lista remove o e-mail do `attendees` (é para isso que a
 *    linha removida continua "conhecida").
 * 5. Ajuste que só mexe na descrição sai com `sendUpdates=none`.
 */
import { describe, expect, it } from "vitest";

import { participantesDoAgendamento, type AgendamentoParaGoogle } from "@/lib/agenda/google/evento";
import {
  checkpoint,
  compare,
  delta,
  localProjection,
  remoteProjection,
  sendUpdatesDaEscrita,
} from "@/lib/agenda/google/sync-model";

const a: AgendamentoParaGoogle & { guest_email: string | null } = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  title: "Reunião Estratégica",
  description: "Levar proposta impressa.",
  starts_at: "2026-11-10T17:00:00Z",
  ends_at: "2026-11-10T18:00:00Z",
  time_zone: "America/Sao_Paulo",
  status: "confirmed",
  location_kind: "google_meet",
  guest_email: null,
};

const eventoSemEquipe = {
  id: "remote-1",
  summary: a.title,
  description: a.description ?? undefined,
  start: { dateTime: a.starts_at, timeZone: a.time_zone },
  end: { dateTime: a.ends_at },
};

const EQUIPE = [
  { email: "sdr@equipe.test", nome: "SDR" },
  { email: "gestor@equipe.test", nome: null },
];

describe("participantes do compromisso com a equipe", () => {
  it("equipe entra no attendees e o mesmo e-mail não vira duas linhas", () => {
    const lista = participantesDoAgendamento({
      contactEmail: "cliente@empresa.test",
      contactName: "Neide",
      // O "e-mail do convidado" digitado à mão é a MESMA pessoa da equipe.
      guestEmail: "SDR@equipe.test",
      teamGuests: EQUIPE,
    });

    expect(lista.map((p) => p.email.toLowerCase())).toEqual([
      "cliente@empresa.test",
      "sdr@equipe.test",
      "gestor@equipe.test",
    ]);
    // Convite do Google é convite: quem nunca falou com o CRM aceita ou recusa.
    expect(lista.every((p) => p.aguardandoResposta === true)).toBe(true);
    // O e-mail digitado à mão veio em MAIÚSCULA; o nome só existe na entrada da
    // equipe. A deduplicação enriquece a linha que já existe em vez de perder o
    // nome conforme a ordem da lista.
    expect(lista.find((p) => p.email.toLowerCase() === "sdr@equipe.test")?.nome).toBe("SDR");
  });

  it("sem equipe a lista é exatamente a de antes", () => {
    const lista = participantesDoAgendamento({
      contactEmail: "cliente@empresa.test",
      guestEmail: "acompanhante@fora.test",
    });
    expect(lista.map((p) => p.email)).toEqual(["cliente@empresa.test", "acompanhante@fora.test"]);
  });
});

describe("a mudança de convidados chega ao Google", () => {
  const semEquipe = localProjection({ ...a, convidados_da_equipe: [] });
  const comEquipe = localProjection({ ...a, convidados_da_equipe: ["sdr@equipe.test"] });

  it("convidar alguém muda o hash do grupo guest e vira publish", () => {
    expect(comEquipe.outbound.guest).not.toBe(semEquipe.outbound.guest);

    const base = checkpoint(null, semEquipe, remoteProjection(eventoSemEquipe, semEquipe, null), [
      "title",
      "description",
      "location",
      "guest",
    ], true);
    const remoto = remoteProjection(eventoSemEquipe, comEquipe, base, ["sdr@equipe.test"]);
    const decisao = compare(base, comEquipe, remoto);

    expect(decisao.kind).toBe("publish");
    expect(decisao.groups).toEqual(["guest"]);
  });

  it("o PATCH do convite leva o e-mail novo com needsAction", () => {
    const patch = delta(
      {
        ...a,
        convidados_da_equipe: ["sdr@equipe.test"],
        convidados_conhecidos: ["sdr@equipe.test"],
      },
      eventoSemEquipe,
      null,
      ["guest"],
      false,
    );
    // Sem `displayName`: o delta só conhece os E-MAILS (a resolução do nome
    // fica na tela e no POST). O Google completa o nome pelo contato dele.
    expect(patch.attendees).toEqual([{ email: "sdr@equipe.test", responseStatus: "needsAction" }]);
  });

  it("aceitar ou recusar no Google NÃO é conflito", () => {
    const base = checkpoint(null, comEquipe, remoteProjection(eventoSemEquipe, comEquipe, null), [
      "title",
      "description",
      "location",
      "guest",
    ], true);
    const eventoAceito = {
      ...eventoSemEquipe,
      attendees: [{ email: "sdr@equipe.test", responseStatus: "accepted" }],
    };
    const remoto = remoteProjection(eventoAceito, comEquipe, base, ["sdr@equipe.test"]);
    const decisao = compare(base, comEquipe, remoto);

    expect(decisao.kind).not.toBe("conflict");
    expect(remoto.outbound.guest).toBe(comEquipe.outbound.guest);
  });

  it("tirar da lista REMOVE o e-mail do attendees — a linha removida continua conhecida", () => {
    const eventoComEquipe = {
      ...eventoSemEquipe,
      attendees: [{ email: "sdr@equipe.test", responseStatus: "accepted" }],
    };
    const patch = delta(
      { ...a, convidados_da_equipe: [], convidados_conhecidos: ["sdr@equipe.test"] },
      eventoComEquipe,
      null,
      ["guest"],
      false,
    );
    expect(patch.attendees).toEqual([]);
  });

  it("convidado do Google que NÃO é nosso continua no evento", () => {
    const eventoComTerceiro = {
      ...eventoSemEquipe,
      attendees: [
        { email: "sdr@equipe.test", responseStatus: "accepted" },
        { email: "colega-do-cliente@fora.test", responseStatus: "accepted" },
      ],
    };
    const patch = delta(
      { ...a, convidados_da_equipe: [], convidados_conhecidos: ["sdr@equipe.test"] },
      eventoComTerceiro,
      null,
      ["guest"],
      false,
    );
    expect(patch.attendees).toEqual([
      { email: "colega-do-cliente@fora.test", responseStatus: "accepted" },
    ]);
  });
});

describe("quem o Google avisa por e-mail", () => {
  it("ajuste SÓ de descrição sai silencioso", () => {
    expect(sendUpdatesDaEscrita("PATCH", ["description"], false)).toBe("none");
  });

  it("convidado, horário ou cancelamento avisam todo mundo", () => {
    expect(sendUpdatesDaEscrita("PATCH", ["guest"], false)).toBe("all");
    expect(sendUpdatesDaEscrita("PATCH", ["description", "guest"], false)).toBe("all");
    expect(sendUpdatesDaEscrita("PATCH", ["description"], true)).toBe("all");
    expect(sendUpdatesDaEscrita("DELETE", [], true)).toBe("all");
    expect(sendUpdatesDaEscrita("POST", [], false)).toBe("all");
  });
});

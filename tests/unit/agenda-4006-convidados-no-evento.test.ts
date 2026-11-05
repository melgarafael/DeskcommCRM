/**
 * #4006 — CONVIDADOS DA EQUIPE E CONTEXTO DO NEGÓCIO NO EVENTO DO GOOGLE.
 *
 * ⚠️ ESTE ARQUIVO É O LADO RED DA ISSUE, e por isso ele importa SÓ módulos que
 * já existiam antes do conserto (`evento.ts` e `sync-model.ts`). Rodado contra
 * `origin/main`, ele falha pelos motivos certos:
 *
 *   1. `participantesDoAgendamento` recebe `teamGuests` e IGNORA — o evento sai
 *      com a ficha e o e-mail digitado, e mais ninguém;
 *   2. `contexto_do_negocio` é propriedade desconhecida — a descrição sai só com
 *      o texto do compromisso, sem negócio/produto/telefone;
 *   3. `delta` não sabe DESconvidar quem saiu da equipe (e o hash `guest` nem
 *      enxerga a lista, então a mudança nunca dispararia PATCH).
 *
 * Se este arquivo importasse os módulos novos, o RED seria "módulo não
 * encontrado" — que não prova comportamento nenhum.
 */
import { describe, expect, it } from "vitest";

import {
  type AgendamentoParaGoogle,
  type EventoDoGoogle,
  paraEventoDoGoogle,
  participantesDoAgendamento,
} from "@/lib/agenda/google/evento";
import { delta, localProjection } from "@/lib/agenda/google/sync-model";

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENDAMENTO = "22222222-2222-4222-8222-222222222222";
const SDR = "33333333-3333-4333-8333-333333333333";
const CLOSER = "44444444-4444-4444-8444-444444444444";

const EQUIPE = [
  { email: "sdr@deskcomm.test", nome: "SDR" },
  { email: "closer@deskcomm.test", nome: null },
];

function agendamento(sobrescreve: Partial<AgendamentoParaGoogle> = {}): AgendamentoParaGoogle {
  return {
    id: AGENDAMENTO,
    organization_id: ORG,
    title: "Reunião Estratégica",
    description: "Alinhar proposta",
    starts_at: "2026-11-10T17:00:00.000Z",
    ends_at: "2026-11-10T17:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    location_kind: "in_person",
    location_details: "Rua das Acácias, 120",
    ...sobrescreve,
  };
}

const BLOCO_DO_NEGOCIO =
  "<b>Negócio:</b> Plano Anual – Clínica Rosa<br>\n<b>Telefone:</b> (11) 98765-4321";

describe("#4006 · convidados da equipe no evento", () => {
  it("os DOIS convidados da equipe entram no evento, além da ficha e do e-mail digitado", () => {
    const participantes = participantesDoAgendamento({
      contactEmail: "rosa@clinica.test",
      contactName: "Rosa",
      guestEmail: "acompanhante@clinica.test",
      teamGuests: EQUIPE,
    });
    expect(participantes.map((p) => p.email)).toEqual([
      "rosa@clinica.test",
      "acompanhante@clinica.test",
      "sdr@deskcomm.test",
      "closer@deskcomm.test",
    ]);

    const corpo = paraEventoDoGoogle(agendamento({ participantes }));
    expect((corpo.attendees ?? []).map((p) => p.email)).toEqual([
      "rosa@clinica.test",
      "acompanhante@clinica.test",
      "sdr@deskcomm.test",
      "closer@deskcomm.test",
    ]);
    // Todo convidado pede resposta: o convite existe para a pessoa aceitar.
    expect((corpo.attendees ?? []).every((p) => p.responseStatus === "needsAction")).toBe(true);
  });

  it("o e-mail manual continua entrando, e o mesmo endereço duas vezes não duplica attendee", () => {
    const participantes = participantesDoAgendamento({
      contactEmail: null,
      guestEmail: "closer@deskcomm.test",
      // O closer está na equipe E foi digitado à mão: é o caso comum, não o
      // exótico — e o Google recusa o evento INTEIRO com e-mail repetido.
      teamGuests: EQUIPE,
    });
    expect(participantes.map((p) => p.email)).toEqual([
      "closer@deskcomm.test",
      "sdr@deskcomm.test",
    ]);
  });

  it("e-mail vazio ou só espaço não vira attendee (não é convidado, é campo limpo)", () => {
    const participantes = participantesDoAgendamento({
      contactEmail: null,
      guestEmail: "   ",
      teamGuests: [{ email: "  ", nome: null }, { email: "sdr@deskcomm.test" }],
    });
    expect(participantes.map((p) => p.email)).toEqual(["sdr@deskcomm.test"]);
  });

  it("a descrição leva o bloco do negócio DEPOIS do texto que a pessoa escreveu", () => {
    const corpo = paraEventoDoGoogle(agendamento({ contexto_do_negocio: BLOCO_DO_NEGOCIO }));
    expect(corpo.description).toBe(`Alinhar proposta\n\n${BLOCO_DO_NEGOCIO}`);
  });

  it("compromisso sem negócio vinculado NÃO inventa bloco", () => {
    const corpo = paraEventoDoGoogle(agendamento({ contexto_do_negocio: "" }));
    expect(corpo.description).toBe("Alinhar proposta");
  });

  it("mudar a equipe muda o hash publicado — senão o worker nunca mandaria o PATCH", () => {
    const semEquipe = localProjection(agendamento());
    const comEquipe = localProjection(
      agendamento({
        convidados_da_equipe: EQUIPE,
        convidados_equipe_ids: [SDR, CLOSER],
        team_guest_user_ids: [SDR, CLOSER],
      } as Partial<AgendamentoParaGoogle>),
    );
    expect(comEquipe.outbound.guest).not.toBe(semEquipe.outbound.guest);
  });

  it("a lista publicada em deskcomm_guests é o que permite desconvidar depois", () => {
    const corpo = paraEventoDoGoogle(
      agendamento({
        convidados_equipe_ids: [SDR, CLOSER],
      } as Partial<AgendamentoParaGoogle>),
    );
    expect(corpo.extendedProperties?.private?.deskcomm_guests).toBe(`${SDR},${CLOSER}`);
    // As chaves de identidade continuam lá: sem elas o evento deixa de ser nosso.
    expect(corpo.extendedProperties?.private?.deskcomm_appointment).toBe(AGENDAMENTO);
  });
});

describe("#4006 · editar o compromisso mexe em attendees sem estragar o resto", () => {
  const evento = {
    attendees: [
      { email: "sdr@deskcomm.test", responseStatus: "accepted" },
      { email: "especialista@deskcomm.test", responseStatus: "needsAction" },
      { email: "acompanhante@clinica.test", responseStatus: "declined" },
      // Posto direto no Google por uma pessoa: NÃO é nosso, não se toca.
      { email: "convidado-do-google@externo.test" },
    ],
  } as unknown as EventoDoGoogle;

  const comEquipeRemovida = (): AgendamentoParaGoogle =>
    agendamento({
      contact_email: null,
      contact_nome: null,
      guest_email: "acompanhante@clinica.test",
      convidados_da_equipe: [{ email: "sdr@deskcomm.test", nome: "SDR" }],
      convidados_equipe_ids: [SDR],
      team_guest_user_ids: [SDR],
    } as Partial<AgendamentoParaGoogle>);

  it("quem saiu da equipe é DESconvidado; quem ficou conserva o RSVP", () => {
    const patch = delta(
      comEquipeRemovida() as never,
      evento,
      null,
      ["guest"],
      false,
      { convidadosAnteriores: ["especialista@deskcomm.test"] },
    ) as { attendees?: Array<{ email: string; responseStatus?: string }> };

    expect(patch.attendees?.map((p) => p.email)).toEqual([
      "sdr@deskcomm.test",
      "acompanhante@clinica.test",
      "convidado-do-google@externo.test",
    ]);
    // O "aceito" de quem já respondeu não é apagado por uma edição de lista.
    expect(patch.attendees?.[0]?.responseStatus).toBe("accepted");
    expect(patch.attendees?.[1]?.responseStatus).toBe("declined");
  });

  it("rodar o MESMO update duas vezes não duplica ninguém (idempotência)", () => {
    const primeiro = delta(
      comEquipeRemovida() as never,
      evento,
      null,
      ["guest"],
      false,
      { convidadosAnteriores: ["especialista@deskcomm.test"] },
    ) as { attendees?: Array<{ email: string; responseStatus?: string }> };

    const segundo = delta(
      comEquipeRemovida() as never,
      { ...evento, attendees: primeiro.attendees } as unknown as EventoDoGoogle,
      null,
      ["guest"],
      false,
      { convidadosAnteriores: [] },
    ) as { attendees?: Array<{ email: string; responseStatus?: string }> };

    expect(segundo.attendees).toEqual(primeiro.attendees);
  });

  it("o PATCH de convidado reenvia as chaves de identidade do evento", () => {
    const patch = delta(
      comEquipeRemovida() as never,
      evento,
      null,
      ["guest"],
      false,
      { convidadosAnteriores: [] },
    ) as { extendedProperties?: { private?: Record<string, string> } };

    expect(patch.extendedProperties?.private?.deskcomm_org).toBe(ORG);
    expect(patch.extendedProperties?.private?.deskcomm_appointment).toBe(AGENDAMENTO);
  });

  /**
   * A FORMA REAL do evento: todo evento que publicamos volta do Google com as
   * chaves privadas de identidade. A fixture acima não as traz, e por isso
   * `delta` passou verde enquanto lançava `ReferenceError` em produção (o
   * prefixo das chaves não estava importado em `sync-model.ts`).
   */
  const eventoPublicado = (privadas: Record<string, string>) =>
    ({
      ...evento,
      extendedProperties: {
        private: { deskcomm_org: ORG, deskcomm_appointment: AGENDAMENTO, ...privadas },
      },
    }) as unknown as EventoDoGoogle;

  const semEquipe = (): AgendamentoParaGoogle =>
    agendamento({
      contact_email: null,
      contact_nome: null,
      guest_email: "acompanhante@clinica.test",
    } as Partial<AgendamentoParaGoogle>);

  it("evento já publicado e compromisso sem equipe: troca o convidado sem lançar", () => {
    const patch = delta(semEquipe() as never, eventoPublicado({}), null, ["guest"], false, {
      convidadosAnteriores: [],
    }) as { attendees?: Array<{ email: string }>; extendedProperties?: unknown };

    expect(patch.attendees?.map((p) => p.email)).toContain("acompanhante@clinica.test");
    // Sem lista nossa a registrar nem a apagar, o PATCH segue o de antes.
    expect(patch.extendedProperties).toBeUndefined();
  });

  it("evento com lista publicada e equipe esvaziada: apaga a lista no Google", () => {
    const patch = delta(
      semEquipe() as never,
      eventoPublicado({ deskcomm_guests: SDR }),
      null,
      ["guest"],
      false,
      { convidadosAnteriores: ["sdr@deskcomm.test"] },
    ) as { extendedProperties?: { private?: Record<string, string | null> } };

    expect(patch.extendedProperties?.private?.deskcomm_guests).toBeNull();
    expect(patch.extendedProperties?.private?.deskcomm_org).toBe(ORG);
  });
});

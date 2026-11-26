/** O evento do Outlook visto como OCUPAÇÃO. Puro. */
import { primeiroInstanteDoDia } from "@/lib/agenda/google/tempo";

import type { EventoDaMicrosoft } from "./graph";

export interface OcupacaoLida {
  external_event_id: string;
  starts_at: string;
  ends_at: string;
  is_all_day: boolean;
  status: "confirmed" | "tentative";
  transparency: "opaque" | "transparent";
  ical_uid: string | null;
}

/** "Livre" e "trabalhando em outro lugar" não tomam o horário de ninguém. */
const NAO_OCUPAM = new Set(["free", "workingElsewhere"]);

export class EventoIlegivel extends Error {
  constructor() {
    super("Há um evento no Outlook com horário que a leitura não consegue usar.");
    this.name = "EventoIlegivel";
  }
}

/**
 * `null` = cancelado, não ocupa. Horário ilegível LANÇA: ignorar o evento
 * deixaria a grade oferecer um horário tomado.
 *
 * Dia inteiro chega como data de parede à meia-noite, então vale no fuso de quem
 * atende. O resto chega em UTC porque o pedido leva `outlook.timezone="UTC"`.
 */
export function ocupacaoDoEvento(evento: EventoDaMicrosoft, fuso: string): OcupacaoLida | null {
  if (evento.isCancelled) return null;
  const inicio = evento.start?.dateTime;
  const fim = evento.end?.dateTime;
  if (!evento.id || !inicio || !fim) throw new EventoIlegivel();
  const instante = (texto: string): Date =>
    evento.isAllDay
      ? (primeiroInstanteDoDia(texto.slice(0, 10), fuso) ?? new Date(Number.NaN))
      : new Date(/(Z|[+-]\d{2}:\d{2})$/.test(texto) ? texto : `${texto}Z`);
  const de = instante(inicio);
  const ate = instante(fim);
  if (Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime())) throw new EventoIlegivel();
  // Evento de duração zero não ocupa minuto nenhum (e o banco o recusaria).
  if (ate <= de) return null;
  return {
    external_event_id: evento.id,
    starts_at: de.toISOString(),
    ends_at: ate.toISOString(),
    is_all_day: evento.isAllDay === true,
    status: evento.showAs === "tentative" ? "tentative" : "confirmed",
    transparency: NAO_OCUPAM.has(evento.showAs ?? "") ? "transparent" : "opaque",
    ical_uid: evento.iCalUId ?? null,
  };
}

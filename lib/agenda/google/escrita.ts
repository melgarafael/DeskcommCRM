/** Identidade estável. Escritas remotas passam por sync-executor + transport. */
import { SUFIXO_ICAL_UID } from "./evento";
const PREFIXO = SUFIXO_ICAL_UID.toLowerCase().replace(/[^a-v0-9]/g, "");
export function idDeEventoDoGoogle(idDoAgendamento: string): string {
  const limpo = idDoAgendamento.toLowerCase().replace(/[^a-v0-9]/g, "");
  return `${PREFIXO}${limpo}`;
}

/** Só sinaliza origem; a tupla persistida e private properties provam o vínculo. */
export function ehEventoNosso(externalEventId: string | null | undefined): boolean {
  return Boolean(externalEventId?.toLowerCase().startsWith(PREFIXO));
}

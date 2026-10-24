import { extrairObjetosJsonDoTexto } from '@/lib/agent-engine/texto/extrair-json-do-texto';
import type { Logger } from '../../obs/logger';

/** Nunca escolhe o último positivo nem aceita o primeiro positivo seguido de veto. */
export function sinalAgendaDoTexto(texto: string, log?: Logger): boolean | undefined {
  const objetos = extrairObjetosJsonDoTexto(texto);
  if (!objetos.length || objetos.some(o => typeof o.agendaCompativel !== 'boolean')) return undefined;
  const sinais = new Set(objetos.map(o => o.agendaCompativel as boolean));
  if (sinais.size !== 1) {
    log?.warn('revisão de agenda com vereditos contraditórios', { event:'agenda_review_ambiguous_output', objetos:objetos.length });
    return undefined;
  }
  return objetos[0]!.agendaCompativel as boolean;
}

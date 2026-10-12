import { z } from "zod";

/** Metadado de apresentação. Nunca integra regras ou contexto da reserva. */
export const tituloDaAgendaEntradaSchema = z.object({ title: z.string().trim().max(80) }).strict();
export function tituloDaAgenda(settings: unknown): string | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const presentation = (settings as Record<string, unknown>).agenda_presentation;
  if (!presentation || typeof presentation !== "object" || Array.isArray(presentation)) return null;
  const title = (presentation as Record<string, unknown>).title;
  return typeof title === "string" && title.trim().length > 0 && title.trim().length <= 80 ? title.trim() : null;
}

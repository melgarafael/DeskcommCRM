import { z } from "zod";
export const calendarPresentationSchema = z
  .object({
    allServices: z.boolean().optional(),
    historyAllFirst: z.boolean().optional(),
    periodList: z.boolean().optional(),
    historyControlsBeforeGrid: z.boolean().optional(),
    gridFirst: z.boolean().optional(),
  })
  .strict();

export function initialCalendarService(
  query: string | null,
  types: ReadonlyArray<{ id: string }>,
  allowAll: boolean,
): string | null {
  if (allowAll && (!query || query === "todos")) return null;
  return types.find((type) => type.id === query)?.id ?? types[0]?.id ?? null;
}

/** UI projection of the authorized period. Google occupancy remains visible for any service. */
export function calendarServiceMatches(
  item: { tipoSlug?: string; origem: string },
  slug: string | null,
): boolean {
  return slug === null || item.origem === "google_sync" || item.tipoSlug === slug;
}

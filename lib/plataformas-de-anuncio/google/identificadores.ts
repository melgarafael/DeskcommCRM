import { z } from "zod";

const identificador = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);
export const identificadoresGoogleSchema = z
  .object({
    gclid: identificador.optional(),
    gbraid: identificador.optional(),
    wbraid: identificador.optional(),
  })
  .refine((v) => Boolean(v.gclid || v.gbraid || v.wbraid));

export type IdentificadoresGoogle = z.infer<typeof identificadoresGoogleSchema>;

/** Nunca converte um identificador iOS em gclid nem aceita macros não resolvidas. */
export function lerIdentificadoresGoogle(valor: unknown): IdentificadoresGoogle | null {
  const lido = identificadoresGoogleSchema.safeParse(valor);
  return lido.success ? lido.data : null;
}

/** O upload legado recebe um identificador; o Data Manager recebe o conjunto. */
export function identificadorParaUpload(ids: IdentificadoresGoogle): IdentificadoresGoogle {
  if (ids.gclid) return { gclid: ids.gclid };
  if (ids.gbraid) return { gbraid: ids.gbraid };
  return { wbraid: ids.wbraid };
}

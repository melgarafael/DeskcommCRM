/** Cursores keyset validados antes de entrar na gramática do PostgREST. */
import { z } from "zod";
const cursorSchema = z.object({ instante: z.iso.datetime({ offset: true }), id: z.uuid() });
export function codificarPagina(instante: string, id: string): string {
  return Buffer.from(JSON.stringify({ instante, id })).toString("base64url");
}
export function lerPagina(cursor: string): z.infer<typeof cursorSchema> | null {
  try {
    const r = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return r.success ? r.data : null;
  } catch { return null; }
}
export const paginaSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(1000).optional() });

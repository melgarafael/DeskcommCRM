import { z } from "zod";

export const processoCodigoSchema = z.coerce.number().int().positive();
export const processoLinkBodySchema = z.object({ processo_codigo: processoCodigoSchema }).strict();

/** Contrato mínimo devolvido pelo Advomax para provar que o processo pertence à Pessoa. */
export const processoResumoSchema = z.object({ codigo: processoCodigoSchema }).passthrough();

export function processoConstaNoResumo(body: unknown, processoCodigo: number): boolean {
  return Array.isArray(body) && body.some((item) => {
    const parsed = processoResumoSchema.safeParse(item);
    return parsed.success && parsed.data.codigo === processoCodigo;
  });
}

export function erroDeConflitoDeProcesso(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

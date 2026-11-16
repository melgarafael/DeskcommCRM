import { z } from "zod";
/** Autoridade de agência é independente do plano comercial. */
export const configuracaoAgenciaSchema = z
  .object({
    habilitada: z.boolean(),
    limite_clientes: z.number().int().min(0).max(10000),
    clientes_inclusos: z.boolean().optional(),
  })
  .strict();

export type ConfiguracaoAgencia = z.infer<typeof configuracaoAgenciaSchema>;

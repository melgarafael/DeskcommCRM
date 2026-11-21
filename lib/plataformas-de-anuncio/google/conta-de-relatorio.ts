import { z } from "zod";

const id = z.string().trim().regex(/^(?:\d{10}|\d{3}-\d{3}-\d{4})$/).transform((valor) => valor.replaceAll("-", ""));

/** Destino da autorização de leitura, assinado junto com o tenant e a sessão. */
export const contaDeRelatorio = z.object({
  customerId: id,
  loginCustomerId: id.nullable(),
  label: z.string().trim().min(1).max(80),
  suporteId: z.string().uuid().optional(),
});

export type ContaDeRelatorio = z.infer<typeof contaDeRelatorio>;

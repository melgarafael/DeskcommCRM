import { z } from "zod";

export const pixKeyTypeSchema = z.enum(["cpf", "cnpj", "email", "random", "phone"]);
export type PixKeyType = z.infer<typeof pixKeyTypeSchema>;

/** Normaliza a chave para o formato aceito no EMV (só dígitos em CPF/CNPJ/celular). */
export function normalizarChavePix(tipo: PixKeyType, valor: string): string {
  const v = valor.trim();
  if (tipo === "cpf" || tipo === "cnpj") {
    return v.replace(/\D/g, "");
  }
  if (tipo === "phone") {
    const digitos = v.replace(/\D/g, "");
    if (digitos.length >= 10 && digitos.length <= 11 && !digitos.startsWith("55")) {
      return `+55${digitos}`;
    }
    return `+${digitos}`;
  }
  if (tipo === "email") return v.toLowerCase();
  return v;
}

function chaveValida(tipo: PixKeyType, valor: string): boolean {
  const n = normalizarChavePix(tipo, valor);
  switch (tipo) {
    case "cpf":
      return /^\d{11}$/.test(n);
    case "cnpj":
      return /^\d{14}$/.test(n);
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n) && n.length <= 77;
    case "phone": {
      const d = n.replace(/\D/g, "");
      return d.length >= 12 && d.length <= 13;
    }
    case "random":
      // UUID com ou sem hífens (chave aleatória Bacen).
      return (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n) ||
        /^[0-9a-f]{32}$/i.test(n)
      );
    default:
      return false;
  }
}

export const createPixKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    key_type: pixKeyTypeSchema,
    key_value: z.string().trim().min(1).max(200),
    /** true = compartilhado (owner null, manager+); false = pessoal. */
    shared: z.boolean().default(false),
  })
  .superRefine((data, ctx) => {
    if (!chaveValida(data.key_type, data.key_value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key_value"],
        message: "Chave Pix inválida para o tipo escolhido.",
      });
    }
  });
export type CreatePixKeyInput = z.infer<typeof createPixKeySchema>;

export const updatePixKeySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    key_type: pixKeyTypeSchema,
    key_value: z.string().trim().min(1).max(200),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." })
  .superRefine((data, ctx) => {
    if (data.key_type && data.key_value && !chaveValida(data.key_type, data.key_value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key_value"],
        message: "Chave Pix inválida para o tipo escolhido.",
      });
    }
    // Se só manda um dos dois, a rota valida contra o registro existente.
  });
export type UpdatePixKeyInput = z.infer<typeof updatePixKeySchema>;

export const gerarCobrancaPixSchema = z.object({
  key_id: z.string().uuid(),
  /** Valor em centavos (mín. R$ 0,01). */
  amount_cents: z.number().int().positive().max(9_999_999_999),
  description: z.string().trim().max(72).optional(),
});
export type GerarCobrancaPixInput = z.infer<typeof gerarCobrancaPixSchema>;

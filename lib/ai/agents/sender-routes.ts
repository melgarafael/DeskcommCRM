import { z } from "zod";

/** Números completos com DDI. Sem equivalência aproximada nem leitura do texto da mensagem. */
export function telefoneDoRemetente(value: unknown): string | null {
  if (typeof value !== "string" || !/^\+?[\d\s().-]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export const senderRoutesSchema = z
  .array(
    z.object({
      phone: z
        .string()
        .transform(telefoneDoRemetente)
        .refine((v): v is string => v !== null, "Informe telefone completo com DDI."),
      agent_id: z.string().uuid(),
    }),
  )
  .max(100)
  .superRefine((routes, ctx) => {
    const phones = new Set<string>();
    routes.forEach((route, i) => {
      if (route.phone && phones.has(route.phone))
        ctx.addIssue({ code: "custom", path: [i, "phone"], message: "Número repetido." });
      if (route.phone) phones.add(route.phone);
    });
  });
export type SenderRoute = z.infer<typeof senderRoutesSchema>[number];

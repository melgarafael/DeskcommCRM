import { z } from "zod";

/** Opt-in. Sem configuração, a passagem antiga continua exatamente como antes. */
export const configEntregaSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Ausente preserva os avisos já configurados; desligar nunca envia. */
    notifications_enabled: z.boolean().default(true),
    seller_user_ids: z.array(z.string().uuid()).max(50).default([]),
    seller_destinations: z
      .record(z.string().uuid(), z.string().regex(/^\+[1-9]\d{7,14}$/))
      .default({}),
    supervisor_destinations: z
      .array(z.string().regex(/^\+[1-9]\d{7,14}$/))
      .max(10)
      .default([]),
    notice_links: z.enum(["crm", "whatsapp", "both"]).default("crm"),
    max_attempts: z.number().int().min(1).max(100).default(20),
    retry_seconds: z.number().int().min(10).max(3600).default(60),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.seller_user_ids).size !== c.seller_user_ids.length)
      ctx.addIssue({ code: "custom", message: "Vendedores repetidos" });
    if (
      c.enabled &&
      (!c.seller_user_ids.length ||
        (c.notifications_enabled && c.seller_user_ids.some((id) => !c.seller_destinations[id])))
    )
      ctx.addIssue({
        code: "custom",
        message: "Informe vendedores e WhatsApp de cada um antes de ativar",
      });
    if (Object.keys(c.seller_destinations).some((id) => !c.seller_user_ids.includes(id)))
      ctx.addIssue({ code: "custom", message: "Destino sem vendedor correspondente" });
  });
export type ConfigEntrega = z.infer<typeof configEntregaSchema>;

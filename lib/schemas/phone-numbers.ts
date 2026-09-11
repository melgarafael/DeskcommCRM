/**
 * Zod source-of-truth para phone_numbers (números/DID de VoIP por org).
 * `trunk_endpoint` não entra aqui: é o mesmo troncal Asterisk para toda a
 * plataforma hoje (infra compartilhada, não escolha da organização) — o
 * backend grava o valor de VOIP_TRUNK_ENDPOINT, a tela nem pergunta.
 */
import { z } from "zod";

export const routingModeEnum = z.enum(["ai", "human", "ai_then_human"]);
export type RoutingMode = z.infer<typeof routingModeEnum>;

export const createPhoneNumberSchema = z
  .object({
    number: z
      .string()
      .trim()
      .min(8, "Número muito curto.")
      .max(20, "Número muito longo.")
      .regex(/^\+?[0-9]+$/, "Use só dígitos, com + opcional no início (E.164)."),
    label: z.string().trim().max(120).nullable().optional(),
    routing_mode: routingModeEnum.default("ai"),
    default_ai_agent_id: z.string().uuid().nullable().optional(),
    is_active: z.boolean().default(true),
  })
  .strict();
export type CreatePhoneNumberInput = z.infer<typeof createPhoneNumberSchema>;

export const updatePhoneNumberSchema = z
  .object({
    label: z.string().trim().max(120).nullable().optional(),
    routing_mode: routingModeEnum.optional(),
    default_ai_agent_id: z.string().uuid().nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type UpdatePhoneNumberInput = z.infer<typeof updatePhoneNumberSchema>;

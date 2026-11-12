import { z } from "zod";

import { STATUS_AVALIACAO } from "./status";

const agendamentoCorpoSchema = z.object({
  contact_id: z.string().uuid().optional(),
  client_name: z.string().trim().min(1).max(200).optional(),
  client_phone: z.string().trim().min(8).max(32).optional(),
  client_email: z.string().trim().email().max(200).optional().or(z.literal("")),
  unit_id: z.string().uuid(),
  consultant_user_id: z.string().uuid().nullable().optional(),
  consultant_auto: z.boolean().optional(),
  attendant_user_id: z.string().uuid().nullable().optional(),
  scheduled_at: z.string().datetime({ offset: true }),
  duration_minutes: z.number().int().min(20).max(120).default(20),
  vehicle_plate: z.string().trim().max(16).optional(),
  vehicle_brand: z.string().trim().max(80).optional(),
  vehicle_model: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(4000).optional(),
  lead_id: z.string().uuid().optional(),
});

export const criarAgendamentoSchema = agendamentoCorpoSchema.superRefine((v, ctx) => {
  if (!v.contact_id && (!v.client_name || !v.client_phone)) {
    ctx.addIssue({
      code: "custom",
      message: "Informe o contato existente ou nome e WhatsApp do cliente.",
    });
  }
});

/**
 * Campos só de criação (resolução de contato / distribuição). Não existem em
 * `avaliacao_agendamentos` — se entrarem no `.update()`, o PostgREST responde
 * `PGRST204` ("Could not find the 'consultant_auto' column…") e a edição falha
 * depois do formulário ter enviado o mesmo corpo do POST.
 */
export const atualizarAgendamentoSchema = agendamentoCorpoSchema
  .omit({
    client_name: true,
    client_phone: true,
    consultant_auto: true,
  })
  .partial()
  .extend({
    status: z.enum(STATUS_AVALIACAO).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nenhum campo para atualizar." });

export const listarAgendamentosSchema = z.object({
  de: z.string().datetime({ offset: true }),
  ate: z.string().datetime({ offset: true }),
  status: z.enum(STATUS_AVALIACAO).optional(),
  unit_id: z.string().uuid().optional(),
  consultant_user_id: z.string().uuid().optional(),
  attendant_user_id: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
});

export const unidadeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  is_active: z.boolean().optional(),
});

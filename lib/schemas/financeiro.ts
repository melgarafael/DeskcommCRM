import { z } from "zod";

/** Situações aceitas no filtro (vencido é derivado, não gravado). */
export const SITUACOES_RECEBIVEL = ["aberto", "parcial", "pago", "vencido", "cancelado"] as const;

export const recebiveisQuerySchema = z.object({
  busca: z.string().trim().max(120).optional(),
  status: z.enum(SITUACOES_RECEBIVEL).optional(),
  vendedor: z.string().uuid().optional(),
  cidade: z.string().trim().max(120).optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pedido_id: z.string().uuid().optional(),
  invoice_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  ordem: z.enum(["vencimento", "valor", "recentes"]).default("vencimento"),
});

export type RecebiveisQuery = z.infer<typeof recebiveisQuerySchema>;

export const recebivelCreateSchema = z.object({
  contact_id: z.string().uuid({ message: "contato inválido" }),
  valor_original_cents: z.number().int().min(1, "valor precisa ser ao menos R$ 0,01"),
  vencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data YYYY-MM-DD"),
  parcelas: z.number().int().min(1).max(720).default(1),
  forma_pagamento: z.string().trim().max(60).optional(),
  observacoes: z.string().trim().max(2000).optional(),
  order_id: z.string().uuid().optional(),
  invoice_id: z.string().uuid().optional(),
});

export type RecebivelCreate = z.infer<typeof recebivelCreateSchema>;

export const pagamentoCreateSchema = z.object({
  valor_cents: z.number().int().min(1, "valor precisa ser ao menos R$ 0,01"),
  pago_em: z.string().datetime({ message: "data/hora ISO inválida" }).optional(),
  forma_pagamento: z.string().trim().max(60).optional(),
  conta: z.string().trim().max(120).optional(),
  observacao: z.string().trim().max(500).optional(),
});

export type PagamentoCreate = z.infer<typeof pagamentoCreateSchema>;

export const gerarFinanceiroSchema = z.object({
  order_id: z.string().uuid({ message: "pedido inválido" }),
});

export const COLUNAS_DO_RECEBIVEL =
  "id, organization_id, order_id, invoice_id, contact_id, parcela_n, total_parcelas, " +
  "valor_original_cents, vencimento, status, forma_pagamento, observacoes, created_by, created_at";

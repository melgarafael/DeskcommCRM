import { z } from "zod";

/**
 * O pedido como a API devolve, TOLERANTE: só exige o que a tradução não pode
 * inventar (id, total, datas). O resto é opcional e o desconhecido passa
 * (`passthrough`) — um campo novo da Nuvemshop não pode derrubar a loja inteira.
 */
const idSchema = z.union([z.number(), z.string()]);
const valorSchema = z.union([z.string(), z.number()]);

export const pedidoNuvemshopSchema = z
  .object({
    id: idSchema,
    number: idSchema.nullish(),
    status: z.string().nullish(),
    payment_status: z.string().nullish(),
    shipping_status: z.string().nullish(),
    total: valorSchema,
    subtotal: valorSchema.nullish(),
    discount: valorSchema.nullish(),
    shipping_cost_customer: valorSchema.nullish(),
    currency: z.string().nullish(),
    gateway: z.string().nullish(),
    shipping_tracking_number: z.string().nullish(),
    shipping_option: z.unknown().optional(),
    landing_url: z.string().nullish(),
    channels: z.unknown().optional(),
    utm: z.unknown().optional(),
    created_at: z.string(),
    updated_at: z.string(),
    contact_name: z.string().nullish(),
    contact_email: z.string().nullish(),
    contact_phone: z.string().nullish(),
    contact_identification: z.string().nullish(),
    customer: z
      .object({
        id: idSchema.nullish(),
        name: z.string().nullish(),
        email: z.string().nullish(),
        phone: z.string().nullish(),
        billing_phone: z.string().nullish(),
        identification: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    products: z
      .array(
        z
          .object({
            product_id: idSchema.nullish(),
            variant_id: idSchema.nullish(),
            name: z.unknown().optional(),
            quantity: valorSchema.nullish(),
            price: valorSchema.nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

export type PedidoNuvemshop = z.infer<typeof pedidoNuvemshopSchema>;

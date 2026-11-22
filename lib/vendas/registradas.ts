/**
 * VENDAS REGISTRADAS — o contrato de entrada e as réguas puras.
 *
 * A venda é um registro próprio (`public.vendas_registradas`, migration 9449):
 * valor, dia, tags e observação, ligada ao negócio e ao contato. O mesmo
 * negócio aceita várias vendas (recompra), e a venda conta no painel de vendas
 * em QUALQUER etapa do card — o dinheiro entrou quando o vendedor registrou, e
 * não quando o card chegou a "Pago".
 *
 * As tags passam pela MESMA normalização das tags do contato
 * (`normalizarTags`): o filtro do painel compara a tag normalizada, e "Atacado",
 * "atacado " e "ATACADO" têm de ser a mesma.
 */
import { z } from "zod";

import { normalizarTags } from "@/lib/contacts/tag-normalizada";

export const MAXIMO_DE_TAGS_POR_VENDA = 10;
export const TAMANHO_MAXIMO_DA_OBSERVACAO = 500;
/** Teto de um registro: R$ 100 milhões em centavos — acima disso é dígito a mais. */
export const VALOR_MAXIMO_CENTS = 10_000_000_000;

export interface VendaRegistrada {
  id: string;
  lead_id: string | null;
  contact_id: string | null;
  valor_cents: number;
  currency: string;
  data: string;
  tags: string[];
  observacao: string | null;
  created_by: string | null;
  created_at: string;
}

/** A data de hoje + 1, em AAAA-MM-DD: venda com data no futuro além disso é engano. */
function amanha(agora: Date): string {
  return new Date(agora.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function criarVendaSchema(agora: Date = new Date()) {
  return z
    .object({
      lead_id: z.uuid({ message: "Negócio inválido." }).optional(),
      contact_id: z.uuid({ message: "Contato inválido." }).optional(),
      valor_cents: z
        .number({ message: "Informe o valor da venda." })
        .int({ message: "Valor inválido." })
        .positive({ message: "O valor precisa ser maior que zero." })
        .max(VALOR_MAXIMO_CENTS, { message: "Valor alto demais — confira os dígitos." }),
      data: z.iso
        .date({ message: "Data inválida." })
        .refine((d) => d <= amanha(agora), { message: "A data da venda está no futuro." })
        .refine((d) => d >= "2000-01-01", { message: "Data inválida." }),
      tags: z
        .array(z.string())
        .max(MAXIMO_DE_TAGS_POR_VENDA, { message: "No máximo 10 tags por venda." })
        .default([])
        .transform((tags) => normalizarTags(tags)),
      observacao: z
        .string()
        .trim()
        .max(TAMANHO_MAXIMO_DA_OBSERVACAO, { message: "Observação longa demais." })
        .optional()
        .transform((o) => (o ? o : null)),
    })
    .refine((v) => v.lead_id !== undefined || v.contact_id !== undefined, {
      message: "A venda precisa de um negócio ou de um contato.",
      path: ["lead_id"],
    });
}

export type CriarVenda = z.infer<ReturnType<typeof criarVendaSchema>>;

/** Quem pode apagar uma venda: quem a registrou, ou gestor para cima. */
export function podeApagarVenda(venda: { created_by: string | null }, usuarioId: string, ehGestor: boolean): boolean {
  return ehGestor || (venda.created_by !== null && venda.created_by === usuarioId);
}

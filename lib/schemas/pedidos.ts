import { z } from "zod";

/**
 * O CONTRATO DOS PEDIDOS COMERCIAIS — um só, lido pela tela E pela rota.
 *
 * Mesma doutrina de `lib/schemas/produtos.ts`: um schema por lado é como nasce
 * controle decorativo. Os dois lados importam daqui.
 */

/** O ciclo comercial. Vocabulário FECHADO (CHECK no banco). */
export const STATUS_DO_PEDIDO = [
  "rascunho",
  "em_analise",
  "aprovado",
  "faturado",
  "expedido",
  "entregue",
  "cancelado",
] as const;
export type StatusDoPedido = (typeof STATUS_DO_PEDIDO)[number];

/**
 * A origem do pedido — o badge da tela. Vocabulário ABERTO (sem CHECK no
 * banco, mesma doutrina da origem do produto na 0204). Estes quatro são os
 * conhecidos; desconhecido cai no badge neutro, nunca em 422.
 */
export const ORIGENS_DO_PEDIDO = ["ia", "vendedor", "whatsapp", "b2b"] as const;
export type OrigemDoPedido = (typeof ORIGENS_DO_PEDIDO)[number];

/** Rótulo e cor do badge por origem conhecida. */
export const BADGE_DA_ORIGEM: Record<string, { rotulo: string; classe: string }> = {
  ia: {
    rotulo: "IA",
    classe: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  },
  vendedor: {
    rotulo: "Vendedor",
    classe: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  },
  whatsapp: {
    rotulo: "WhatsApp",
    classe: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200",
  },
  b2b: {
    rotulo: "B2B",
    classe: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  },
};

export function badgeDaOrigem(origem: string): { rotulo: string; classe: string } {
  return (
    BADGE_DA_ORIGEM[origem] ?? {
      rotulo: origem,
      classe: "bg-muted text-muted-foreground",
    }
  );
}

/** Rótulo do status para a tela. */
export const ROTULO_DO_STATUS: Record<StatusDoPedido, string> = {
  rascunho: "Rascunho",
  em_analise: "Em análise",
  aprovado: "Aprovado",
  faturado: "Faturado",
  expedido: "Expedido",
  entregue: "Entregue",
  cancelado: "Cancelado",
};

const itemCreateSchema = z.object({
  product_id: z.string().uuid().nullable().optional(),
  quantidade: z.number().int().min(1, "quantidade precisa ser ao menos 1"),
  preco_unit_cents: z.number().int().min(0, "preço não pode ser negativo"),
  desconto_pct: z.number().min(0).max(100).default(0),
});

export const MODALIDADES_FRETE = ["retirada", "propria", "terceirizada"] as const;

export const pedidoCreateSchema = z.object({
  contact_id: z.string().uuid().nullable().optional(),
  cliente_nome: z.string().trim().min(2, "nome do cliente precisa de ao menos 2 letras").max(200),
  cliente_documento: z.string().trim().max(30).optional(),
  vendedor_user_id: z.string().uuid().nullable().optional(),
  status: z.enum(STATUS_DO_PEDIDO).default("rascunho"),
  origem: z.string().trim().max(30).default("vendedor"),
  moeda: z.string().trim().length(3).toUpperCase().default("BRL"),
  desconto_cents: z.number().int().min(0).default(0),
  /** Desconto geral em % (0222): soma com o em R$. NULL = sem. */
  desconto_pct: z.number().min(0).max(100).nullable().optional(),
  /** Tabela aplicada: o servidor recalcula o preço (0221/0210). */
  price_table_id: z.string().uuid().nullable().optional(),
  frete_cents: z.number().int().min(0).default(0),
  condicao_pagamento: z.string().trim().max(200).optional(),
  observacoes: z.string().trim().max(2000).optional(),
  /** Interna (equipe); nunca imprime. */
  obs_interna: z.string().trim().max(2000).optional(),
  /** Onde este pedido desce (0212). Por pedido, não por cliente. */
  endereco_entrega: z.string().trim().max(500).optional(),
  transportadora_nome: z.string().trim().max(120).optional(),
  modalidade_frete: z.enum(MODALIDADES_FRETE).default("retirada"),
  previsao_entrega: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "data YYYY-MM-DD").nullable().optional(),
  /**
   * Override de estoque insuficiente. Só vale para `manager` para cima — a
   * rota recusa com 422 se um papel menor mandar `true`. Falha fechada: pedir
   * o que não pode não passa em silêncio.
   */
  ignorar_estoque: z.boolean().default(false),
  /**
   * Override de crédito. Mesmo molde do estoque: só vale para `manager` para
   * cima, e a rota cobra com o gate canônico — nunca comparação de rank.
   */
  ignorar_credito: z.boolean().default(false),
  itens: z.array(itemCreateSchema).min(1, "o pedido precisa de ao menos 1 item").max(200),
});

/** PATCH muda status, vendedor, cliente, condição, observações, endereço, entrega — nunca itens nem totais. */
export const pedidoPatchSchema = z.object({
  status: z.enum(STATUS_DO_PEDIDO).optional(),
  vendedor_user_id: z.string().uuid().nullable().optional(),
  /** Troca o cliente: a rota regrava o snapshot (nome/documento) junto. */
  contact_id: z.string().uuid().nullable().optional(),
  condicao_pagamento: z.string().trim().max(200).nullable().optional(),
  observacoes: z.string().trim().max(2000).nullable().optional(),
  obs_interna: z.string().trim().max(2000).nullable().optional(),
  endereco_entrega: z.string().trim().max(500).nullable().optional(),
  transportadora_nome: z.string().trim().max(120).nullable().optional(),
  modalidade_frete: z.enum(MODALIDADES_FRETE).optional(),
  previsao_entrega: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "data YYYY-MM-DD").nullable().optional(),
});

export type PedidoCreate = z.infer<typeof pedidoCreateSchema>;
export type PedidoPatch = z.infer<typeof pedidoPatchSchema>;
export type ItemCreate = z.infer<typeof itemCreateSchema>;

/**
 * Subtotal do item em centavos: qtd × preço × (1 − desconto%).
 * `Math.round` e não truncamento: truncar R$ 0,005 por item some centavos no
 * pedido inteiro sem ninguém ver.
 */
export function subtotalDoItem(
  quantidade: number,
  precoUnitCents: number,
  descontoPct: number,
): number {
  return Math.round(quantidade * precoUnitCents * (1 - descontoPct / 100));
}

export interface PedidoComercial {
  id: string;
  numero: number;
  contact_id: string | null;
  cliente_nome: string;
  cliente_documento: string | null;
  vendedor_user_id: string | null;
  status: StatusDoPedido;
  origem: string;
  moeda: string;
  subtotal_cents: number;
  desconto_cents: number;
  desconto_pct: number | null;
  frete_cents: number;
  total_cents: number;
  condicao_pagamento: string | null;
  price_table_id: string | null;
  observacoes: string | null;
  obs_interna: string | null;
  endereco_entrega: string | null;
  transportadora_nome: string | null;
  modalidade_frete: string;
  previsao_entrega: string | null;
  parcelas: Parcela[];
  created_at: string;
  updated_at: string;
}

export interface Parcela {
  n: number;
  valor_cents: number;
  vencimento: string;
}

/** As colunas que a lista e a rota leem — uma lista, não duas. */
export const COLUNAS_DO_PEDIDO =
  "id, numero, contact_id, cliente_nome, cliente_documento, vendedor_user_id, " +
  "status, origem, moeda, subtotal_cents, desconto_cents, desconto_pct, frete_cents, total_cents, " +
  "condicao_pagamento, price_table_id, observacoes, obs_interna, endereco_entrega, transportadora_nome, " +
  "modalidade_frete, previsao_entrega, parcelas, created_at, updated_at";

/**
 * Parcelas a partir da condição ("30/60/90", "28 dias", "à vista"...).
 * Padrão reconhecido vira linhas com vencimento; resto vira [] (à vista
 * implícito) — nunca adivinha dia de "combinar depois".
 */
export function calcularParcelas(totalCents: number, condicao: string | null | undefined): Parcela[] {
  if (!condicao) return [];
  const nums = [...condicao.matchAll(/(\d+)\s*(?:dias?)?/gi)].map((m) => Number(m[1]));
  const prazos = nums.filter((n) => n >= 0 && n <= 720);
  if (prazos.length <= 1) return [];
  const base = Math.floor(totalCents / prazos.length);
  const hoje = new Date();
  return prazos.map((dias, i) => {
    const venc = new Date(hoje.getTime() + dias * 86400000);
    const ultimo = i === prazos.length - 1;
    return {
      n: i + 1,
      valor_cents: ultimo ? totalCents - base * (prazos.length - 1) : base,
      vencimento: venc.toISOString().slice(0, 10),
    };
  });
}

/** Edição de itens do rascunho: adicionar, remover, ajustar. */
export const itensPatchSchema = z.object({
  adicionar: z.array(itemCreateSchema).max(200).default([]),
  remover: z.array(z.string().uuid()).max(200).default([]),
  ajustar: z
    .array(
      z.object({
        id: z.string().uuid(),
        quantidade: z.number().int().min(1).max(100000).optional(),
        preco_unit_cents: z.number().int().min(0).optional(),
        desconto_pct: z.number().min(0).max(100).optional(),
      }),
    )
    .max(200)
    .default([]),
});

export type ItensPatch = z.infer<typeof itensPatchSchema>;

export interface ItemDoPedido {
  id: string;
  product_id: string | null;
  produto_codigo: string;
  produto_nome: string;
  quantidade: number;
  preco_unit_cents: number;
  desconto_pct: number;
  subtotal_cents: number;
  posicao: number;
}

export const COLUNAS_DO_ITEM =
  "id, product_id, produto_codigo, produto_nome, quantidade, preco_unit_cents, " +
  "desconto_pct, subtotal_cents, posicao";

import { z } from "zod";

/**
 * O CONTRATO DA EXPEDIÇÃO — um só, lido pela tela E pela rota.
 */

export const STATUS_DA_CARGA = ["montando", "em_rota", "concluida", "cancelada"] as const;
export type StatusDaCarga = (typeof STATUS_DA_CARGA)[number];

export const STATUS_NA_CARGA = ["na_carga", "em_rota", "em_atendimento", "entregue", "devolvido"] as const;
export type StatusNaCarga = (typeof STATUS_NA_CARGA)[number];

export const ROTULO_DA_CARGA: Record<StatusDaCarga, string> = {
  montando: "Montando",
  em_rota: "Em rota",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

export const ROTULO_NA_CARGA: Record<StatusNaCarga, string> = {
  na_carga: "Na carga",
  em_rota: "Em rota",
  em_atendimento: "Em atendimento",
  entregue: "Entregue",
  devolvido: "Devolvido",
};

const PLACA_REGEX = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;

export const cargaCreateSchema = z.object({
  placa: z
    .string()
    .trim()
    .toUpperCase()
    .transform((v) => v.replace(/[^A-Z0-9]/g, ""))
    .refine((v) => v === "" || PLACA_REGEX.test(v), "placa inválida (padrão Mercosul: ABC1D23)")
    .optional(),
  veiculo_tipo: z.string().trim().max(60).optional(),
  motorista_nome: z.string().trim().max(120).optional(),
  /** Pedidos que abrem a carga (só aprovado/faturado — a rota confere). */
  order_ids: z.array(z.string().uuid()).max(200).default([]),
});

export const cargaPatchSchema = z.object({
  status: z.enum(STATUS_DA_CARGA).optional(),
  placa: z.string().trim().max(10).nullable().optional(),
  veiculo_tipo: z.string().trim().max(60).nullable().optional(),
  motorista_nome: z.string().trim().max(120).nullable().optional(),
});

export type CargaCreate = z.infer<typeof cargaCreateSchema>;
export type CargaPatch = z.infer<typeof cargaPatchSchema>;

export interface Carga {
  id: string;
  numero: number;
  placa: string | null;
  veiculo_tipo: string | null;
  motorista_nome: string | null;
  status: StatusDaCarga;
  created_at: string;
  updated_at: string;
}

export interface PedidoNaCarga {
  id: string;
  order_id: string;
  sequencia: number;
  status: StatusNaCarga;
  pedido: {
    numero: number;
    cliente_nome: string;
    endereco_entrega: string | null;
    total_cents: number;
    status: string;
  };
}

/** Motivos de não-entrega (devolvido pede um deles — sem motivo, sem baixa). */
export const MOTIVOS_DEVOLUCAO = [
  "cliente_ausente",
  "endereco_incorreto",
  "recusado",
  "estabelecimento_fechado",
  "problema_no_pedido",
  "outro",
] as const;
export type MotivoDevolucao = (typeof MOTIVOS_DEVOLUCAO)[number];

export const ROTULO_MOTIVO_DEVOLUCAO: Record<MotivoDevolucao, string> = {
  cliente_ausente: "Cliente ausente",
  endereco_incorreto: "Endereço incorreto",
  recusado: "Recusado",
  estabelecimento_fechado: "Estabelecimento fechado",
  problema_no_pedido: "Problema com pedido",
  outro: "Outro",
};

export const COLUNAS_DA_CARGA =
  "id, numero, placa, veiculo_tipo, motorista_nome, status, created_at, updated_at";

/**
 * Só aprovado/faturado embarca — o texto do ATT.txt ("pedidos
 * aprovados/faturados aguardando expedição"). Em análise precisa de aprovação
 * antes de subir no caminhão; rascunho é intenção; entregue/cancelado é
 * passado. Ao embarcar, a rota avança para `expedido` — e é por isso que quem
 * já foi sai da fila sozinho.
 */
export const STATUS_EMBARCAVEIS = ["aprovado", "faturado"] as const;

export function numeroDaCarga(numero: number): string {
  return `Carga ${String(numero).padStart(3, "0")}`;
}

import { z } from "zod";

/**
 * O CONTRATO FISCAL — um só, lido pela tela E pela rota.
 */

export const STATUS_DA_NOTA = ["pendente", "em_emissao", "autorizada", "denegada", "cancelada", "erro"] as const;
export type StatusDaNota = (typeof STATUS_DA_NOTA)[number];

export const ROTULO_DA_NOTA: Record<StatusDaNota, string> = {
  pendente: "Pendente",
  em_emissao: "Emitindo",
  autorizada: "Autorizada",
  denegada: "Denegada",
  cancelada: "Cancelada",
  erro: "Erro",
};

export const notaCreateSchema = z.object({
  /** O pedido que origina a nota. Sem pedido, sem nota (avulsa é fase futura). */
  order_id: z.string().uuid(),
});

export type NotaCreate = z.infer<typeof notaCreateSchema>;

export const configFiscalSchema = z.object({
  serie: z.string().trim().min(1).max(10).default("1"),
  natureza_operacao: z.string().trim().min(2).max(120).default("Venda de mercadoria"),
  cfop_padrao: z.string().trim().regex(/^\d{4}$/, "CFOP tem 4 dígitos").default("5102"),
  emitente_documento: z.string().trim().max(25).nullable().optional(),
  ie: z.string().trim().max(20).nullable().optional(),
  crt: z.enum(["1", "2", "3"]).default("1"),
  logradouro: z.string().trim().max(200).nullable().optional(),
  numero_end: z.string().trim().max(20).nullable().optional(),
  bairro: z.string().trim().max(100).nullable().optional(),
  municipio: z.string().trim().max(100).nullable().optional(),
  codigo_municipio: z.string().trim().regex(/^\d{7}$/, "IBGE tem 7 dígitos").nullable().optional(),
  uf: z.string().trim().length(2).toUpperCase().nullable().optional(),
  cep: z.string().trim().max(10).nullable().optional(),
  ambiente: z.enum(["homologacao", "producao"]).default("homologacao"),
  provedor: z.enum(["stub", "spednfe"]).default("stub"),
  certificado_path: z.string().trim().max(300).nullable().optional(),
  /**
   * Senha do .pfx em PLAINTEXT no request — a rota cifra antes de gravar e
   * nunca a devolve. String vazia = mantém a atual; null = não mexe.
   */
  certificado_senha: z.string().max(200).nullable().optional(),
});

export type ConfigFiscal = z.infer<typeof configFiscalSchema>;

/** A config como a tela lê (sem a senha — ela nunca volta do servidor). */
export interface ConfigFiscalSalva {
  serie: string;
  natureza_operacao: string;
  cfop_padrao: string;
  emitente_documento: string | null;
  ie: string | null;
  crt: string;
  logradouro: string | null;
  numero_end: string | null;
  bairro: string | null;
  municipio: string | null;
  codigo_municipio: string | null;
  uf: string | null;
  cep: string | null;
  ambiente: string;
  provedor: string;
  certificado_path: string | null;
}

export interface NotaFiscal {
  id: string;
  order_id: string | null;
  serie: string;
  numero: number | null;
  chave_acesso: string | null;
  protocolo: string | null;
  sefaz_cstat: string | null;
  sefaz_xmotivo: string | null;
  status: StatusDaNota;
  provedor: string;
  erro: string | null;
  total_cents: number;
  created_at: string;
}

export interface ConfigFiscalSalva {
  serie: string;
  natureza_operacao: string;
  cfop_padrao: string;
  emitente_documento: string | null;
}

export const COLUNAS_DA_NOTA =
  "id, order_id, serie, numero, chave_acesso, protocolo, sefaz_cstat, sefaz_xmotivo, " +
  "status, provedor, erro, total_cents, created_at";

/** Só pedido faturado vira nota: antes disso é intenção, não fato fiscal. */
export const STATUS_FATURAVEL = ["faturado"] as const;

export function identificacaoDaNota(serie: string, numero: number | null): string {
  return numero === null ? `Série ${serie} · sem número (pendente)` : `${numero}/${serie}`;
}

/**
 * CC-E — a SEFAZ só aceita texto de 15 a 1000 caracteres, e no máximo 20
 * cartas por nota (a sequência é a ordem de chegada). A rota conta antes
 * de gravar; aqui vai só o formato.
 */
export const cartaCorrecaoSchema = z.object({
  correcao: z.string().trim().min(15, "Correção curta demais (mínimo 15 caracteres)").max(1000, "Correção longa demais (máximo 1000 caracteres)"),
});

export type CartaCorrecao = z.infer<typeof cartaCorrecaoSchema>;

export const MAX_CARTAS_POR_NOTA = 20;

/**
 * INUTILIZAÇÃO — faixa de numeração que nunca virou nota, por série, com
 * motivo de 15 a 255 caracteres (mesma régua da SEFAZ para o motivo).
 */
export const inutilizacaoSchema = z.object({
  serie: z.string().trim().min(1).max(10),
  numero_inicial: z.number().int().positive(),
  numero_final: z.number().int().positive(),
  motivo: z.string().trim().min(15, "Motivo curto demais (mínimo 15 caracteres)").max(255, "Motivo longo demais (máximo 255 caracteres)"),
}).refine((v) => v.numero_final >= v.numero_inicial, {
  message: "Número final menor que o inicial",
  path: ["numero_final"],
});

export type Inutilizacao = z.infer<typeof inutilizacaoSchema>;

/** CFOP EQUIVALENTE — de/para de 4 dígitos, nunca iguais. */
export const cfopEquivalenteSchema = z.object({
  cfop_origem: z.string().trim().regex(/^\d{4}$/, "CFOP tem 4 dígitos"),
  cfop_destino: z.string().trim().regex(/^\d{4}$/, "CFOP tem 4 dígitos"),
}).refine((v) => v.cfop_destino !== v.cfop_origem, {
  message: "Destino igual à origem",
  path: ["cfop_destino"],
});

export type CfopEquivalente = z.infer<typeof cfopEquivalenteSchema>;

export interface InutilizacaoSalva {
  id: string;
  serie: string;
  numero_inicial: number;
  numero_final: number;
  motivo: string;
  ambiente: string;
  status: string;
  sefaz_protocolo: string | null;
  sefaz_xmotivo: string | null;
  created_at: string;
}

export interface CfopEquivalenteSalvo {
  id: string;
  cfop_origem: string;
  cfop_destino: string;
  created_at: string;
}

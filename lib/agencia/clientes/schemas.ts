import { z } from "zod";

import { normalizarWhatsapp } from "../convite";
import {
  quantidadesSchema,
  SERVICOS,
  SITUACOES_DA_CONTRATACAO,
  SITUACOES_DO_CLIENTE,
  TIPOS_DE_CONTRATACAO,
} from "./vocabulario";

const textoOpcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

/** Entrada do cadastro do cliente (SPEC-clientes › Dados). */
export const clienteSchema = z.object({
  id: z.string().uuid().optional(),
  nome: z.string().trim().min(2, "Informe o nome do cliente.").max(120),
  razaoSocial: textoOpcional(160),
  documento: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v === "" || v.length === 11 || v.length === 14, "CPF ou CNPJ incompleto.")
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  segmento: textoOpcional(80),
  responsavelNome: textoOpcional(120),
  whatsapp: z
    .string()
    .trim()
    .transform((v, ctx) => {
      if (v === "") return null;
      const n = normalizarWhatsapp(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "WhatsApp inválido. Use DDD + número." });
        return z.NEVER;
      }
      return n;
    })
    .nullable()
    .optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === "" || z.string().email().safeParse(v).success, "E-mail inválido.")
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  cidade: textoOpcional(80),
  instagram: textoOpcional(80),
  site: textoOpcional(200),
  observacoes: textoOpcional(4000),
  situacao: z.enum(SITUACOES_DO_CLIENTE),
  empresas: z
    .array(z.object({ nome: z.string().trim().min(1).max(160), documento: z.string().trim().max(20).optional() }))
    .max(20)
    .default([]),
});
export type EntradaDoCliente = z.input<typeof clienteSchema>;

export const contratacaoSchema = z
  .object({
    id: z.string().uuid().optional(),
    clienteId: z.string().uuid(),
    tipo: z.enum(TIPOS_DE_CONTRATACAO),
    servicos: z.array(z.enum(SERVICOS)).min(1, "Escolha pelo menos um serviço."),
    quantidades: quantidadesSchema,
    inicio: z.string().date().nullable().optional(),
    fim: z.string().date().nullable().optional(),
    situacao: z.enum(SITUACOES_DA_CONTRATACAO),
    observacoes: textoOpcional(2000),
  })
  .refine((c) => !c.inicio || !c.fim || c.fim >= c.inicio, { message: "O fim vem antes do início.", path: ["fim"] });
export type EntradaDaContratacao = z.input<typeof contratacaoSchema>;

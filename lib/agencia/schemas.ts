import { z } from "zod";

import { normalizarWhatsapp } from "./convite";
import { PERMISSOES_DA_AGENCIA } from "./permissoes";

/** Entrada da tela de funções. Permissão fora do vocabulário é recusada aqui. */
export const funcaoSchema = z.object({
  id: z.string().uuid().optional(),
  nome: z.string().trim().min(2, "Dê um nome com pelo menos 2 letras.").max(40),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Escolha uma cor."),
  permissoes: z.array(z.enum(PERMISSOES_DA_AGENCIA)).max(PERMISSOES_DA_AGENCIA.length),
  ativa: z.boolean(),
});
export type EntradaDaFuncao = z.infer<typeof funcaoSchema>;

/** Entrada do cadastro de membro. O WhatsApp sai daqui já em E.164. */
export const membroSchema = z.object({
  nome: z.string().trim().min(2, "Informe o nome.").max(80),
  email: z.string().trim().toLowerCase().email("E-mail inválido."),
  whatsapp: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const n = normalizarWhatsapp(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "WhatsApp inválido. Use DDD + número." });
        return z.NEVER;
      }
      return n;
    }),
  funcoes: z.array(z.string().uuid()).min(1, "Escolha pelo menos uma função."),
  veTodosClientes: z.boolean(),
});
export type EntradaDoMembro = z.input<typeof membroSchema>;

export const edicaoDeMembroSchema = membroSchema.omit({ email: true }).extend({ id: z.string().uuid() });
export type EntradaDaEdicaoDeMembro = z.input<typeof edicaoDeMembroSchema>;

export const idSchema = z.string().uuid();

/** Primeira mensagem de erro do Zod, para a tela. */
export function primeiroErro(e: z.ZodError): string {
  return e.issues[0]?.message ?? "Dados inválidos.";
}

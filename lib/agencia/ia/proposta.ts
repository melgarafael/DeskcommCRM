/**
 * A proposta de blocos que a IA faz para um mapa (SPEC-ia-da-agencia, I2–I3).
 * Pura: o formato que o modelo tem de devolver e a conferência antes do "Aplicar".
 */
import { z } from "zod";

import { problemaNoMapa } from "../mapas/regras";
import { ACOES_DA_IA } from "./catalogo";

export const MAX_BLOCOS_POR_PROPOSTA = 25;

export const propostaSchema = z.object({
  blocos: z
    .array(
      z.object({
        chave: z.string().min(1).max(40).describe("Identificador curto e único na proposta, ex.: b1, b2"),
        titulo: z.string().min(2).max(120),
        descricao: z.string().max(600).nullable(),
        tipo: z.enum(["tarefa", "marco"]).describe("marco = um ponto de controle, ex.: aprovação do cliente"),
        executor: z.enum(["humano", "ia"]),
        acao_ia: z.enum(ACOES_DA_IA).nullable().describe("Só quando executor = ia"),
        prazo_em_dias: z.number().int().min(0).max(120).nullable().describe("Dias a partir de hoje, se o pedido disser"),
      }),
    )
    .min(1)
    .max(MAX_BLOCOS_POR_PROPOSTA),
  ligacoes: z
    .array(z.object({ de: z.string().describe("chave do bloco que vem antes (ou id de bloco que já existe)"), para: z.string() }))
    .max(80),
  resumo: z.string().max(400).describe("Uma ou duas frases explicando o plano"),
});
export type Proposta = z.infer<typeof propostaSchema>;

/** Confere a proposta contra o mapa atual; devolve o problema em português, ou null. */
export function problemaNaProposta(p: Proposta, existentes: ReadonlyArray<{ id: string; titulo: string }>, ligacoesExistentes: ReadonlyArray<{ de_id: string; para_id: string }>): string | null {
  const chaves = new Set<string>();
  for (const b of p.blocos) {
    if (chaves.has(b.chave)) return `A IA repetiu o bloco "${b.chave}". Peça de novo.`;
    chaves.add(b.chave);
    if (b.executor === "humano" && b.acao_ia) return `"${b.titulo}" é de pessoa mas veio com ação de IA.`;
  }
  const ids = new Set(existentes.map((e) => e.id));
  for (const l of p.ligacoes) {
    if (!chaves.has(l.de) && !ids.has(l.de)) return `Uma seta aponta para um bloco que não existe (${l.de}).`;
    if (!chaves.has(l.para) && !ids.has(l.para)) return `Uma seta aponta para um bloco que não existe (${l.para}).`;
    if (l.de === l.para) return "Uma seta liga o bloco a ele mesmo.";
  }
  const todos = [...existentes, ...p.blocos.map((b) => ({ id: b.chave, titulo: b.titulo }))];
  const setas = [...ligacoesExistentes, ...p.ligacoes.map((l) => ({ de_id: l.de, para_id: l.para }))];
  const circulo = problemaNoMapa(todos, setas);
  return circulo && circulo.startsWith("Há setas em círculo") ? `A proposta fecharia um círculo: ${circulo.slice(circulo.indexOf(":") + 2)}` : null;
}

/** Normaliza o que o modelo devolveu: executor humano não carrega ação; IA sem ação fica com a padrão. */
export function normalizarProposta(p: Proposta): Proposta {
  return {
    ...p,
    blocos: p.blocos.map((b) => {
      // Marco é ponto de controle de pessoa: nunca da IA.
      const executor = b.tipo === "marco" ? "humano" : b.executor;
      return { ...b, executor, acao_ia: executor === "ia" ? (b.acao_ia ?? "roteiro") : null };
    }),
  };
}

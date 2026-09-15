/**
 * Schemas do vocabulário de etiquetas (issue #852, fatia S4).
 *
 * A etiqueta continua sendo `text[]` onde já está — automação, webhook
 * (`lead.tag_added`) e MCP (`*.tags_changed`) falam em string há versões, e
 * trocar por tabela com FK quebraria os três contratos. O que entra aqui é só a
 * validação do que a TELA manda para a função de banco.
 */
import { z } from "zod";

/**
 * O teto é o mesmo do editor de etiquetas do Inbox (`conversationTagSchema`),
 * de propósito: uma etiqueta que cabe no vocabulário mas não cabe no seletor
 * seria um nome que a tela cria e não consegue oferecer.
 */
export const TAG_MAX = 60;

/** Ações do vocabulário. Cada uma é uma operação atômica do banco. */
export const ACOES_DE_VOCABULARIO = ["renomear", "juntar", "excluir"] as const;
export type AcaoDeVocabulario = (typeof ACOES_DE_VOCABULARIO)[number];

export const tagSchema = z
  .string({ error: "tag_obrigatoria" })
  .trim()
  .min(1, "tag_obrigatoria")
  .max(TAG_MAX, "tag_longa_demais");

/**
 * `juntar` é o único caso em que a tag de origem e o destino podem coexistir com
 * grafias diferentes ("vip" + "VIP" → "VIP"): a função de banco desduplica por
 * nome canônico, então aqui só se exige que o destino exista e seja diferente.
 */
export const vocabularioDeTagsSchema = z
  .object({
    acao: z.enum(ACOES_DE_VOCABULARIO, {
      error: "acao_invalida",
    }),
    tag: tagSchema,
    destino: tagSchema.nullish(),
  })
  .superRefine((valor, ctx) => {
    if (valor.acao === "excluir") return;
    if (!valor.destino) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destino"],
        message: "destino_obrigatorio",
      });
      return;
    }
    if (
      valor.acao === "renomear" &&
      valor.destino.toLowerCase() === valor.tag.toLowerCase()
    ) {
      // Renomear para o mesmo nome (mesmo com outra caixa) não é operação: a
      // função de banco devolveria `alterou: false` e a tela diria "nada mudou"
      // sem explicar por quê.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["destino"],
        message: "destino_igual_a_tag",
      });
    }
  });

export type VocabularioDeTagsInput = z.infer<typeof vocabularioDeTagsSchema>;

/** Uma linha do vocabulário, como a função de leitura devolve. */
export type LinhaDeVocabulario = {
  tag: string;
  uso_em_contatos: number;
  uso_em_leads: number;
  uso_em_conversas: number;
  em_regras: number;
  cor: string | null;
  descricao: string | null;
  no_vocabulario: boolean;
};

/**
 * Schemas do vocabulário de etiquetas (issue #852, fatia S4; cor: #1271, S6).
 *
 * A etiqueta continua sendo `text[]` onde já está — automação, webhook
 * (`lead.tag_added`) e MCP (`*.tags_changed`) falam em string há versões, e
 * trocar por tabela com FK quebraria os três contratos. O que entra aqui é só a
 * validação do que a TELA manda para a função de banco.
 *
 * ── A cor entra neste arquivo, e não na tela ─────────────────────────────────
 *
 * A validação de forma (`#rrggbb`) precisa acontecer onde a rota pode recusar
 * antes de chamar o banco: a função de operação também valida (`cor_invalida`,
 * 22023), mas quem chega por RPC direta não passa por aqui — as duas camadas
 * existem de propósito, e a de baixo é a que vale para o dado gravado.
 */
import { z } from "zod";

import { corDeEtiquetaValida, normalizarCorDeEtiqueta } from "@/lib/tags/cor-da-etiqueta";

/**
 * O teto é o mesmo do editor de etiquetas do Inbox (`conversationTagSchema`),
 * de propósito: uma etiqueta que cabe no vocabulário mas não cabe no seletor
 * seria um nome que a tela cria e não consegue oferecer.
 */
export const TAG_MAX = 60;

/** Ações do vocabulário. Cada uma é uma operação atômica do banco. */
export const ACOES_DE_VOCABULARIO = ["renomear", "juntar", "excluir", "definir_cor"] as const;
export type AcaoDeVocabulario = (typeof ACOES_DE_VOCABULARIO)[number];

export const tagSchema = z
  .string({ error: "tag_obrigatoria" })
  .trim()
  .min(1, "tag_obrigatoria")
  .max(TAG_MAX, "tag_longa_demais");

/**
 * A cor, na forma que o banco aceita: normalizada para `#rrggbb` minúsculo.
 *
 * `#ABC`, `#aabbcc` e `aabbcc` entram e saem iguais (`#aabbcc`): a régua é a
 * mesma função que a LEITURA usa para tolerar o que já estiver gravado à mão.
 * O que não entra é lixo (`nome-verde`, `#12345`), que gravaria e voltaria para
 * a tela sem pintar nada.
 *
 * "Sem cor" é `cor: null`, não string vazia — quem limpa diz que está limpando.
 */
export const corDeEtiquetaSchema = z
  .string({ error: "cor_invalida" })
  .trim()
  .refine((valor) => corDeEtiquetaValida(valor), { error: "cor_invalida" })
  .transform((valor) => normalizarCorDeEtiqueta(valor) as string);

/**
 * Renomear só a caixa também é operação (#3507): a função de banco conserva a
 * grafia pedida onde ela é exibida e normaliza as colunas que exigem minúscula.
 * Os nomes já passam por `trim`; só o nome exatamente igual é recusado aqui.
 * `juntar` continua aceitando "vip" + "VIP" → "VIP" para desduplicar grafias.
 */
export const vocabularioDeTagsSchema = z
  .object({
    acao: z.enum(ACOES_DE_VOCABULARIO, {
      error: "acao_invalida",
    }),
    tag: tagSchema,
    destino: tagSchema.nullish(),
    cor: corDeEtiquetaSchema.nullish(),
  })
  .superRefine((valor, ctx) => {
    if (valor.acao === "definir_cor") {
      // Presente-e-nula é pedido legítimo ("tirar a cor"); AUSENTE é erro de
      // quem chamou: sem o campo não dá para distinguir "limpe" de "esqueci de
      // mandar", e a operação diria que alterou quando não alterou nada.
      if (valor.cor === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cor"],
          message: "cor_obrigatoria",
        });
      }
      if (valor.destino != null) {
        // `definir_cor` não renomeia: aceitar um destino aqui faria a tela
        // prometer duas coisas e a função fazer uma.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["destino"],
          message: "destino_invalido_para_acao",
        });
      }
      return;
    }
    if (valor.cor != null) {
      // Renomear/juntar/excluir não falam de cor. Ignorar em silêncio deixaria a
      // tela acreditar que mandou uma cor junto.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cor"],
        message: "cor_invalida_para_acao",
      });
      return;
    }
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
      valor.destino === valor.tag
    ) {
      // Depois de aparar, o nome exatamente igual não muda nada. Outra caixa
      // precisa chegar à operação do banco, que preserva a normalização de
      // contatos e conversas sem apagar a grafia de exibição pedida.
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

export const tagsPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  busca: z.string().trim().max(60).default(""),
});
export const tagsPageResultSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(z.object({
    tag: z.string(), uso_em_contatos: z.number(), uso_em_leads: z.number(),
    uso_em_conversas: z.number(), em_regras: z.number(),
    cor: z.string().nullable(), descricao: z.string().nullable(), no_vocabulario: z.boolean(),
  })),
});

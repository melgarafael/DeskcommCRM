import { z } from "zod";

import { MAXIMO_DE_MIDIAS } from "@/lib/templates/midias";

/**
 * Uma mídia carregada pelo OPERADOR na resposta rápida (#2526) — uma imagem, ou
 * o áudio de um recurso (#2833): os dois são entradas da MESMA coluna.
 *
 * Só a descrição: os bytes moram no bucket privado `whatsapp-media` e o
 * caminho é gerado pela rota de upload. Por isso `storage_path` é texto aqui e
 * conferido na rota (`midiaPertenceAoTemplate`) — aceitar o caminho como ele
 * vem seria aceitar um arquivo que ninguém verificou como sendo deste
 * template, e a remoção apagaria o arquivo apontado.
 */
export const midiaDoTemplateSchema = z.object({
  storage_path: z.string().min(1).max(300),
  media_mime: z.string().min(1).max(100),
  media_size_bytes: z.number().int().min(0),
});

/** Só precondição: conserva o JSON completo recebido da linha, sem autorizar caminhos. */
export const snapshotDeMidiasSchema = z
  .array(midiaDoTemplateSchema.passthrough())
  .max(MAXIMO_DE_MIDIAS);

export const camposDoUploadDeTemplateSchema = z.object({
  substituir_audio: z.string().min(1).max(300).optional(),
  midias_esperadas: snapshotDeMidiasSchema.optional(),
});

/**
 * Criação (#2833). `body` pode ser VAZIO porque um recurso de áudio é uma
 * linha sem texto: o conteúdo dele é o arquivo, que entra por
 * `POST /message-templates/:id/midias` logo depois (o id ainda não existe
 * neste POST — o mesmo motivo pelo qual `midias` só existe no PATCH).
 *
 * O que a criação NÃO aceita continua não aceitando: `midias` no corpo — mídia
 * nova é só a que a rota de upload conferiu. Recurso de TEXTO sem mensagem
 * é recusado na TELA pela régua do conteúdo, onde a pessoa pode corrigir;
 * a rota não tem como distinguir "texto vazio" de "áudio
 * a caminho" sem uma coluna `tipo`, que este PR justamente não tem.
 */
export const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().max(4096).default(""),
  shortcut: z.string().trim().min(1).max(40).optional(),
  /** true = compartilhado da org (owner null, exige manager+); false = pessoal. */
  shared: z.boolean().default(false),
  /**
   * "Mostrar na barra do Inbox" (#3282). Ausente = LIGADO: a resposta nasce
   * aparecendo na barra, como o produto sempre fez. A tela manda `false` só
   * quando o operador desmarca.
   */
  mostrar_na_barra: z.boolean().optional(),
  /**
   * O GRUPO da resposta rápida (#3245) — `null`/ausente é "sem grupo", a lista
   * plana de sempre. O id é conferido na ROTA contra os grupos da organização
   * ativa (a FK composta do banco é a segunda barreira, não a primeira
   * mensagem): um id de outra organização sai como 422 com a frase que
   * interessa, e não como erro de constraint.
   */
  grupo_id: z.string().trim().min(1).max(64).nullable().optional(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/**
 * `midias` entra só na EDIÇÃO: a mídia nova é gravada pela rota de upload,
 * que gera o caminho e confere os bytes sabendo o id do template — um POST de
 * criação não tem esse id ainda. O PATCH daqui é quem REMOVE (lista completa
 * das que permanecem), e a rota apaga do bucket o que saiu da lista.
 */
export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
    midias: z.array(midiaDoTemplateSchema).max(MAXIMO_DE_MIDIAS).optional(),
    midias_esperadas: snapshotDeMidiasSchema.optional(),
    /** "Mostrar na barra do Inbox" (#3282) — o liga/desliga da tela. */
    mostrar_na_barra: z.boolean().optional(),
    /**
     * O GRUPO da resposta rápida (#3245). `null` DESVINCULA (volta à lista
     * plana); ausente não mexe no vínculo — é o que permite um PATCH de corpo
     * não tirar a resposta do grupo por omissão.
     */
    grupo_id: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .partial()
  .refine((d) => Object.keys(d).some((campo) => campo !== "midias_esperadas"), {
    message: "Informe ao menos um campo.",
  });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

/**
 * A REORDENAÇÃO (#3244) — onde a resposta rápida foi solta.
 *
 * `depois_de` é o id do vizinho da ESQUERDA; `null` é a primeira posição. A tela
 * manda o VIZINHO, nunca um número: quem arrasta sabe em que resposta soltou, e
 * a posição (`ordem`) que isso vira é conta do servidor (`lib/templates/ordem.ts`)
 * — o mesmo desenho da reordenação de etapa do funil.
 *
 * Não é `z.string().uuid()`: o id de uma resposta rápida é uuid, mas quem
 * VALIDA a posse é a lista visível da organização (a régua das mídias). Um
 * formato recusado aqui sairia como 422 "Dados inválidos" sem dizer que a
 * resposta é de outra organização, e é essa a mensagem que interessa.
 */
export const moverTemplateSchema = z.object({
  depois_de: z.string().trim().min(1).max(64).nullable(),
});
export type MoverTemplateInput = z.infer<typeof moverTemplateSchema>;

/**
 * O GRUPO de respostas rápidas (#3245) — nome, e só.
 *
 * O limite de 60 é o mesmo `check` do banco: recusar aqui é a mensagem que a
 * pessoa consegue consertar; o CHECK é a segunda barreira, para o corpo que não
 * passa por esta rota.
 */
export const createGrupoSchema = z.object({
  name: z.string().trim().min(1).max(60),
});
export type CreateGrupoInput = z.infer<typeof createGrupoSchema>;

/** Renomear (#3245): só o nome. A ordem tem rota própria, como a das respostas. */
export const updateGrupoSchema = createGrupoSchema;
export type UpdateGrupoInput = z.infer<typeof updateGrupoSchema>;

/**
 * A REORDENAÇÃO do grupo (#3245) — o mesmo contrato da resposta rápida: a tela
 * manda o VIZINHO da esquerda (`depois_de`), `null` é a primeira posição, e a
 * conta da posição é do servidor (`lib/templates/ordem.ts`).
 */
export const moverGrupoSchema = z.object({
  depois_de: z.string().trim().min(1).max(64).nullable(),
});
export type MoverGrupoInput = z.infer<typeof moverGrupoSchema>;

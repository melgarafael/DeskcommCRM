import { z } from "zod";

import { MAXIMO_DE_MIDIAS } from "@/lib/templates/midias";

/**
 * Uma imagem carregada pelo OPERADOR na resposta rápida (#2526).
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

export const createTemplateSchema = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(4096),
  shortcut: z.string().trim().min(1).max(40).optional(),
  /** true = compartilhado da org (owner null, exige manager+); false = pessoal. */
  shared: z.boolean().default(false),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/**
 * `midias` entra só na EDIÇÃO: a imagem nova é gravada pela rota de upload,
 * que gera o caminho e confere os bytes sabendo o id do template — um POST de
 * criação não tem esse id ainda. O PATCH daqui é quem REMOVE (lista completa
 * das que permanecem), e a rota apaga do bucket o que saiu da lista.
 */
export const updateTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
    midias: z.array(midiaDoTemplateSchema).max(MAXIMO_DE_MIDIAS).optional(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

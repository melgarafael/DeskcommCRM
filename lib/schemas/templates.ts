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

/**
 * Recursos pré-prontos (#2833): um modelo é de TEXTO (o `body`) ou de ÁUDIO
 * (o arquivo apontado por `media_path`). O compositor insere o texto no campo
 * editável ou arma o áudio como anexo pendente — nunca envia no clique.
 */
export const tipoDeRecursoSchema = z.enum(["texto", "audio"]);

export const createTemplateSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().max(4096).default(""),
    shortcut: z.string().trim().min(1).max(40).optional(),
    tipo: tipoDeRecursoSchema.default("texto"),
    media_path: z.string().trim().min(1).max(1024).optional(),
    media_mime: z.string().trim().min(1).max(255).optional(),
    media_size_bytes: z.number().int().nonnegative().optional(),
    /** true = compartilhado da org (owner null, exige manager+); false = pessoal. */
    shared: z.boolean().default(false),
  })
  // Recurso de texto precisa de mensagem; de áudio, do arquivo. As duas guardas
  // são separadas de propósito: a mensagem de erro cai no campo certo do form.
  .refine((d) => d.tipo === "audio" || d.body.length > 0, {
    message: "Recurso de texto precisa de mensagem.",
    path: ["body"],
  })
  .refine((d) => d.tipo !== "audio" || !!d.media_path, {
    message: "Recurso de áudio precisa do arquivo.",
    path: ["media_path"],
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
    body: z.string().trim().max(4096),
    shortcut: z.string().trim().min(1).max(40).nullable(),
    tipo: tipoDeRecursoSchema,
    media_path: z.string().trim().min(1).max(1024).nullable(),
    media_mime: z.string().trim().min(1).max(255).nullable(),
    media_size_bytes: z.number().int().nonnegative().nullable(),
    midias: z.array(midiaDoTemplateSchema).max(MAXIMO_DE_MIDIAS).optional(),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: "Informe ao menos um campo." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

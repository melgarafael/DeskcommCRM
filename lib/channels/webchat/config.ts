/**
 * Schemas do chat no site que a rota de quem administra aceita (spec 36, F1, Task 7).
 *
 * A lista de origens e a chave são colunas (`webchat_allowed_origins`, `webchat_public_key`),
 * com CHECK no banco; a aparência e os textos vivem em `channel_sessions.metadata.webchat` e
 * são lidos só por este schema. Zod aqui é a régua de quem ESCREVE; o CHECK do banco é a régua
 * de quem grava por fora da rota.
 */
import { z } from "zod";

import { env } from "@/lib/env";
import { enderecoDaPropriaMaquina } from "@/lib/webhooks/url-publica";

export const MAXIMO_DE_ORIGENS = 20;

/** Mesmo padrão de `fn_webchat_origens_validas`: https, host, porta opcional, sem caminho. */
const ORIGEM_HTTPS =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;
/** A exceção de loopback é desta rota, não do banco: depende da instalação. */
const ORIGEM_LOCALHOST = /^http:\/\/localhost(:[0-9]{1,5})?$/i;

const campoDaColeta = z.enum(["oculto", "opcional", "obrigatorio"]);

export const configuracaoDoChatSchema = z
  .object({
    titulo: z.string().trim().min(1).max(60).optional(),
    saudacao: z.string().trim().min(1).max(500).optional(),
    cor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    coleta: z
      .object({
        nome: campoDaColeta,
        telefone: campoDaColeta,
        email: campoDaColeta,
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export type ConfiguracaoDoChat = z.infer<typeof configuracaoDoChatSchema>;

/**
 * A lista de domínios que podem abrir o widget. Normaliza para minúsculas e tira duplicatas.
 * `http://localhost` entra só com a instalação em loopback: fora dela, a origem não existe.
 */
export function origensPermitidasSchema(instalacaoEmLoopback: boolean) {
  return z
    .array(
      z
        .string()
        .trim()
        .max(200)
        .refine((o) => ORIGEM_HTTPS.test(o) || (instalacaoEmLoopback && ORIGEM_LOCALHOST.test(o)), {
          message: "origem inválida: use https://host[:porta], sem caminho",
        }),
    )
    .max(MAXIMO_DE_ORIGENS)
    .transform((lista) => [...new Set(lista.map((o) => o.toLowerCase()))]);
}

/**
 * A instalação roda na própria máquina? A mesma régua que `basePublicaConfiguradaDaInstalacao`
 * usa para recusar a URL pública: `NEXT_PUBLIC_APP_URL` apontando para loopback.
 */
export function instalacaoEmLoopback(): boolean {
  return enderecoDaPropriaMaquina(env.NEXT_PUBLIC_APP_URL);
}

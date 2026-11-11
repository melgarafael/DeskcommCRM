/**
 * Ponte `postMessage` entre o CRM e o iframe de um módulo conectado (Spec 33, F4, tarefa 2).
 *
 * Módulo PURO (sem React, sem DOM, sem env): é a fronteira de segurança entre o CRM e a página de
 * um terceiro. Lista FECHADA de 6 mensagens; qualquer coisa fora dela é ignorada em silêncio.
 *
 * - módulo -> host: `module:ready`, `module:request-jwt`, `module:navigate { destination }`
 * - host -> módulo: `host:context { path, locale, theme, brand }`, `host:jwt { jwt, expires_at }`,
 *   `host:error { code }`
 *
 * O módulo nunca escolhe endereço: `destination` é só um id do catálogo de navegação (o host o
 * resolve e confere se a pessoa pode ver). Por isso o id aceita apenas `[a-z0-9_-]`, até 64.
 */
import { z } from "zod";

/** Tamanho máximo, em bytes, de uma mensagem enviada ao módulo. */
export const TAMANHO_MAXIMO_DA_MENSAGEM_BYTES = 8 * 1024;

/** Códigos de erro que o host pode devolver ao módulo (lista fechada). */
export const CODIGOS_DE_ERRO_DO_HOST = [
  "rate_limited",
  "jwt_unavailable",
  "not_allowed",
  "context_invalid",
] as const;

const destinoSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/);

const prontoSchema = z.object({ type: z.literal("module:ready") }).strict();
const pedirJwtSchema = z.object({ type: z.literal("module:request-jwt") }).strict();
const navegarSchema = z
  .object({ type: z.literal("module:navigate"), destination: destinoSchema })
  .strict();

/** As 3 mensagens que o módulo pode mandar ao host. */
export const MENSAGENS_DO_MODULO = [prontoSchema, pedirJwtSchema, navegarSchema] as const;

const mensagemDoModuloSchema = z.discriminatedUnion("type", [
  prontoSchema,
  pedirJwtSchema,
  navegarSchema,
]);

// Marca: só texto. Nenhuma URL de imagem passa para dentro do iframe.
const marcaSchema = z
  .object({
    name: z.string().max(80),
    primary_color: z.string().max(32).optional(),
  })
  .strict();

const contextoSchema = z
  .object({
    type: z.literal("host:context"),
    path: z.string().max(512).startsWith("/"),
    locale: z.string().min(1).max(16),
    theme: z.enum(["light", "dark"]),
    brand: marcaSchema,
  })
  .strict();
const jwtSchema = z
  .object({
    type: z.literal("host:jwt"),
    jwt: z.string().min(1),
    expires_at: z.string().min(1).max(64),
  })
  .strict();
const erroSchema = z
  .object({ type: z.literal("host:error"), code: z.enum(CODIGOS_DE_ERRO_DO_HOST) })
  .strict();

/** As 3 mensagens que o host pode mandar ao módulo. */
export const MENSAGENS_PARA_O_MODULO = [contextoSchema, jwtSchema, erroSchema] as const;

const mensagemParaOModuloSchema = z.discriminatedUnion("type", [
  contextoSchema,
  jwtSchema,
  erroSchema,
]);

export type MensagemDoModulo = z.infer<typeof mensagemDoModuloSchema>;
export type MensagemParaOModulo = z.infer<typeof mensagemParaOModuloSchema>;

/**
 * Lê uma mensagem vinda do iframe. Devolve `null` para tudo que não passa: origem diferente da
 * esperada, janela (`source`) diferente da do iframe, dado que não é objeto, tipo fora da lista,
 * campo extra ou valor inválido. Nunca lança.
 */
export function lerMensagemDoModulo(
  evento: { origin: string; source: unknown; data: unknown },
  esperado: { origin: string; janela: unknown },
): MensagemDoModulo | null {
  if (!esperado.origin || evento.origin !== esperado.origin) return null;
  // Sem janela esperada (iframe ainda sem contentWindow) nada vale: null === null não conta.
  if (esperado.janela == null || evento.source !== esperado.janela) return null;
  const dado = evento.data;
  if (dado === null || typeof dado !== "object" || Array.isArray(dado)) return null;
  const lido = mensagemDoModuloSchema.safeParse(dado);
  return lido.success ? lido.data : null;
}

/**
 * Serializa uma mensagem do host para o módulo, validando antes. Lança (em português) se a
 * mensagem for inválida ou passar de 8 KB.
 */
export function mensagemParaOModulo(m: MensagemParaOModulo): string {
  const lida = mensagemParaOModuloSchema.safeParse(m);
  if (!lida.success) {
    throw new Error("Mensagem para o módulo é inválida e não foi enviada.");
  }
  const texto = JSON.stringify(lida.data);
  if (new TextEncoder().encode(texto).length > TAMANHO_MAXIMO_DA_MENSAGEM_BYTES) {
    throw new Error("Mensagem para o módulo passa de 8 KB e não foi enviada.");
  }
  return texto;
}

/**
 * Schemas do chat no site que a rota de quem administra aceita (spec 36, F1).
 *
 * A lista de origens e a chave são colunas (`webchat_allowed_origins`, `webchat_public_key`),
 * com CHECK no banco; a aparência e os textos vivem em `channel_sessions.metadata.webchat` e
 * são lidos só por este schema. Zod aqui é a régua de quem ESCREVE; o CHECK do banco é a régua
 * de quem grava por fora da rota.
 */
import { z } from "zod";

import { env } from "@/lib/env";
import { TETO_ANONIMO_MAXIMO } from "../teto-do-anonimo";
import { enderecoDaPropriaMaquina } from "@/lib/webhooks/url-publica";

export const MAXIMO_DE_ORIGENS = 20;

/** Formato padrão da janela do chat. */
export const FORMATO_PADRAO = "bolha" as const;

/** Posição padrão da janela do chat. */
export const POSICAO_PADRAO = "direita" as const;

/** Mesmo padrão de `fn_webchat_origens_validas`: https, host, porta opcional, sem caminho. */
const ORIGEM_HTTPS =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;
/** A exceção de loopback é desta rota, não do banco: depende da instalação. */
const ORIGEM_LOCALHOST = /^http:\/\/localhost(:[0-9]{1,5})?$/i;

/**
 * Versão do texto do aviso de privacidade que o visitante aceita na primeira mensagem (LGPD).
 * Quem mostra o texto é a tela do widget; o servidor só grava a versão que o widget mandou.
 */
export const TEXTO_DO_AVISO_VERSAO = "v1";

const campoDaColeta = z.enum(["oculto", "opcional", "obrigatorio"]);

/** O que a conexão pede do visitante no primeiro contato. Campo ausente vale `opcional`. */
export type ModoDeColeta = z.infer<typeof campoDaColeta>;

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
    /**
     * Pausa do chat (F2). Fica na configuração, não em `channel_sessions.status`: o status
     * da conexão mexe em saúde do canal, vagas do plano e seletores. Pausado, a conexão pública
     * some (`conexaoPor` devolve `null`) e a organização continua vendo a conexão para retomar.
     */
    pausado: z.boolean().optional(),
    /**
     * Formato da janela do chat (F2-B). "bolha" (o que já existe), "painel"
     * (mesma bolha, chat aberto vira painel colado na lateral, altura da tela),
     * "embutido" (sem bolha: iframe dentro do elemento marcado por
     * data-webchat-alvo) e "pagina" (bolha, clique abre /chat/<chave> numa
     * nova aba). Ausente = "bolha".
     */
    formato: z.enum(["bolha", "painel", "embutido", "pagina"]).optional(),
    /**
     * Posição da janela (F2-B). "direita" ou "esquerda". Vale para "bolha",
     * "painel" e "pagina". Ausente = "direita".
     */
    posicao: z.enum(["direita", "esquerda"]).optional(),
    /**
     * URL da imagem do avatar da janela (F2-B, Tarefa 10a). Somente https, no
     * máximo 300 caracteres. Ausente ou "" = sem avatar.
     */
    avatar_url: z
      .string()
      .trim()
      .max(300)
      .refine((v) => {
        if (v === "") return true; // "" = tirar o avatar (a aba manda em branco)
        try {
          return new URL(v).protocol === "https:";
        } catch {
          return false;
        }
      })
      .optional(),
    /**
     * Abrir a janela sozinho após N segundos (F2-B, Tarefa 10a). 0 desliga.
     * Intervalo 0 a 120.
     */
    auto_abrir_segundos: z.number().int().min(0).max(120).optional(),
    /**
     * Tocar som ao chegar uma resposta (F2-B, Tarefa 10a).
     */
    som: z.boolean().optional(),
    /**
     * Respostas rápidas do visitante (F2-B, Tarefa 10a). Até 5 strings, cada
     * uma de 1 a 80 caracteres após trim.
     */
    respostas_rapidas: z.array(z.string().trim().min(1).max(80)).max(5).optional(),
    /**
     * Teto de respostas da IA para visitante anônimo (F4). Inteiro de 1 a 200; a entrada fora
     * disso é recusada (422). Ausente = padrão 20, aplicado por `tetoDoAnonimoDoCanal`, que também
     * trata um valor já gravado e inválido como 20: nunca "sem teto". Quem deixa telefone ou
     * e-mail sai deste teto.
     */
    teto_anonimo: z
      .number()
      .int()
      .min(1)
      .max(TETO_ANONIMO_MAXIMO)
      .optional(),
  })
  .strict();

export type ConfiguracaoDoChat = z.infer<typeof configuracaoDoChatSchema>;

/** Formato da janela do chat (F2-B). */
export type FormatoDoChat = z.infer<typeof configuracaoDoChatSchema>["formato"];

/** Posição da janela do chat (F2-B). */
export type PosicaoDoChat = z.infer<typeof configuracaoDoChatSchema>["posicao"];

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

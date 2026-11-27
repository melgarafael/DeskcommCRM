/**
 * POST /api/v1/webchat/mensagens — o visitante envia uma mensagem no chat no site (spec 36, F1).
 *
 * Pública, com o token de visitante no cabeçalho `Authorization: Bearer` (nunca na URL).
 * A conexão e a organização saem do TOKEN, assinado, e da linha da conexão no banco; o
 * corpo só traz o id da mensagem (idempotente) e o texto.
 *
 * Grava e enfileira, e responde 201 sem esperar a IA: a ingestão cuida do resto.
 */
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { conexaoPeloId, tokenDoBearer } from "@/lib/channels/webchat/conexao-pela-chave";
import { descreverErro, lerCorpoJson } from "@/lib/channels/webchat/entrada-publica";
import { ingerirMensagemDoChat } from "@/lib/channels/webchat/ingest";
import { assinarTokenDeVisitante, lerTokenDeVisitante } from "@/lib/channels/webchat/token";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const TEXTO_MAXIMO = 2000;
/**
 * Caracteres proibidos: controles C0 (menos tab e quebra de linha, que são texto normal),
 * DEL e C1, e os de direção (embedding e isolamento bidi, que trocam a ordem do que se lê).
 * U+200D não entra: emoji composto usa.
 */
const PROIBIDOS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

/** Telefone só em formato internacional (+ e 8 a 15 dígitos), depois de tirar os separadores. */
const TELEFONE_INTERNACIONAL = /^\+[0-9]{8,15}$/;

/**
 * O que o visitante informa no primeiro contato. A hora do aceite não vem aqui: é a do servidor.
 * Formato inválido NÃO recusa aqui: vira vazio, e a ingestão decide. Campo `obrigatorio` que
 * ficou vazio recusa; campo opcional ou oculto segue sem ele. Só o nome acima do teto ou com caractere de controle/bidi dá 422.
 * Único tratamento de texto: tirar espaço, parênteses, hífen e ponto do telefone. Nenhum DDI é inventado.
 */
const contatoSchema = z.object({
  nome: z
    .string()
    .trim()
    .max(120)
    .refine((n) => !PROIBIDOS.test(n))
    .optional(),
  telefone: z
    .string()
    .trim()
    .max(30)
    .transform((t) => t.replace(/[\s().-]/g, ""))
    .transform((t) => (TELEFONE_INTERNACIONAL.test(t) ? t : ""))
    .optional(),
  email: z
    .string()
    .trim()
    .max(200)
    .transform((e) => (z.string().email().safeParse(e).success ? e : ""))
    .optional(),
});

/**
 * Onde o visitante estava quando mandou a primeira mensagem (a janela envia só na primeira).
 * Rótulo de origem, não permissão: nada aqui decide acesso. Texto acima de 200 caracteres dá 422.
 * A ingestão grava só as chaves de UTM da lista fechada (`normalizarUtm`).
 */
const contextoSchema = z
  .object({
    href: z.string().max(200).optional(),
    referrer: z.string().max(200).optional(),
    utm: z.record(z.string(), z.string().max(200)).optional(),
  })
  .strict();

const corpoSchema = z
  .object({
    mensagem_id: z.string().uuid(),
    texto: z
      .string()
      .transform((t) => t.trim())
      .pipe(z.string().min(1).max(TEXTO_MAXIMO).refine((t) => !PROIBIDOS.test(t))),
    // Só a versão do aviso. Qualquer `em` que o cliente mandar é descartado (não é schema estrito).
    aceite: z.object({ versao: z.string().trim().min(1).max(40) }).optional(),
    contato: contatoSchema.optional(),
    contexto: contextoSchema.optional(),
  })
  .strict();

/** Por visitante: 20 mensagens por minuto. Por conexão: 600 por minuto. */
const LIMITE_POR_VISITANTE = 20;
const LIMITE_POR_CONEXAO = 600;
const JANELA_SEGUNDOS = 60;

function recusaPorLimite() {
  return fail("rate_limited", "Too many requests.", 429, {
    headers: { "Retry-After": String(JANELA_SEGUNDOS) },
  });
}

export async function POST(req: Request) {
  try {
    const token = tokenDoBearer(req.headers);
    if (!token) return fail("unauthenticated", "Missing token.", 401);

    const agora = new Date();
    const visitante = lerTokenDeVisitante(token, agora);
    if (!visitante.ok) {
      // Sem segredo no servidor, nenhum token pode ser conferido: é defeito de configuração,
      // não credencial errada. Por isso 500 e registro, e não 401.
      if (visitante.motivo === "segredo_ausente") {
        logger.error("webchat: INTERNAL_SECRET ausente; token de visitante não pode ser conferido", {
          rota: "mensagens",
          motivo: visitante.motivo,
        });
        return fail("internal_error", "Internal error.", 500);
      }
      return fail("unauthenticated", "Invalid token.", 401);
    }

    const tetoVisitante = await checkRateLimit(
      `webchat:mensagens:visitante:${visitante.visitanteId}`,
      LIMITE_POR_VISITANTE,
      JANELA_SEGUNDOS,
    );
    if (!tetoVisitante.allowed) return recusaPorLimite();

    const leitura = await lerCorpoJson(req);
    if (!leitura.ok) {
      return leitura.motivo === "grande"
        ? fail("payload_too_large", "Payload too large.", 413)
        : fail("validation_failed", "Dados inválidos.", 422);
    }
    const lido = corpoSchema.safeParse(leitura.valor);
    if (!lido.success) return fail("validation_failed", "Dados inválidos.", 422);
    const corpo = lido.data;

    const tetoConexao = await checkRateLimit(
      `webchat:mensagens:conexao:${visitante.channelSessionId}`,
      LIMITE_POR_CONEXAO,
      JANELA_SEGUNDOS,
    );
    if (!tetoConexao.allowed) return recusaPorLimite();

    const admin = createAdminClient();
    const conexao = await conexaoPeloId(admin, visitante.channelSessionId);
    // Conexão arquivada, organização suspensa ou módulo desligado: o mesmo 404 da chave.
    if (!conexao) return fail("not_found", "Not found.", 404);

    const resultado = await ingerirMensagemDoChat(admin, {
      organizationId: conexao.organizationId,
      channelSessionId: conexao.id,
      visitanteId: visitante.visitanteId,
      mensagemId: corpo.mensagem_id,
      texto: corpo.texto,
      agora,
      // A hora do aceite é a do servidor, nunca a do corpo.
      ...(corpo.aceite ? { aceite: { versao: corpo.aceite.versao, em: agora.toISOString() } } : {}),
      ...(corpo.contato ? { contato: corpo.contato } : {}),
      ...(corpo.contexto ? { contexto: corpo.contexto } : {}),
      coleta: conexao.config.coleta,
    });
    // Primeira mensagem sem aceite ou sem campo obrigatório: 422 genérico, nada foi criado.
    if (resultado.status === "recusada") return fail("validation_failed", "Dados inválidos.", 422);

    return ok(
      {
        mensagem_id: corpo.mensagem_id,
        status: resultado.status,
        // Token perto do vencimento: o navegador troca pelo novo, com o mesmo visitante.
        ...(visitante.renovar
          ? {
              token_novo: assinarTokenDeVisitante({
                channelSessionId: visitante.channelSessionId,
                visitanteId: visitante.visitanteId,
                agora,
              }),
            }
          : {}),
      },
      { status: 201 },
    );
  } catch (erro) {
    logger.error("webchat: erro na rota pública de mensagens", {
      rota: "mensagens",
      ...descreverErro(erro),
    });
    return fail("internal_error", "Internal error.", 500);
  }
}

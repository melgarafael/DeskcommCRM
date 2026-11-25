/**
 * POST /api/v1/webchat/sessao — o visitante abre a janela do chat no site (spec 36, F1).
 *
 * Pública: quem chama é o navegador do visitante, sem sessão. A autoridade é a chave
 * pública (`wck_`) do corpo, que identifica a conexão. Ela não é segredo (está no script
 * do site do cliente) e não autoriza nada sozinha: o limite de chamadas é a proteção.
 *
 * Devolve o token de visitante (novo, ou com o mesmo `visitante_id` se vier um token
 * válido desta conexão) e a configuração pública da janela.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { carregarAtendimento, type EstadoDoAtendimento } from "@/lib/channels/webchat/atendimento";
import { conexaoPelaChave, tokenDoBearer } from "@/lib/channels/webchat/conexao-pela-chave";
import { descreverErro, lerCorpoJson } from "@/lib/channels/webchat/entrada-publica";
import { assinarTokenDeVisitante, lerTokenDeVisitante } from "@/lib/channels/webchat/token";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.object({ chave: z.string().min(1).max(128) }).strict();

/** Por IP, em qualquer chave: 30 aberturas por minuto. Barra quem troca de chave a cada pedido. */
const LIMITE_POR_IP = 30;
/** Por IP e chave: 10 aberturas de janela por minuto. */
const LIMITE_POR_IP_E_CHAVE = 10;
const JANELA_SEGUNDOS = 60;

function recusaPorLimite() {
  return fail("rate_limited", "Too many requests.", 429, {
    headers: { "Retry-After": String(JANELA_SEGUNDOS) },
  });
}

export async function POST(req: Request) {
  try {
    // O balde por IP vem ANTES de qualquer leitura de corpo e de qualquer consulta ao banco.
    const ip = ipDoCliente(req.headers) ?? "sem-ip";
    const tetoIp = await checkRateLimit(`webchat:sessao:ip:${ip}`, LIMITE_POR_IP, JANELA_SEGUNDOS);
    if (!tetoIp.allowed) return recusaPorLimite();

    const leitura = await lerCorpoJson(req);
    if (!leitura.ok) {
      return leitura.motivo === "grande"
        ? fail("payload_too_large", "Payload too large.", 413)
        : fail("validation_failed", "Dados inválidos.", 422);
    }
    const lido = corpoSchema.safeParse(leitura.valor);
    if (!lido.success) return fail("validation_failed", "Dados inválidos.", 422);
    const { chave } = lido.data;

    const teto = await checkRateLimit(
      `webchat:sessao:${ip}:${chave}`,
      LIMITE_POR_IP_E_CHAVE,
      JANELA_SEGUNDOS,
    );
    if (!teto.allowed) return recusaPorLimite();

    const admin = createAdminClient();
    const conexao = await conexaoPelaChave(admin, chave);
    // Os quatro casos (chave, arquivada, suspensa, módulo) saem como o mesmo 404.
    if (!conexao) return fail("not_found", "Not found.", 404);

    const agora = new Date();
    // Horário do atendimento (F3). Falha ao ler = `aberto` (falha aberta): a sessão segue igual.
    let atendimento: EstadoDoAtendimento = { estado: "aberto", abreEm: null, aviso: null };
    try {
      atendimento = await carregarAtendimento(admin, conexao.organizationId, conexao.id, agora);
    } catch (erro) {
      logger.warn("webchat: horário do atendimento indisponível; segue como aberto", {
        rota: "sessao",
        organization_id: conexao.organizationId,
        channel_session_id: conexao.id,
        ...descreverErro(erro),
      });
    }
    const token = tokenDoBearer(req.headers);
    const anterior = token ? lerTokenDeVisitante(token, agora) : null;
    // Visitante só é reaproveitado com token VÁLIDO desta conexão. Outra conexão, token
    // vencido ou adulterado: começa um visitante novo.
    const visitanteId =
      anterior && anterior.ok && anterior.channelSessionId === conexao.id
        ? anterior.visitanteId
        : randomUUID();

    return ok({
      token: assinarTokenDeVisitante({ channelSessionId: conexao.id, visitanteId, agora }),
      visitante_id: visitanteId,
      configuracao: conexao.config,
      atendimento: {
        estado: atendimento.estado,
        abre_em: atendimento.abreEm,
        aviso: atendimento.aviso,
      },
    });
  } catch (erro) {
    logger.error("webchat: erro na rota pública de sessão", { rota: "sessao", ...descreverErro(erro) });
    return fail("internal_error", "Internal error.", 500);
  }
}

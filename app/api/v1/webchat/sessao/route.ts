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
import { conexaoPelaChave, tokenDoBearer } from "@/lib/channels/webchat/conexao-pela-chave";
import { assinarTokenDeVisitante, lerTokenDeVisitante } from "@/lib/channels/webchat/token";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.object({ chave: z.string().min(1).max(128) }).strict();

/** Por IP e chave: 10 aberturas de janela por minuto. */
const LIMITE_POR_MINUTO = 10;
const JANELA_SEGUNDOS = 60;

export async function POST(req: Request) {
  try {
    const lido = corpoSchema.safeParse(await req.json().catch(() => null));
    if (!lido.success) return fail("validation_failed", "Dados inválidos.", 422);
    const { chave } = lido.data;

    const ip = ipDoCliente(req.headers) ?? "sem-ip";
    const teto = await checkRateLimit(`webchat:sessao:${ip}:${chave}`, LIMITE_POR_MINUTO, JANELA_SEGUNDOS);
    if (!teto.allowed) {
      return fail("rate_limited", "Too many requests.", 429, {
        headers: { "Retry-After": String(JANELA_SEGUNDOS) },
      });
    }

    const admin = createAdminClient();
    const conexao = await conexaoPelaChave(admin, chave);
    // Os quatro casos (chave, arquivada, suspensa, módulo) saem como o mesmo 404.
    if (!conexao) return fail("not_found", "Not found.", 404);

    const agora = new Date();
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
    });
  } catch {
    return fail("internal_error", "Internal error.", 500);
  }
}

import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * "Ouvir amostra" de uma voz: o SERVIDOR sintetiza uma frase FIXA
 * (`FRASE_DA_AMOSTRA`) e devolve o OGG/Opus. Nada do texto vem do navegador.
 *
 * A voz pedida passa por duas barreiras no servidor: a regra de
 * `lib/agent-engine/edge/voz/vozes.ts` (só pt-BR Standard) e a
 * presença na lista que o Google devolve PARA ESTA CHAVE. Valor arbitrário é
 * 422 antes de qualquer chamada paga.
 *
 * Gasta uma fração mínima da franquia da chave (~70 caracteres): por isso é
 * admin, e suporte temporário não a dispara.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { lerChaveDaVoz } from "@/lib/ai/voz/credencial";
import { criarSintetizador, FalhaDaVoz, listarVozesPtBr } from "@/lib/agent-engine/edge/voz/sintese";
import { FRASE_DA_AMOSTRA, VOZ_ACEITA } from "@/lib/agent-engine/edge/voz/vozes";
import { MIME_DA_VOZ } from "@/lib/agent-engine/agent/resposta-em-audio";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const postSchema = z.object({ voz: z.string().regex(VOZ_ACEITA) }).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = postSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Escolha uma voz da lista."), 422, { requestId });
  }

  const chave = await lerChaveDaVoz(createAdminClient(), authz.org.orgId);
  if (!chave) {
    return fail("voz_nao_configurada", t("Cadastre a chave do Google Cloud Text-to-Speech em IA › Provedores."), 409, {
      requestId,
    });
  }

  try {
    const disponiveis = await listarVozesPtBr(chave.chave);
    if (!disponiveis.some((v) => v.nome === parsed.data.voz)) {
      return fail("validation_failed", t("Escolha uma voz da lista."), 422, { requestId });
    }
    const audio = await criarSintetizador({ apiKey: chave.chave, voz: parsed.data.voz })(FRASE_DA_AMOSTRA);
    return new Response(new Uint8Array(audio), {
      status: 200,
      headers: {
        "content-type": MIME_DA_VOZ,
        "cache-control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch (err) {
    const codigo = err instanceof FalhaDaVoz ? err.code : "rede";
    const status = err instanceof FalhaDaVoz ? err.status : null;
    return fail("voz_indisponivel", t("Não consegui gerar a amostra. Teste a chave."), 502, {
      requestId,
      details: { codigo, status },
    });
  }
}

"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { FORMATO_DO_DIRETORIO } from "@/lib/agenda/microsoft/config";
import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { respostaParaOperador } from "@/lib/erros/para-operador";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

/**
 * Cadastra o aplicativo da Microsoft DESTA INSTALAÇÃO. Irmã de
 * `updateGoogleOAuth`: só quem administra a instalação, segredo sempre cifrado
 * (sem chave mestra o save RECUSA) e nunca devolvido à tela.
 */
const entradaSchema = z.object({
  client_id: z.string().trim().uuid(),
  /** Vazio = manter o gravado. */
  client_secret: z.string().trim().min(10).max(300).regex(/^[^\s"',]+$/).optional(),
  /** Vazio = qualquer conta. */
  tenant: z.union([z.literal(""), z.string().trim().max(120).regex(FORMATO_DO_DIRETORIO)]),
});

export async function updateMicrosoftOAuth(
  input: z.input<typeof entradaSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;

  const parsed = entradaSchema.safeParse(input);
  if (!parsed.success) {
    const campo = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      error:
        campo === "client_id"
          ? "O ID do aplicativo tem o formato 00000000-0000-0000-0000-000000000000."
          : campo === "client_secret"
            ? "Copie só o valor do segredo do cliente, sem espaços nem aspas."
            : "Confira o ID do diretório.",
    };
  }

  const admin = createAdminClient();
  const valores: Record<string, unknown> = {
    client_id: parsed.data.client_id,
    tenant: parsed.data.tenant || null,
    updated_by: user.id,
  };
  if (parsed.data.client_secret) {
    const cifrado = await encryptWebhookSecret(admin, parsed.data.client_secret);
    if (!cifrado)
      return { ok: false, error: "A chave de cifra desta instalação está ausente; o segredo não foi gravado." };
    valores.client_secret_encrypted = cifrado;
  }

  const { error } = await admin
    .from("platform_microsoft_oauth")
    .upsert({ id: 1, ...valores }, { onConflict: "id" });
  if (error)
    return respostaParaOperador(error, {
      contexto: "[microsoft.oauth] falha ao gravar a credencial da instalação",
    });

  const cabecalhos = await headers();
  await audit({
    action: "platform_microsoft_oauth.updated",
    actorUserId: user.id,
    resourceType: "platform_microsoft_oauth",
    // Singleton: `resource_id` é uuid.
    resourceId: null,
    requestId: cabecalhos.get("x-request-id") ?? undefined,
    ip: ipDoCliente(cabecalhos) ?? undefined,
    userAgent: cabecalhos.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    metadata: {
      campos: Object.keys(valores).filter((k) => k !== "updated_by"),
      segredo_trocado: Boolean(parsed.data.client_secret),
    },
  });
  return { ok: true };
}

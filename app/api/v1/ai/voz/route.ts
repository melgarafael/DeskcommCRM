import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * A chave de VOZ da organização (IA › Provedores, cartão "Voz e áudio").
 *
 *   GET    — estado: configurada?, máscara (••••1234), validada?, código do
 *            último erro, e qual chave o atendimento usaria agora. Nunca a chave.
 *   PUT    — grava ou SUBSTITUI a chave (sempre a chave inteira). Admin.
 *   DELETE — remove a chave da organização. Admin.
 *
 * A chave mora em `ai_provider_credentials` (`provider = 'google-tts'`), cifrada
 * pelo mesmo miolo das chaves de IA (`lib/ai/voz/credencial.ts`). "Testar",
 * "vozes" e "amostra" moram nas subrotas.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  chaveDeVozSchema,
  estadoDaVoz,
  guardarChaveDeVoz,
  removerChaveDeVoz,
} from "@/lib/ai/voz/credencial";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const putSchema = z.object({ api_key: chaveDeVozSchema }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  try {
    return ok(await estadoDaVoz(createAdminClient(), authz.org.orgId), { requestId });
  } catch {
    return fail("internal_error", traduzir("Não consegui ler a configuração de voz.", authz.user.idioma), 500, {
      requestId,
    });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
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
  const parsed = putSchema.safeParse(bruto);
  if (!parsed.success) {
    // Sem `details`: o detalhe do Zod ecoaria o valor recebido — a chave.
    return fail(
      "validation_failed",
      t("Essa não parece uma chave do Google Cloud: confira se copiou a chave inteira."),
      422,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const r = await guardarChaveDeVoz(admin, {
    organizationId: authz.org.orgId,
    userId: authz.user.id,
    apiKey: parsed.data.api_key,
    requestId,
  });
  if (!r.ok) {
    return fail(
      "internal_error",
      r.motivo === "cifragem"
        ? t("A cifra do servidor não está disponível; a chave não foi gravada.")
        : t("Não consegui gravar a chave."),
      500,
      { requestId },
    );
  }
  return ok(await estadoDaVoz(admin, authz.org.orgId), { requestId });
}

export async function DELETE(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  let removeu: boolean;
  try {
    removeu = await removerChaveDeVoz(admin, {
      organizationId: authz.org.orgId,
      userId: authz.user.id,
      requestId,
    });
  } catch {
    return fail("internal_error", traduzir("Não consegui remover a chave.", authz.user.idioma), 500, { requestId });
  }
  return ok({ ...(await estadoDaVoz(admin, authz.org.orgId)), removida: removeu }, { requestId });
}

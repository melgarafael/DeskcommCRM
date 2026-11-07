/**
 * PATCH /api/v1/settings/catalogo — liga ou desliga a apresentação do catálogo
 * pela IA (`settings.catalogo.apresentacao`) para esta empresa. Quem lê a chave é
 * `capacidadesLigadas()`; desligar não apaga o que já foi cadastrado.
 *
 * Papel `admin`, o mesmo da tela que hospeda a chave (`/app/settings/tenant`).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ apresentacao: z.boolean() }).strict();

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "organizations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  // Admin client: a RLS de `organizations` só deixa platform admin escrever, e o
  // cliente de sessão casaria zero linhas dizendo sucesso (issue #144).
  const db = createAdminClient();
  const lido = await db.from("organizations").select("settings").eq("id", orgId).maybeSingle();
  // Leitura que falhou não vira `settings` vazio: o update apagaria o resto da configuração.
  if (lido.error || !lido.data) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });

  const settings = lido.data.settings as Record<string, unknown> | null;
  const catalogo = settings?.catalogo;
  const novo = {
    ...(settings ?? {}),
    catalogo: { ...(catalogo && typeof catalogo === "object" ? catalogo : {}), apresentacao: parsed.data.apresentacao },
  };

  // CAS do documento inteiro, como `settings/agenda-apresentacao`: escrita
  // concorrente nunca perde outra configuração da empresa.
  const update = db.from("organizations").update({ settings: novo }).eq("id", orgId);
  const salvo = await (settings === null
    ? update.is("settings", null)
    : update.filter("settings", "eq", JSON.stringify(settings))
  )
    .select("id")
    .maybeSingle();
  if (salvo.error) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });
  if (!salvo.data) {
    return fail("conflict", t("A configuração mudou. Recarregue a página e tente novamente."), 409, { requestId });
  }

  void audit({
    action: "catalogo.apresentacao_changed",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "organization",
    resourceId: orgId,
    requestId,
    metadata: { apresentacao: parsed.data.apresentacao },
  });

  return ok(parsed.data, { requestId });
}

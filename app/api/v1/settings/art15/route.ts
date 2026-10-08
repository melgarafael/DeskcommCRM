/**
 * PATCH /api/v1/settings/art15 — as alíneas a), c) e d) do art. 15.º, n.º 1
 * que o RELATÓRIO DE ACESSO imprime em nome do controlador (issue #2356).
 *
 * A porta que faltava. O #2354 fez o PDF ler `organizations.settings.art15`
 * (`lib/legal/art15.ts`), mas nada no produto GRAVAVA esta chave: cada chave de
 * `settings` tem a sua rota própria e esta não existia, então só um `UPDATE` em
 * SQL preenchia os campos — na prática, toda organização de Portugal imprimia
 * "não informado pelo controlador" nas três alíneas.
 *
 * Mesma forma de `settings/assinatura`: merge NÃO destrutivo do jsonb (preserva
 * as demais chaves de `settings`), leitura que falhou PARA a gravação — tratá-la
 * como `{}` regravaria o settings inteiro só com esta chave —, e o PRÓPRIO
 * `art15SettingsSchema` como validação. Os limites (2000, 2000 e 500) moram num
 * lugar só, ao lado de quem os lê no PDF: a tela repete o limite na
 * `maxLength`, mas quem RECUSA é o schema.
 *
 * Gate `admin`, e não `manager`: as alíneas são a declaração do controlador
 * perante a autoridade de supervisão, e a tela que as serve (Configurações ›
 * Empresa) já é admin-only (`app/app/settings/tenant/page.tsx`).
 *
 * Vazio vira `null` (a mesma leitura de `art15DoControlador`): uma alínea em
 * branco na tela não é "guardou vazio", é "não informado pelo controlador" no
 * documento — e o relatório tem de continuar dizendo isso em vez de inventar.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { art15DoControlador, art15SettingsSchema, type Art15Settings } from "@/lib/legal/art15";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "settings_art15" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const parsed = art15SettingsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  // `|| null` e não `?? null`: string só espaços é `trim()` para "" no schema, e
  // "" é o MESMO "não preenchido" de `null` em `art15DoControlador`. Guardar ""
  // deixaria a chave preenchida no jsonb com um valor que o relatório trata
  // como ausente — duas formas de dizer a mesma coisa na mesma coluna.
  const alineas: Art15Settings = {
    finalidades: parsed.data.finalidades || null,
    destinatarios: parsed.data.destinatarios || null,
    prazo_conservacao: parsed.data.prazo_conservacao || null,
  };

  const supabase = createAdminClient();
  const { data: orgRow, error: readErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const { error: updErr } = await supabase
    .from("organizations")
    .update({ settings: { ...currentSettings, art15: alineas } })
    .eq("id", authz.org.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "org.art15_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    // Os três textos, e não só os tamanhos: a pergunta que a trilha responde é
    // "o que o controlador DECLAROU quando". O conteúdo é declaração da própria
    // organização, publicada no relatório de acesso — não é dado de titular.
    metadata: alineas,
  });

  return ok(art15DoControlador({ art15: alineas }), { requestId });
}

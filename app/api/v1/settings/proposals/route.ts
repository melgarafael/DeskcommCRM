import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";
import { moduloLigado } from "@/lib/instalacao/modulos";

export const dynamic = "force-dynamic";
const patchSchema = z.object({
  enabled: z.boolean(),
  default_valid_days: z.number().int().positive().max(365),
  default_conditions: z.string().max(4000).nullable(),
  // N2 — OPCIONAL de propósito (não obrigatório como o plano escrevia): a
  // tela de Configurações › Propostas manda só os 3 campos antigos, e ela não
  // está no escopo desta task. Obrigatório quebraria o salvar dela com 422.
  followup_dias: z.number().int().positive().max(365).optional(),
  avisar_no_whatsapp: z.boolean().optional(),
});

/**
 * Doc 79: com o módulo desligado na INSTALAÇÃO, esta rota não existe — nenhuma
 * empresa vê nem liga Propostas. 404, o mesmo de `seModuloDesligado` do banco
 * externo. Vem depois do papel (403 antes de 404: não diz a quem não pode o
 * que está instalado).
 */
async function seModuloDesligado(requestId: string): Promise<Response | null> {
  if (await moduloLigado(createAdminClient(), "propostas")) return null;
  return fail("not_found", "Not found.", 404, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "organizations", role: "viewer", scope: "config:read", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposals", requestId);
  if (teto) return teto;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const supabase = authz.supabase;
  const { data } = await supabase.from("organizations").select("settings").eq("id", authz.organizationId).single();
  const propostasGravadas = (data?.settings as Record<string, unknown> | null)?.proposals as Record<string, unknown> | null;
  // N2 — o default de `followup_dias` vale também para organização que gravou
  // o objeto ANTES do knob existir (o `??` abaixo só cobriria `proposals`
  // inteiramente ausente).
  const proposals = {
    followup_dias: 3,
    avisar_no_whatsapp: true,
    ...(propostasGravadas ?? { enabled: false, default_valid_days: 15, default_conditions: null }),
  };
  return ok(proposals, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, { requestId, resource: "organizations", role: "manager", scope: "config:write", tokenRole: "admin" });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "settings.proposals", requestId);
  if (teto) return teto;
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Campos inválidos."), 422, { requestId });

  // ADMIN CLIENT, nao createClient() — RLS de organizations so permite
  // UPDATE a platform_admin; um manager comum casaria 0 linhas em silencio
  // (issue #144, ver settings/routing/route.ts). O gate de papel acima
  // continua sendo a protecao real.
  const supabase = createAdminClient();
  const { data: atual } = await supabase.from("organizations").select("settings").eq("id", authz.organizationId).single();
  const settingsAtual = (atual?.settings as Record<string, unknown> | null) ?? {};
  // N2 — merge raso sobre o `proposals` já gravado (não substituição cega):
  // a tela antiga manda só os 3 campos de sempre; sem isto, cada salvar dela
  // apagaria o `followup_dias` de volta para o default.
  const proposalsAtual = (settingsAtual.proposals as Record<string, unknown> | null) ?? {};
  const settingsMesclado = { ...settingsAtual, proposals: { ...proposalsAtual, ...parsed.data } };

  const { error } = await supabase.from("organizations").update({ settings: settingsMesclado }).eq("id", authz.organizationId);
  if (error) return fail("internal_error", t("Falha ao salvar."), 500, { requestId });

  void audit({
    action: "proposals.config_changed", actorUserId: authz.actor.type === "user" ? authz.actor.id : null, actorApiTokenId: authz.apiTokenId ?? null, organizationId: authz.organizationId,
    resourceType: "organization", resourceId: authz.organizationId, requestId,
    metadata: { proposals: parsed.data },
  });

  return ok(parsed.data, { requestId });
}

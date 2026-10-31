import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET   /api/v1/ai/voz — a voz da organização (voice_id/model_id + o que há
 *       disponível na credencial ElevenLabs) e PATCH para trocá-la.
 *
 * Fase 7 do plano de voz (docs/superpowers/plans/2026-10-29-voz-elevenlabs.md).
 * `voz_enabled`/`voz_quando` são POR VERSÃO do agente (editados no editor de
 * agente, como `split_messages`) — aqui mora só a escolha de QUAL voz, que é
 * da ORGANIZAÇÃO (um recurso contratado uma vez, não por agente), o mesmo
 * desenho de `organizations.settings.llm`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface VozSettings {
  voice_id?: string;
  model_id?: string;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const admin = createAdminClient();

  const [{ data: orgRow }, { data: credenciais }] = await Promise.all([
    admin.from("organizations").select("settings").eq("id", org.orgId).maybeSingle(),
    admin
      .from("ai_provider_credentials")
      .select("id, label, models_available, validated_at")
      .eq("organization_id", org.orgId)
      .eq("provider", "elevenlabs")
      .eq("is_active", true)
      .order("created_at", { ascending: false }),
  ]);

  const voz = ((orgRow?.settings as { voz?: VozSettings } | null)?.voz ?? {}) as VozSettings;

  // Vozes de TODAS as credenciais ElevenLabs ativas, sem duplicar — o
  // operador comum tem uma só, mas nada impede uma segunda (ex.: trocando de
  // conta). `models_available` já carrega os `voice_id` (gravados pelo
  // validador — `lib/ai/provider-validators.ts`), não nomes: a tela mostra o
  // id e o botão "ouvir prévia" é o que de fato identifica a voz.
  const vozesDisponiveis = [
    ...new Set((credenciais ?? []).flatMap((c) => c.models_available ?? [])),
  ];

  return ok(
    {
      voiceId: voz.voice_id ?? null,
      modelId: voz.model_id ?? null,
      vozesDisponiveis,
      temCredencial: (credenciais ?? []).some((c) => c.validated_at !== null),
    },
    { requestId },
  );
}

const corpoDoPatch = z.object({
  voice_id: z.string().trim().min(1).max(200),
  model_id: z.string().trim().min(1).max(200).nullable().optional(),
});

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_providers" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = corpoDoPatch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("corpo inválido"), 422, { requestId, details: parsed.error.issues });
  }
  const corpo = parsed.data;

  const admin = createAdminClient();

  // MERGE, nunca sobrescrita — mesma razão do PATCH de `settings.llm`
  // (`app/api/v1/ai/providers/route.ts`): `settings` é compartilhado com
  // `branding`/`security`, e um `update({settings:{voz}})` ingênuo os apagaria.
  const { data: orgAtual } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();

  const settingsAtuais = ((orgAtual?.settings ?? {}) as Record<string, unknown>) || {};
  // Achado na revisão de código: isto fazia `model_id` desaparecer em
  // QUALQUER save — a única tela que chama este PATCH (`CartaoDeVoz`) manda
  // só `voice_id`, nunca `model_id`, então o PATCH sobrescrevia o objeto
  // `voz` inteiro e apagava um modelo que ninguém pediu para trocar. Regra
  // agora: `model_id` AUSENTE do corpo preserva o que já estava salvo;
  // `model_id: null` explícito é o único jeito de limpá-lo.
  const vozAtual = (settingsAtuais.voz ?? {}) as VozSettings;
  const modelIdFinal = corpo.model_id !== undefined ? corpo.model_id : vozAtual.model_id ?? null;
  const settings = {
    ...settingsAtuais,
    voz: {
      voice_id: corpo.voice_id,
      ...(modelIdFinal ? { model_id: modelIdFinal } : {}),
    },
  };

  // Mesmo motivo do PATCH irmão: RLS de `organizations` só deixa platform
  // admin escrever com o client de sessão — o `.eq("id", org.orgId)` aqui é
  // a única coisa que impede isto de ser um escritor cross-tenant, porque o
  // service role passa por cima da RLS.
  const { data: gravado, error } = await admin
    .from("organizations")
    .update({ settings })
    .eq("id", org.orgId)
    .select("settings")
    .maybeSingle();

  if (error || !gravado) {
    return fail("internal_error", t("Erro ao salvar a voz."), 500, { requestId });
  }

  void audit({
    action: "ai.voz_settings_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: { voice_id: corpo.voice_id, model_id: corpo.model_id ?? null },
  });

  return ok({ voiceId: corpo.voice_id, modelId: corpo.model_id ?? null }, { requestId });
}

"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireOnboardingCtx, patchOnboardingState } from "./_shared";

export async function skipWhatsapp(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    whatsapp: { status: "skipped", skipped: true },
  });
  await audit({
    action: "onboarding.whatsapp_skipped",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
  });
  // O roteador do wizard decide o próximo step (Nuvemshop só existe com
  // NUVEMSHOP_ENABLED) — hardcodar aqui mandava o usuário pra um step oculto.
  redirect("/onboarding");
}

export async function markWhatsappConfigured(
  sessionName: string,
  status: string,
): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    whatsapp: { session_name: sessionName, status },
  });
  // resource_id column in api_audit_log is uuid — sessionName is a text
  // identifier (e.g. "org_988371bf"), not a uuid. Pass it via metadata.
  await audit({
    action: "onboarding.whatsapp_configured",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "channel_session",
    metadata: { session_name: sessionName, status },
  });
  redirect("/onboarding");
}

export async function skipNuvemshop(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    nuvemshop: { skipped: true },
  });
  await audit({
    action: "onboarding.nuvemshop_skipped",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
  });
  redirect("/onboarding");
}

export async function markNuvemshopConfigured(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    nuvemshop: { connected_at: new Date().toISOString() },
  });
  redirect("/onboarding");
}

"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { esquecerDispositivosConfiaveis as esquecer } from "@/lib/auth/dispositivo-confiavel";

/**
 * "Esquecer todos os dispositivos": o próximo login em qualquer navegador volta
 * a pedir o código. As sessões que esses dispositivos provavam deixam de contar
 * como provadas na hora — o banco só aceita a sessão enquanto a linha existe.
 */
export async function esquecerDispositivosConfiaveis(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  await esquecer(user.id);
  await audit({
    action: "auth.mfa_trusted_devices_forgotten",
    actorUserId: user.id,
    resourceType: "user",
    resourceId: user.id,
    requestId: (await headers()).get("x-request-id"),
  });
  revalidatePath("/app/settings/security");
  return { ok: true };
}

"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";
import { encerrarPushDeTodosOsAparelhos } from "@/lib/notifications/encerrar-push-de-todos-os-aparelhos";
import { headers } from "next/headers";

/**
 * Sair de todos os dispositivos também encerra os avisos de todos eles: as
 * inscrições de push da pessoa (em todas as organizações) são apagadas antes
 * das sessões. Ver `encerrarPushDeTodosOsAparelhos`.
 */
export async function signOutEverywhere(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");

  if (user) await encerrarPushDeTodosOsAparelhos(user.id, requestId);

  await supabase.auth.signOut({ scope: "global" });

  if (user) {
    await audit({
      action: "auth.logout",
      actorUserId: user.id,
      requestId,
      metadata: { scope: "global" },
    });
  }
  redirect("/login");
}

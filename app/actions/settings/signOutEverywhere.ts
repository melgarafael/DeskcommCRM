"use server";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import {
  invalidarSessao,
  invalidarUsuario,
  sessaoDosCookies,
  type SessaoDosCookies,
} from "@/lib/auth/cache-curto";
import { audit } from "@/lib/audit";
import { encerrarPushDeTodosOsAparelhos } from "@/lib/notifications/encerrar-push-de-todos-os-aparelhos";
import { cookies, headers } from "next/headers";
import { logger } from "@/lib/logger";
import { esquecerDispositivosConfiaveis } from "@/lib/auth/dispositivo-confiavel";

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

  if (user) {
    await encerrarPushDeTodosOsAparelhos(user.id, requestId);
    // Sair de todos é recomeçar do zero: nenhum navegador fica dispensado do
    // código. Como o push acima, falhar aqui não pode impedir a saída — as
    // sessões morrem do mesmo jeito; fica o registro para quem investigar.
    await esquecerDispositivosConfiaveis(user.id).catch((e: unknown) =>
      logger.warn("dispositivos_confiaveis_signout_global_failed", {
        userId: user.id,
        message: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  let sessao: SessaoDosCookies | null = null;
  try {
    sessao = sessaoDosCookies((await cookies()).getAll());
  } catch {
    // Fora de escopo de requisição não há cookie para esquecer; a saída acontece
    // e o cache da pessoa cai pelo `invalidarUsuario` abaixo.
  }
  await supabase.auth.signOut({ scope: "global" });

  // #3696: vale para todas as sessões da pessoa — por isso a invalidação é por
  // IDENTIDADE, e não só pela sessão que clicou.
  if (user) invalidarUsuario(user.id);
  if (sessao) invalidarSessao(sessao.chave);

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

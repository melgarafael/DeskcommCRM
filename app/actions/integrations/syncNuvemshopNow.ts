"use server";

/**
 * "Sincronizar agora": inicia um run manual. Só quem administra a empresa;
 * sessão de suporte somente-leitura é recusada antes do efeito.
 */
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { podeAdministrarEmpresa } from "@/lib/auth/pode-administrar-empresa";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { supportWriteError } from "@/lib/impersonate/support";
import { depsReais } from "@/lib/nuvemshop/sync/deps";
import { iniciarSincronizacao, type ResultadoDoInicio } from "@/lib/nuvemshop/sync/iniciar";

export type SyncNowResult =
  | { ok: true }
  | { ok: false; error: "auth_required" | "no_active_org" | "forbidden" | Extract<ResultadoDoInicio, { ok: false }>["motivo"] };

export async function syncNuvemshopNow(): Promise<SyncNowResult> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "auth_required" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden" };
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return { ok: false, error: "no_active_org" };
  if (!podeAdministrarEmpresa(user, activeOrg)) return { ok: false, error: "forbidden" };

  const r = await iniciarSincronizacao(depsReais(), activeOrg.orgId, "manual");
  if (!r.ok) return { ok: false, error: r.motivo };

  await audit({
    action: "nuvemshop.sync_requested",
    organizationId: activeOrg.orgId,
    actorUserId: user.id,
    metadata: { origem: "manual", run_id: r.runId },
  });
  revalidatePath("/app/integrations/nuvemshop");
  return { ok: true };
}

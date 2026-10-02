"use server";

import { revalidatePath } from "next/cache";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { normalizarUtm } from "@/lib/leads/origem-do-site";
import { linkSchema, type LinkInput } from "@/lib/plataformas-de-anuncio/rastreio/contrato";
import { createAdminClient } from "@/lib/supabase/admin";

export async function salvarLinkRastreavel(
  input: LinkInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: "Confira o nome, o telefone internacional e a mensagem." };
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "Entre novamente para salvar." };
  if (supportWriteError(user.support))
    return { ok: false, error: "Esta sessão de suporte não permite alterações." };
  const org = await resolveActiveOrg(user);
  if (!org || (!(escreveComoPlatformAdmin(user) && !user.support) && ROLE_RANK[org.role] < ROLE_RANK.admin))
    return { ok: false, error: "Somente administradores podem alterar os links." };
  if (await mfaEmDivida()) return { ok: false, error: "Confirme a verificação em duas etapas." };
  const { id, ...fields } = parsed.data;
  const row = { ...fields, utm: normalizarUtm(fields.utm), organization_id: org.orgId };
  const admin = createAdminClient();
  const query = id
    ? admin.from("ad_tracking_links").update(row).eq("organization_id", org.orgId).eq("id", id)
    : admin.from("ad_tracking_links").insert(row);
  const { data, error } = await query.select("id").maybeSingle();
  if (error || !data)
    return {
      ok: false,
      error: "Não foi possível salvar este link. Atualize a página e tente novamente.",
    };
  await audit({
    action: "ad_tracking_link.saved",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "ad_tracking_links",
    resourceId: data.id,
    metadata: { enabled: row.enabled, use_case: row.use_case },
  });
  revalidatePath("/app/settings/conversoes");
  return { ok: true, id: data.id };
}

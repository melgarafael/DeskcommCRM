import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { FaturamentoClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * FATURAMENTO — o relatório de pedidos faturados com NF, no molde do Mercos.
 * Sem sidebar de propósito (doutrina da dobra): a porta é o ⌘K e o link do
 * Indicadores.
 */
export default async function FaturamentoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const supabase = await createClient();
  const { data: membros } = await supabase
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", activeOrg.orgId)
    .is("revoked_at", null)
    .neq("role", "viewer")
    .limit(50);

  const nomes: Record<string, string> = {};
  const ids = ((membros ?? []) as unknown as { user_id: string }[]).map((m) => m.user_id);
  if (isServiceRoleConfigured() && ids.length > 0) {
    const admin = createAdminClient();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const { data: userRes } = await admin.auth.admin.getUserById(id);
          const nome = userRes?.user?.user_metadata?.full_name as string | undefined;
          if (nome?.trim()) nomes[id] = nome.trim();
        } catch {
          // Nome é cortesia; o id curto cobre.
        }
      }),
    );
  }

  return <FaturamentoClient nomesVendedores={nomes} />;
}

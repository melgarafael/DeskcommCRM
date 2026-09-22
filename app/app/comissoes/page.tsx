import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { isServiceRoleConfigured } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { ComissoesClient } from "./_client";

export const dynamic = "force-dynamic";

const ANO_MES = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/**
 * COMISSÕES — o "quanto cada vendedor leva" no mês, com Dar Baixa.
 *
 * Espelha o relatório de Comissões do Mercos (data, pedido, cliente,
 * parcela/valor, % e valor da comissão, baixa). O cálculo mora na API
 * (`GET /api/v1/commissions`); a tela filtra por mês/vendedor e registra a
 * baixa (manager+). Sem a baixa persistida, pago/não-pago seria planilha.
 */
export default async function ComissoesPage({
  searchParams,
}: {
  searchParams: Promise<{ mes?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const params = await searchParams;

  const agora = new Date().toISOString().slice(0, 7);
  const mes = ANO_MES.test(params.mes ?? "") ? (params.mes as string) : agora;
  const podeDarBaixa = user.is_platform_admin || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

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

  return <ComissoesClient mes={mes} nomesVendedores={nomes} podeDarBaixa={podeDarBaixa} />;
}

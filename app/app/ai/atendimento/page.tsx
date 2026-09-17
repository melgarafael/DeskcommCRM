import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import { FlowsList } from "../followups/_components/FlowsList";
import { ComoUsar } from "./_components/ComoUsar";

export const dynamic = "force-dynamic";

const FLOW_COLUMNS = "id, name, status, active_version_id, handoff_policy, updated_at";

/**
 * Tela dos fluxos de ATENDIMENTO (superfície `atendimento`). Diferente dos
 * Follow-ups (retomada, disparada por relógio), estes fluxos conduzem perguntas
 * durante a conversa. Reusa o mesmo editor/lista, recortado por superfície.
 */
export default async function AtendimentoFlowsPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const supabase = await createClient();
  const { data } = await supabase
    .from("followup_flow_pointers")
    .select(FLOW_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .eq("surface", "atendimento")
    .order("updated_at", { ascending: false });

  const flows = (data ?? []) as unknown as FollowupFlowPointerRow[];
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Fluxos de atendimento")}</h1>
          <p className="text-sm text-text-muted">
            {t(
              "Perguntas que a IA faz durante a conversa, em ordem, e o que fazer ao concluir — os dados ficam guardados por cliente.",
            )}
          </p>
        </div>
      </header>
      <ComoUsar t={t} />
      <FlowsList initialData={flows} canWrite={canWrite} surface="atendimento" />
    </div>
  );
}

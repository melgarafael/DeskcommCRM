import type { Metadata } from "next";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { createClient } from "@/lib/supabase/server";

import { MetricsClient } from "./_components/MetricsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Desempenho" };

export default async function MetricsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  const canRead = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  // spec 13 §6.1: agent vê as próprias (RLS); a comparação por atendente é manager+.
  const canCompare = !!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  // Os funis do seletor de recorte dos ganhos (#4918) — lidos AQUI, com o
  // client de sessão, pelo mesmo motivo do Kanban: `GET /api/v1/pipelines`
  // exige manager+ e esta tela é aberta a qualquer papel. `is_archived` NÃO
  // corta a lista: ganho de funil arquivado continua sendo ganho do período, e
  // esconder o funil esconderia justamente o número que se quer explicar.
  const supabase = await createClient();
  const { data: funisDaOrg } = canRead && activeOrg
    ? await supabase
        .from("crm_pipelines")
        .select("id, name")
        .eq("organization_id", activeOrg.orgId)
        .order("position")
    : { data: [] };
  const funis = (funisDaOrg ?? []) as Array<{ id: string; name: string }>;

  return (
    <div className="flex h-full flex-col gap-6 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Desempenho")}</h1>
        <p className="text-sm text-muted-foreground">
          {canCompare
            ? t("Atrito, funil e desempenho por atendente.")
            : t("Atrito, seu funil e seu desempenho.")}
        </p>
      </header>

      {canRead ? (
        <MetricsClient
          canCompare={canCompare}
          currentUserId={user.id}
          fuso={fusoUtilizavel(activeOrg.timezone)}
          funis={funis}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Você não tem permissão para consultar as métricas de desempenho.")}
        </p>
      )}
    </div>
  );
}

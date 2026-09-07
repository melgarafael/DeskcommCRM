import { NextResponse, type NextRequest } from "next/server";
import { googlePushCandidates } from "@/lib/agenda/google/candidates";
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { reconcileAppointment } from "@/lib/agenda/google/sync-executor";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
async function executar(req: NextRequest) {
  if (
    ![env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET]
      .filter(Boolean)
      .some((s) => req.headers.get("authorization") === `Bearer ${s}`)
  )
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  const db = createAdminClient();
  const { data, error } = await googlePushCandidates(db);
  if (error)
    return NextResponse.json(
      { error: { code: "internal_error", message: "Não foi possível ler a pendência Google." } },
      { status: 500 },
    );
  const effects = new Map<string, { processados: number; falhas: number }>();
  const active = await apenasDeMembrosAtivos(db, data ?? []);
  for (const item of active) {
    let result: string;
    try {
      result = await reconcileAppointment(db, item.organization_id, item.id);
    } catch {
      result = "failed";
    }
    if (result === "busy" || result === "unchanged" || result === "terminal") continue;
    const summary = effects.get(item.organization_id) ?? { processados: 0, falhas: 0 };
    if (result === "processed") summary.processados++;
    else summary.falhas++;
    effects.set(item.organization_id, summary);
  }
  for (const [organizationId, summary] of effects) {
    if (summary.processados > 0 || summary.falhas > 0)
      await audit({
        action: "agenda.google.sync_executado",
        organizationId,
        metadata: { direcao: "ida", ...summary },
      });
  }
  return NextResponse.json({ data: { candidatos: data?.length ?? 0, organizacoes: effects.size } });
}
export const GET = executar;
export const POST = executar;

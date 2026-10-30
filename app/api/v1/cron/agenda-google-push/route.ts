import { NextResponse, type NextRequest } from "next/server";
import { googlePushCandidates } from "@/lib/agenda/google/candidates";
import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { reconcileAppointment } from "@/lib/agenda/google/sync-executor";
import { ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
export const dynamic = "force-dynamic";
async function executar(req: NextRequest) {
  if (!autorizaCron(req))
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "cron secret inválido" } },
      { status: 401 },
    );
  // O PISO OCIOSO (#3731): sem compromisso que `googlePushCandidates` pegaria
  // (o mesmo `or`, sem filtro de status da conexão — a rota também não tem), a
  // leitura de pendências volta vazia em toda instalação que nunca usou a agenda
  // Google. Sai antes dela, pelo retrato em memória. Conexão que precisa de
  // atenção NÃO faz pular: o compromisso dela ainda recebe o aviso do executor.
  if (await recursoOcioso("agenda_google_push")) return ok({ pulado: "recurso_ocioso" });
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

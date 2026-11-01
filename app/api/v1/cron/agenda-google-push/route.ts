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

/**
 * O QUE RODA DEPOIS DO PORTÃO DO PISO OCIOSO (#3773), na ordem do arquivo.
 *
 * O `if (await recursoOcioso(...))` desta rota é saída antecipada da ROTA
 * INTEIRA: o que vier depois dele não roda em instalação ociosa. Esta lista é a
 * declaração do que roda ali — `tests/unit/cron-passa-pelo-portao.test.ts` lê o
 * AST deste arquivo e reprova, com arquivo e linha, quando o que está de fato
 * abaixo do portão divergir dela. Passo novo abaixo do portão entra aqui, e só
 * depois de a pessoa ver que ele NÃO roda na instalação parada, que é o caso
 * comum. O #3650 mediu o custo de não haver essa cerca: três passos novos na
 * `historico-import` ficaram fora do sinal do portão e o autor teve de alargá-lo
 * à mão.
 *
 * Em runtime a constante não serve para nada — o `void` existe só para o lint
 * não acusar variável sem uso.
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const db",
  "const {data, error}",
  "if (error)",
  "const effects",
  "const active",
  "for (item of active)",
  "for ([organizationId, summary] of effects)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

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

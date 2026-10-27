import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { avisarLembretesDeReuniao } from "@/lib/agencia/calendario/lembretes";
import { copiarEnviosPendentes } from "@/lib/agencia/envios/copia";
import { publicarAgendadas } from "@/lib/agencia/publicacoes/motor";
import { avisarPrazos } from "@/lib/agencia/tarefas/relogios";
import { avisarPrazosDaTrilha } from "@/lib/agencia/trilhas/relogio";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Avisa os prazos das tarefas da agência (docs/agencia/SPEC-tarefas.md, T8): nos
 * dias de antecedência configurados, no dia e no atraso, cada marco uma vez.
 * A cada 15 min, pelo `scheduler`. Rodada que não avisou ninguém não audita.
 *
 * O mesmo relógio manda os lembretes das reuniões (SPEC-calendario, K7) — sem
 * cron novo, para o agendador não precisar ser reconstruído — e o relógio da
 * trilha do cliente (SPEC-trilhas, R10), pelo mesmo motivo. E publica as
 * publicações agendadas com "publicar sozinho" (SPEC-publicacoes, P6).
 */
async function handle(req: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Credencial de execução inválida.", 403, { requestId });
  try {
    const r = await avisarPrazos();
    if (r.avisados > 0) {
      void audit({ action: "agencia.avisos_de_prazo_enviados", organizationId: null, metadata: { avisados: r.avisados }, requestId });
    }
    const l = await avisarLembretesDeReuniao();
    if (l.lembrados > 0) {
      void audit({ action: "agencia.lembretes_de_reuniao_enviados", organizationId: null, metadata: { lembrados: l.lembrados }, requestId });
    }
    const t = await avisarPrazosDaTrilha();
    if (t.avisados > 0) {
      void audit({ action: "agencia.avisos_de_trilha_enviados", organizationId: null, metadata: { avisados: t.avisados }, requestId });
    }
    const p = await publicarAgendadas();
    if (p.publicadas + p.falharam > 0) {
      void audit({ action: "agencia.publicacoes_publicadas", organizationId: null, metadata: { ...p }, requestId });
    }
    // SPEC-envios, E6: termina as cópias para o Drive que a resposta do cliente começou.
    // 35 s: o agendador espera 60 s por esta rota; a cópia longa roda logo depois da aprovação.
    const c = await copiarEnviosPendentes(35_000);
    if (c.copiados > 0) {
      void audit({ action: "agencia.envios_copiados", organizationId: null, metadata: { ...c }, requestId });
    }
    return ok({ ...r, ...l, trilha: t.avisados, ...p, envios: c }, { requestId });
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    logger.error("[agencia-prazos.cron] falhou", { error: detalhe, requestId });
    return fail("internal_error", detalhe, 500, { requestId });
  }
}
export const GET = handle;
export const POST = handle;

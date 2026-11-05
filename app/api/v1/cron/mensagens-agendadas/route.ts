/**
 * O CRON DAS MENSAGENS AGENDADAS — envia as ocorrências vencidas.
 *
 * Roda por minuto. Para cada série com `scheduled_at` no passado:
 *   1. CLAIM: marca `claimed_until` com UPDATE condicional. Só quem marcar a linha
 *      processa; duas execuções simultâneas não enviam a mesma ocorrência.
 *   2. número WORKING → envia e grava o desfecho.
 *   3. número fora do ar + `esperar` → solta a trava e tenta no próximo minuto.
 *   4. número fora do ar + `cancelar` → registra `pulada_desconectado`.
 *   5. desfecho final → avança `scheduled_at` para a próxima ocorrência depois de
 *      AGORA (sem rajada) ou conclui a série.
 *
 * Auditoria só quando a ocorrência teve desfecho gravado (regra do cron).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { proximaOcorrenciaDepois, type RegraDeRecorrencia } from "@/lib/agendamento-mensagem/recorrencia";
import { enviarOcorrencia, sessaoEstaConectada, type AgendamentoParaEnvio, type DesfechoDoEnvio } from "@/lib/agendamento-mensagem/envio";

export const dynamic = "force-dynamic";

const LOTE = 50;
const TRAVA_S = 300;

interface LinhaDevida extends AgendamentoParaEnvio {
  recorrencia: string;
  intervalo_dias: number | null;
  inicio_local: string;
  termino_local: string | null;
  tz: string;
  scheduled_at: string;
  se_desconectado: "esperar" | "cancelar";
  ultimo_envio_em: string | null;
  ultimo_erro: string | null;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });

  const admin = createAdminClient();
  const agora = new Date();
  const { data: candidatas, error } = await admin
    .from("mensagens_agendadas")
    .select("*")
    .eq("status", "agendada")
    .lte("scheduled_at", agora.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(LOTE);
  if (error) return fail("internal_error", "Erro ao ler as mensagens devidas.", 500, { requestId });

  const paradas = new Set(await idsDeOrgsParadas(admin));
  const resumo = { processadas: 0, enviadas: 0, falhas: 0, puladas: 0, esperando: 0 };

  for (const candidata of (candidatas ?? []) as LinhaDevida[]) {
    if (paradas.has(candidata.organization_id)) continue;
    // 1. CLAIM: só processa quem conseguir marcar a trava agora.
    const trava = new Date(agora.getTime() + TRAVA_S * 1000).toISOString();
    const { data: reservada } = await admin
      .from("mensagens_agendadas")
      .update({ claimed_until: trava })
      .eq("id", candidata.id)
      .eq("status", "agendada")
      .or(`claimed_until.is.null,claimed_until.lt.${agora.toISOString()}`)
      .select("*");
    const ag = (reservada?.[0] ?? null) as LinhaDevida | null;
    if (!ag) continue;
    resumo.processadas++;

    const previstaPara = new Date(ag.scheduled_at);
    const conectado = await sessaoEstaConectada(admin, ag.organization_id, ag.channel_session_id);

    // 3. Fora do ar + esperar: solta a trava e tenta no próximo minuto.
    if (!conectado && ag.se_desconectado === "esperar") {
      await admin.from("mensagens_agendadas").update({ claimed_until: null }).eq("id", ag.id);
      resumo.esperando++;
      continue;
    }

    const desfecho: DesfechoDoEnvio = conectado
      ? await enviarOcorrencia(admin, ag, previstaPara)
      : { desfecho: "pulada_desconectado" };

    await admin.from("mensagens_agendadas_envios").insert({
      organization_id: ag.organization_id,
      agendamento_id: ag.id,
      prevista_para: ag.scheduled_at,
      desfecho: desfecho.desfecho,
      message_id: desfecho.desfecho === "enviada" ? desfecho.message_id : null,
      erro: desfecho.desfecho === "falhou" ? desfecho.erro : null,
    });

    const enviou = desfecho.desfecho === "enviada";
    const falhou = desfecho.desfecho === "falhou";

    // 5. Desfecho final desta ocorrência: avança a série sem rajada.
    const regra: RegraDeRecorrencia = {
      recorrencia: ag.recorrencia as RegraDeRecorrencia["recorrencia"],
      intervalo_dias: ag.intervalo_dias,
      inicio: ag.inicio_local,
      termino: ag.termino_local,
      tz: ag.tz,
    };
    const proxima = proximaOcorrenciaDepois(regra, new Date(Math.max(previstaPara.getTime(), agora.getTime())));
    const { error: upErr } = await admin
      .from("mensagens_agendadas")
      .update({
        scheduled_at: proxima ? proxima.toISOString() : ag.scheduled_at,
        status: proxima ? "agendada" : "concluida",
        claimed_until: null,
        ultimo_envio_em: enviou ? agora.toISOString() : ag.ultimo_envio_em,
        ultimo_erro: falhou ? desfecho.erro : enviou ? null : ag.ultimo_erro,
        updated_at: agora.toISOString(),
      })
      .eq("id", ag.id)
      .eq("organization_id", ag.organization_id);
    if (upErr) continue;

    if (enviou) resumo.enviadas++;
    else if (falhou) resumo.falhas++;
    else resumo.puladas++;

    // Auditoria só quando a ocorrência teve desfecho gravado (regra do cron: sem efeito, sem linha).
    if (enviou || falhou || desfecho.desfecho === "pulada_desconectado") {
      void audit({
        action: enviou ? "scheduled_message.sent" : falhou ? "scheduled_message.failed" : "scheduled_message.skipped",
        organizationId: ag.organization_id,
        actorUserId: null,
        resourceType: "mensagens_agendadas",
        resourceId: ag.id,
        requestId,
        metadata: { previsto_para: ag.scheduled_at, desfecho: desfecho.desfecho },
      });
    }
  }

  return ok(resumo, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

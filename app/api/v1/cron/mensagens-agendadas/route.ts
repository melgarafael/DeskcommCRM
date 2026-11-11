/**
 * O CRON DAS MENSAGENS AGENDADAS — encaminha ao envio as que venceram.
 *
 * Roda por minuto. Para cada agendamento com `scheduled_at` no passado:
 *   1. CLAIM: marca `claimed_until` com UPDATE condicional. Só quem marcar a linha
 *      processa; duas rodadas simultâneas não encaminham o mesmo envio.
 *   2. quem agendou perdeu o acesso → `cancelada` (`sem_acesso`).
 *   3. número fora do ar + `esperar` → solta a trava e tenta no próximo minuto.
 *   4. número fora do ar + `cancelar` → `cancelada` (`numero_desconectado`).
 *   5. número no ar → encaminha; `encaminhada` com o `message_id`, ou `falhou`.
 *
 * Primeira parte da #3118: envio único. Não há próxima ocorrência.
 * Auditoria só quando o agendamento teve desfecho gravado (regra do cron).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  autorAindaTemAcesso,
  encaminharAgendamento,
  sessaoEstaConectada,
  type AgendamentoParaEnvio,
} from "@/lib/agendamento-mensagem/envio";

export const dynamic = "force-dynamic";

const LOTE = 50;
const COLUNAS = "id, organization_id, contact_id, channel_session_id, created_by_user_id, body, scheduled_at, se_desconectado";
const TRAVA_S = 300;

interface LinhaDevida extends AgendamentoParaEnvio {
  scheduled_at: string;
  se_desconectado: "esperar" | "cancelar";
}

type Final =
  | { status: "encaminhada"; message_id: string }
  | { status: "falhou" | "cancelada"; motivo: string };

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });

  const admin = createAdminClient();
  const agora = new Date();
  const { data: candidatas, error } = await admin
    .from("mensagens_agendadas")
    .select("id, organization_id")
    .eq("status", "agendada")
    .lte("scheduled_at", agora.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(LOTE);
  if (error) return fail("internal_error", "Erro ao ler as mensagens devidas.", 500, { requestId });

  const paradas = new Set(await idsDeOrgsParadas(admin));
  const resumo = { processadas: 0, encaminhadas: 0, falhas: 0, canceladas: 0, esperando: 0 };

  const soltar = (id: string) => admin.from("mensagens_agendadas").update({ claimed_until: null }).eq("id", id);

  for (const candidata of candidatas ?? []) {
    if (paradas.has(candidata.organization_id)) continue;
    const trava = new Date(agora.getTime() + TRAVA_S * 1000).toISOString();
    const { data: reservada } = await admin
      .from("mensagens_agendadas")
      .update({ claimed_until: trava })
      .eq("id", candidata.id)
      .eq("status", "agendada")
      .or(`claimed_until.is.null,claimed_until.lt.${agora.toISOString()}`)
      .select(COLUNAS);
    // As colunas vêm do CLAIM, não da leitura da fila: uma edição feita entre as
    // duas não pode sair com o texto antigo.
    const ag = (reservada?.[0] ?? null) as LinhaDevida | null;
    if (!ag) continue;
    resumo.processadas++;

    let final: Final;
    if (!(await autorAindaTemAcesso(admin, ag))) {
      final = { status: "cancelada", motivo: "sem_acesso" };
    } else if (!(await sessaoEstaConectada(admin, ag.organization_id, ag.channel_session_id))) {
      if (ag.se_desconectado === "esperar") {
        await soltar(ag.id);
        resumo.esperando++;
        continue;
      }
      final = { status: "cancelada", motivo: "numero_desconectado" };
    } else {
      const desfecho = await encaminharAgendamento(admin, ag);
      // Org parada no meio do envio: não grava desfecho. O agendamento fica como
      // estava e a rota volta a ele quando a org for operante de novo.
      if (desfecho.desfecho === "org_parada") {
        await soltar(ag.id);
        continue;
      }
      final =
        desfecho.desfecho === "encaminhada"
          ? { status: "encaminhada", message_id: desfecho.message_id }
          : { status: "falhou", motivo: desfecho.motivo };
    }

    const { error: upErr } = await admin
      .from("mensagens_agendadas")
      .update({
        status: final.status,
        message_id: final.status === "encaminhada" ? final.message_id : null,
        motivo: final.status === "encaminhada" ? null : final.motivo,
        claimed_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", ag.id)
      .eq("organization_id", ag.organization_id)
      .eq("status", "agendada");
    // Auditoria só quando o desfecho foi gravado (regra do cron: sem efeito, sem linha).
    if (!upErr) {
      if (final.status === "encaminhada") resumo.encaminhadas++;
      else if (final.status === "falhou") resumo.falhas++;
      else resumo.canceladas++;

      void audit({
        action:
          final.status === "encaminhada"
            ? "scheduled_message.dispatched"
            : final.status === "falhou"
              ? "scheduled_message.failed"
              : "scheduled_message.cancelled",
        organizationId: ag.organization_id,
        actorUserId: null,
        resourceType: "mensagens_agendadas",
        resourceId: ag.id,
        requestId,
        metadata: { previsto_para: ag.scheduled_at, status: final.status, ...(final.status === "encaminhada" ? {} : { motivo: final.motivo }) },
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

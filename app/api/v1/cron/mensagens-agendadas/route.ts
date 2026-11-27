/**
 * O CRON DAS MENSAGENS AGENDADAS — encaminha ao envio as que venceram.
 *
 * Roda por minuto. Para cada agendamento com `scheduled_at` no passado:
 *   1. CLAIM: marca `claimed_until` com UPDATE condicional. Só quem marcar a linha
 *      processa; duas rodadas simultâneas não encaminham o mesmo envio.
 *   2. quem agendou perdeu o acesso → `cancelada` (`sem_acesso`).
 *   3. escolhe a conversa CONECTADA mais recente do contato (sessao-do-contato.ts).
 *      Se a conexão da conversa caiu e o número foi lido de novo, o envio sai pela
 *      nova, e o agendamento passa a apontar para ela.
 *   4. sem conversa conectada: série e envio com `esperar` → solta a trava e tenta no
 *      próximo minuto (carimbando `updated_at`, para a linha recém-solta ir ao FIM da
 *      fila); envio único com `cancelar` → `cancelada` (`numero_desconectado`).
 *      Série nunca cancela por desconexão.
 *   5. encaminha; `encaminhada` com o `message_id`, ou `falhou`.
 *
 * ── Por que a fila ordena por `updated_at` e não só por `scheduled_at` (#5060)
 *
 * Uma linha em `esperar` volta a ser `agendada` a cada rodada. Ordenada apenas
 * pelo horário, ela mantém a posição mais antiga e ocupa a vaga das 50 de novo,
 * rodada após rodada: 50 presas numa sessão caída travam o lote e uma mensagem
 * devida mais nova nunca é lida. `updated_at` é a marca de "última tentativa":
 * quem acabou de ser solto é o mais recente e cede a vez, então o lote ROTACIONA
 * e sempre sobra vaga para quem ainda não foi encostado. O lote continua 50, a
 * política `esperar` continua `esperar` e a linha presa continua `agendada`.
 *
 * Segunda parte da #3118 (repetição): a linha é a SÉRIE. Ao fim de cada ocorrência,
 * a regra de `lib/agendamento-mensagem/serie.ts` decide se a série segue para a
 * próxima (`scheduled_at` avança e o status volta a `agendada`) ou termina. Cada
 * ocorrência de série grava uma linha em `mensagens_agendadas_envios`. Envio único
 * (`recorrencia = 'nenhuma'`) segue como antes: uma linha, um desfecho.
 * Auditoria só quando o agendamento teve desfecho gravado (regra do cron).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ehOperante, STATUS_OPERANTE, statusDaOrgEmbutida } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  autorAindaTemAcesso,
  encaminharAgendamento,
  type AgendamentoParaEnvio,
} from "@/lib/agendamento-mensagem/envio";
import { resolverConversaConectada } from "@/lib/agendamento-mensagem/sessao-do-contato";
import { proximoDaSerie } from "@/lib/agendamento-mensagem/serie";
import type { RegraDeRecorrencia } from "@/lib/agendamento-mensagem/recorrencia";

export const dynamic = "force-dynamic";

const LOTE = 50;
const COLUNAS =
  "id, organization_id, conversation_id, contact_id, channel_session_id, created_by_user_id, body, scheduled_at, se_desconectado, recorrencia, intervalo_dias, inicio_local, termino_local, tz";
const TRAVA_S = 300;

interface LinhaDevida extends AgendamentoParaEnvio {
  conversation_id: string;
  scheduled_at: string;
  se_desconectado: "esperar" | "cancelar";
  recorrencia: RegraDeRecorrencia["recorrencia"];
  intervalo_dias: number | null;
  inicio_local: string | null;
  termino_local: string | null;
  tz: string;
}

/** A regra da linha, para a régua de `serie.ts`. Só faz sentido com série (recorrência ≠ nenhuma). */
function regraDaLinha(ag: LinhaDevida): RegraDeRecorrencia {
  return {
    recorrencia: ag.recorrencia,
    intervalo_dias: ag.intervalo_dias,
    inicio: ag.inicio_local ?? "",
    termino: ag.termino_local,
    tz: ag.tz,
  };
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
    .select("id, organizations:organization_id!inner(status)")
    .eq("status", "agendada")
    // Exclude paused organizations before applying the batch limit.
    .eq("organizations.status", STATUS_OPERANTE)
    .lte("scheduled_at", agora.toISOString())
    // Menos recentemente tentada primeiro: a linha que acabou de ser solta
    // (updated_at = agora) vai para o fim e cede a vaga a quem ainda não foi
    // encostado. `scheduled_at` desempata as nunca tentadas na ordem devida.
    .order("updated_at", { ascending: true })
    .order("scheduled_at", { ascending: true })
    .limit(LOTE);
  if (error) return fail("internal_error", "Erro ao ler as mensagens devidas.", 500, { requestId });

  const resumo = { processadas: 0, encaminhadas: 0, falhas: 0, canceladas: 0, esperando: 0 };

  // Soltar = devolver ao lote E registrar a tentativa: sem o carimbo, a linha
  // reordenada continuaria sendo a mais antiga e voltaria a travar as 50 vagas.
  const soltar = (id: string) =>
    admin
      .from("mensagens_agendadas")
      .update({ claimed_until: null, updated_at: new Date().toISOString() })
      .eq("id", id);

  for (const candidata of candidatas ?? []) {
    if (!ehOperante(statusDaOrgEmbutida(candidata.organizations))) continue;
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
    let ag = (reservada?.[0] ?? null) as LinhaDevida | null;
    if (!ag) continue;
    resumo.processadas++;

    // Série: a régua decide se segue para a próxima ocorrência. Envio único: não há próxima.
    // Sem recorrência gravada (ou "nenhuma") é envio único: nunca série por engano.
    const serie = Boolean(ag.recorrencia) && ag.recorrencia !== "nenhuma";

    let final: Final;
    if (!(await autorAindaTemAcesso(admin, ag))) {
      final = { status: "cancelada", motivo: "sem_acesso" };
    } else {
      // A conversa de envio é a MAIS RECENTE do contato cuja sessão está conectada e
      // tem o MESMO número da conexão original. Se a conexão caiu e o número foi lido
      // de novo por QR, a conversa antiga fica numa sessão parada, e o envio sai pela
      // nova sem apagar nada. Outro número da empresa não serve.
      const escolha = await resolverConversaConectada(admin, ag.organization_id, ag.contact_id, ag.channel_session_id);
      if (!escolha) {
        // Sem conexão com o mesmo número: a escolha de quem agendou decide. "Esperar"
        // espera a reconexão, em série e em envio único. "Cancelar" pula esta ocorrência;
        // na série, a próxima data segue agendada.
        if (ag.se_desconectado === "esperar") {
          await soltar(ag.id);
          resumo.esperando++;
          continue;
        }
        final = { status: "cancelada", motivo: "numero_desconectado" };
      } else {
        if (escolha.conversation_id !== ag.conversation_id || escolha.channel_session_id !== ag.channel_session_id) {
          const { error: troca } = await admin
            .from("mensagens_agendadas")
            .update({ conversation_id: escolha.conversation_id, channel_session_id: escolha.channel_session_id })
            .eq("id", ag.id)
            .eq("organization_id", ag.organization_id)
            .eq("status", "agendada");
          if (troca) {
            await soltar(ag.id);
            continue;
          }
          ag = { ...ag, conversation_id: escolha.conversation_id, channel_session_id: escolha.channel_session_id };
        }
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
    }

    const motivoDaOcorrencia = final.status === "encaminhada" ? null : final.motivo;
    const proximo = serie
      ? proximoDaSerie(regraDaLinha(ag), agora, { status: final.status, motivo: motivoDaOcorrencia })
      : null;
    const agoraIso = new Date().toISOString();

    const { error: upErr } = await admin
      .from("mensagens_agendadas")
      .update(
        proximo !== null
          ? {
              scheduled_at: proximo,
              status: "agendada",
              message_id: null,
              motivo: null,
              claimed_until: null,
              updated_at: agoraIso,
            }
          : {
              status: final.status,
              message_id: final.status === "encaminhada" ? final.message_id : null,
              motivo: motivoDaOcorrencia,
              claimed_until: null,
              updated_at: agoraIso,
            },
      )
      .eq("id", ag.id)
      .eq("organization_id", ag.organization_id)
      .eq("status", "agendada");

    // Cada ocorrência de série fica no histórico, com o desfecho dela. Só depois de a
    // linha ter avançado: sem avanço, não há ocorrência a registrar.
    if (!upErr && serie) {
      const { error: histErr } = await admin.from("mensagens_agendadas_envios").insert({
        organization_id: ag.organization_id,
        agendamento_id: ag.id,
        conversation_id: ag.conversation_id,
        prevista_para: ag.scheduled_at,
        status: final.status,
        motivo: motivoDaOcorrencia,
        message_id: final.status === "encaminhada" ? final.message_id : null,
      });
      // 23505: outra rodada já registrou esta ocorrência (envio que passou da trava). Nada a fazer.
      if (histErr && histErr.code !== "23505") logger.error("[mensagens-agendadas] ocorrência não gravada no histórico", { agendamento: ag.id, erro: histErr.message });
    }

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

/**
 * Envia ao gestor (via mesmo canal e destino do aviso de agendamento) o link
 * do Google Meet assim que ele é gerado, junto com um resumo curto da demanda.
 *
 * Regras:
 * - Reutiliza `createSupabaseAvisoDeAgendamentoDb` e `criarTransporteDoAviso`
 *   (mesma fonte de configuração, destino e transporte de `aviso-de-agendamento`).
 * - Falha aberta: qualquer erro aqui apenas registra `warn` no log e nunca
 *   bloqueia ou reverte a entrega ao cliente em `meet-delivery.ts`.
 * - Multi-tenant: toda consulta filtra explicitamente `organization_id`.
 */
import type pg from "pg";
import type { Logger } from "../obs/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseAvisoDb } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import { primeiroNome } from "@/lib/escalacao/texto-do-aviso";
import { createSupabaseAvisoDeAgendamentoDb } from "@/lib/agenda/aviso-de-agendamento";
import { diaEHora } from "@/lib/agenda/texto-do-aviso-de-agendamento";
import { normalizarIdioma } from "@/lib/i18n/idiomas";

const MAX_MENSAGENS_RESUMO = 3;
const MAX_CHARS_POR_MENSAGEM = 120;
const MAX_CHARS_RESUMO = 320;

export interface ParamsNotificarGestorMeet {
  pool: pg.Pool;
  organizationId: string;
  appointmentId: string;
  conversationId: string;
  contactId: string;
  startsAt: string;
  timeZone: string;
  url: string;
  log: Logger;
}

function truncarTexto(texto: string, limite: number): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length <= limite) return limpo;
  return `${limpo.slice(0, Math.max(0, limite - 1))}…`;
}

export function montarMensagemGestorMeet(params: {
  primeiroNomeCliente: string | null;
  titulo: string | null;
  quando: string;
  url: string;
  resumoDemanda: string | null;
}): string {
  const linhas = [
    "🔗 *Link do Google Meet pronto*",
    `*Cliente:* ${params.primeiroNomeCliente || "Não informado"}`,
    `*Reunião:* ${(params.titulo ?? "").trim() || "Atendimento"} (${params.quando})`,
    `*Link:* ${params.url}`,
  ];
  if (params.resumoDemanda) {
    linhas.push(`*Resumo da demanda:* ${params.resumoDemanda}`);
  }
  return linhas.join("\n");
}

export async function notificarGestorLinkMeet(params: ParamsNotificarGestorMeet): Promise<void> {
  try {
    const admin = createAdminClient();
    const avisoDb = createSupabaseAvisoDeAgendamentoDb(admin, createSupabaseAvisoDb(admin));
    const cfg = await avisoDb.carregaConfig(params.organizationId);
    if (!cfg || !cfg.ligado || !cfg.channel_session_id) return;

    const destinos = [cfg.telefone_destino, cfg.grupo_destino]
      .map((d) => (typeof d === "string" ? d.trim() : ""))
      .filter(Boolean);
    if (destinos.length === 0) return;

    const [canal, marca, fuso, agendamento, nomeCompleto, msgsRes] = await Promise.all([
      avisoDb.carregaCanal(params.organizationId, cfg.channel_session_id),
      avisoDb.marcaDaOrganizacao(params.organizationId),
      avisoDb.fusoDaOrganizacao(params.organizationId),
      avisoDb.carregaAgendamento(params.organizationId, params.appointmentId),
      avisoDb.nomeDoContato(params.organizationId, params.contactId),
      params.pool.query<{ body: string | null }>(
        `select body
           from messages
          where organization_id = $1
            and conversation_id = $2
            and direction = 'inbound'
            and private = false
            and body is not null
          order by created_at desc
          limit $3`,
        [params.organizationId, params.conversationId, MAX_MENSAGENS_RESUMO],
      ),
    ]);

    if (!canal || canal.archived_at) return;

    const falas = [...msgsRes.rows]
      .reverse()
      .map((r) => truncarTexto(r.body ?? "", MAX_CHARS_POR_MENSAGEM))
      .filter(Boolean);
    const resumoDemanda = falas.length > 0 ? truncarTexto(falas.join(" | "), MAX_CHARS_RESUMO) : null;

    const quando = diaEHora(
      new Date(params.startsAt),
      fuso || params.timeZone || "America/Sao_Paulo",
      normalizarIdioma(marca.idioma),
    );
    const corpo = montarMensagemGestorMeet({
      primeiroNomeCliente: primeiroNome(nomeCompleto),
      titulo: agendamento?.title ?? null,
      quando,
      url: params.url,
      resumoDemanda,
    });

    const transporte = await criarTransporteDoAviso(admin);
    for (const destino of destinos) {
      if (await avisoDb.destinoEhDaPropriaOrganizacao(params.organizationId, destino)) continue;
      const to = await transporte.resolveDestino(params.organizationId, canal, destino);
      if (!to) continue;
      await transporte.envia(params.organizationId, canal, to, corpo);
    }
  } catch (err) {
    params.log.warn("meet_delivery_manager_notify_failed", {
      organization_id: params.organizationId,
      appointment_id: params.appointmentId,
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    });
  }
}

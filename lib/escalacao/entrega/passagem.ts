import { createHash } from "node:crypto";
import type { PacingDoAviso, TransporteDoAviso, CanalDoAviso } from "../aviso-ao-suporte";
import { sanitizarTextoDoLead } from "../sanitizar-texto-do-lead";
import { urlPublicaUsavel } from "../url-publica";

import { configEntregaSchema, type ConfigEntrega } from "@/lib/schemas/handoff-delivery";
export { configEntregaSchema };
export type { ConfigEntrega };

export interface PassagemParaEntrega {
  organizationId: string;
  episodeId: string;
  conversationId: string;
  leadId: string;
  serviceRevision: number;
  /** Só fatos comerciais curados; não reutilizar o transcript bruto. */
  resumo: {
    nome?: string;
    /** Identidade do cadastro, nunca telefone extraído do resumo. */
    telefone?: string;
    tentativas?: string[];
    ultimasPalavras?: string;
    interesse?: string;
    troca?: string;
    pagamento?: string;
    proximoPasso?: string;
  };
}
export type Atribuicao =
  | { status: "assigned"; userId: string }
  | { status: "stale" | "conflict" | "no_eligible" | "missing_lead" };
export type ClaimAviso =
  | { status: "claimed"; claimId: string }
  | { status: "delivered" | "busy" | "ambiguous" | "cancelled" };
export interface IdentidadeDoResponsavel {
  nome?: string;
  empresa?: string;
}
export interface BancoDaEntrega {
  /** Nome nativo do dono confirmado na mesma organização, episódio, conversa e card. */
  identidadeDoResponsavel(
    p: PassagemParaEntrega,
    ownerId: string,
  ): Promise<IdentidadeDoResponsavel | null>;
  /** Relê pausa, fronteira/revisão, anonimização e status; origem é o evento confiável. */
  passagemVigente(p: PassagemParaEntrega): Promise<boolean>;
  /** Relê owners da conversa/card sob lock; transferência humana cancela aviso antigo. */
  responsavelVigente(p: PassagemParaEntrega, ownerId: string): Promise<boolean>;
  /**
   * Contrato transacional obrigatório do adapter: lock por org/pool ANTES de
   * escolher; revalidar elegibilidade/canal/capacidade; preservar owner; gravar
   * conversation + card juntos. Replay reutiliza atribuição do episódio; nunca
   * avançar rodízio por retry de etapa/aviso. Não adicionar janela de horário.
   * Nunca resolver isto com dois updates soltos.
   */
  atribuirMesmoResponsavel(p: PassagemParaEntrega, sellers: string[]): Promise<Atribuicao>;
  /** Reusa campos obrigatórios/guardas do CRM. Não inventar etapa nem fechar negócio. */
  moverParaHumano(p: PassagemParaEntrega, ownerId: string): Promise<boolean>;
  canalDaConversa(
    p: PassagemParaEntrega,
  ): Promise<(CanalDoAviso & { desativado?: boolean }) | null>;
  /** Canal conectado como destino seria um loop robô-com-robô. */
  destinoDaOrganizacao(org: string, phone: string): Promise<boolean>;
  /** UNIQUE por (org, episódio, hash destino); requested vencido = ambiguous, NÃO novo claim. */
  reivindicarAviso(p: PassagemParaEntrega, destinationHash: string): Promise<ClaimAviso>;
  /** Persistir estado ANTES da rede; claim token impede worker velho de concluir. */
  marcaTentativa(p: PassagemParaEntrega, claimId: string): Promise<void>;
  concluirAviso(
    p: PassagemParaEntrega,
    claimId: string,
    result: "delivered" | "ambiguous",
    externalId: string | null,
  ): Promise<void>;
}
export interface DepsEntrega {
  db: BancoDaEntrega;
  pacing: PacingDoAviso;
  transporte: TransporteDoAviso;
  /** Mesmo lock/ledger do canal. Nenhuma transação deve dormir esperando rede. */
  comLockDoCanal<T>(org: string, channel: string, action: () => Promise<T>): Promise<T>;
  clock(): Date;
  urlPublica: string;
}
export interface ResultadoEntrega {
  status: "disabled" | "stale" | "conflict" | "retry" | "ambiguous" | "delivered" | "blocked";
  reason?:
    | "notifications_disabled"
    | "missing_lead"
    | "missing_destination"
    | "invalid_url"
    | "invalid_channel"
    | "self_destination"
    | "no_eligible"
    | "stage_refused"
    | "pacing"
    | "busy"
    | "channel_offline"
    | "transport_unavailable"
    | "destination_unresolved";
  ownerId?: string;
  delivered: number;
  pending: number;
  retryAt?: string;
}

const linha = (v: string | undefined, max = 180): string =>
  sanitizarTextoDoLead(
    // Datas completas podem ser nascimento. Não transportar dados de simulação.
    v?.replace(/\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b/g, "[data omitida]"),
    max,
  ) ?? "";

export function textoCurtoDaPassagem(
  p: PassagemParaEntrega,
  base: string,
  links: ConfigEntrega["notice_links"] = "crm",
  responsavel: IdentidadeDoResponsavel = {},
): string {
  if (!urlPublicaUsavel(base)) throw new Error("public_url_invalid");
  const tentativas = [
    ...new Set((p.resumo.tentativas ?? []).map((v) => linha(v, 120)).filter(Boolean)),
  ].slice(0, 2);
  const rows = [
    ["👤 Cliente", linha(p.resumo.nome, 80)],
    ["📋 Interesse do cliente", linha(p.resumo.interesse)],
    ["🔄 Item oferecido em troca", linha(p.resumo.troca, 120)],
    ["💳 Forma de pagamento", linha(p.resumo.pagamento, 120)],
    ["🤖 O que a IA já fez", tentativas.map((t) => `• ${t}`).join("\n")],
    ["💬 Última mensagem do cliente", linha(p.resumo.ultimasPalavras)],
    ["➡️ Próximo passo", linha(p.resumo.proximoPasso, 120)],
  ].filter(([, value]) => value);
  const url = new URL("/app/inbox", base);
  url.searchParams.set("id", p.conversationId);
  const telefone = /^\+?[1-9]\d{7,14}$/.test(p.resumo.telefone ?? "")
    ? p.resumo.telefone!.replace(/^\+/, "")
    : null;
  const incluirWhatsapp = links !== "crm" && telefone !== null;
  // Cadastro ausente/inválido não gera link inventado: preserve acesso ao Inbox.
  const incluirCrm = links !== "whatsapp" || !incluirWhatsapp;
  const nome = linha(responsavel.nome, 80) || "Responsável definido no CRM";
  const empresa = linha(responsavel.empresa, 80);
  return [
    `📋 *Novo atendimento${empresa ? ` | ${empresa}` : ""}*`,
    `👤 *Responsável:* ${nome}`,
    ...rows.map(
      ([label, value]) =>
        `*${label}:*\n${label === "💬 Última mensagem do cliente" ? `“${value}”` : value}`,
    ),
    ...(incluirWhatsapp ? [`📲 *Falar com o cliente:*\nhttps://wa.me/${telefone}`] : []),
    ...(incluirCrm ? [`🔗 *Abrir atendimento no CRM:*\n${url.toString()}`] : []),
  ].join("\n\n");
}

/** Nenhum segredo, telefone ou resumo no resultado/log. Efeitos são ports injetáveis. */
export async function entregarPassagem(
  deps: DepsEntrega,
  p: PassagemParaEntrega,
  config: ConfigEntrega,
): Promise<ResultadoEntrega> {
  const result: ResultadoEntrega = { status: "delivered", delivered: 0, pending: 0 };
  const retry = (reason: ResultadoEntrega["reason"] = "no_eligible"): ResultadoEntrega => ({
    ...result,
    reason,
    status: "retry",
    retryAt: new Date(deps.clock().getTime() + config.retry_seconds * 1000).toISOString(),
  });
  if (!config.enabled) return { ...result, status: "disabled" };
  if (!(await deps.db.passagemVigente(p))) return { ...result, status: "stale" };
  const assigned = await deps.db.atribuirMesmoResponsavel(p, config.seller_user_ids);
  if (assigned.status === "stale") return { ...result, status: "stale" };
  if (assigned.status === "conflict") return { ...result, status: "conflict" };
  if (assigned.status === "missing_lead")
    return { ...result, status: "blocked", reason: "missing_lead" };
  if (assigned.status !== "assigned") return retry();
  result.ownerId = assigned.userId;
  if (!(await deps.db.moverParaHumano(p, assigned.userId)))
    return { ...result, status: "blocked", reason: "stage_refused" };
  // A atribuição e a etapa já foram confirmadas. Sem aviso, não consultar nem
  // resolver transporte/destino/pacing — tampouco criar recibo de envio.
  if (config.notifications_enabled === false)
    return { ...result, reason: "notifications_disabled" };
  // Não notificar alguém diferente do owner escolhido. Config vazia não libera destino.
  const seller = config.seller_destinations[assigned.userId];
  if (!seller) return { ...result, status: "blocked", reason: "missing_destination" };
  if (!urlPublicaUsavel(deps.urlPublica))
    return { ...result, status: "blocked", reason: "invalid_url" };
  const identidade = await deps.db.identidadeDoResponsavel(p, assigned.userId);
  if (!identidade) return { ...result, status: "stale" };
  const body = textoCurtoDaPassagem(p, deps.urlPublica, config.notice_links, identidade);
  const canal = await deps.db.canalDaConversa(p);
  if (!canal || canal.archived_at || canal.desativado || !canal.aceitaMensagemLivre)
    return { ...result, status: "blocked", reason: "invalid_channel" };
  if (canal.status !== "WORKING") return retry("channel_offline");
  const destinations = [...new Set([seller, ...config.supervisor_destinations])];
  for (const phone of destinations) {
    const outcome = await deps.comLockDoCanal(p.organizationId, canal.id, async () => {
      if (!(await deps.db.passagemVigente(p))) return "stale" as const;
      if (!(await deps.db.responsavelVigente(p, assigned.userId))) return "stale" as const;
      if (await deps.db.destinoDaOrganizacao(p.organizationId, phone)) return "blocked" as const;
      if (!(await deps.transporte.configurado(p.organizationId, canal))) {
        result.reason = "transport_unavailable";
        return "retry" as const;
      }
      const pacing = await deps.pacing.decide(p.organizationId, canal.id, deps.clock());
      if (!pacing.liberado) {
        result.reason = "pacing";
        result.retryAt = pacing.liberaEm.toISOString();
        return "retry" as const;
      }
      const to = await deps.transporte.resolveDestino(p.organizationId, canal, phone);
      if (!to) {
        result.reason = "destination_unresolved";
        return "retry" as const;
      }
      const claim = await deps.db.reivindicarAviso(
        p,
        createHash("sha256").update(phone).digest("hex"),
      );
      if (claim.status === "delivered") return "already_delivered" as const;
      if (claim.status === "ambiguous") return "ambiguous" as const;
      if (claim.status === "cancelled") return "stale" as const;
      if (claim.status !== "claimed") {
        result.reason = "busy";
        return "retry" as const;
      }
      // A resolução do destino pode esperar rede. Relê o owner novamente antes
      // de registrar tentativa; o adapter cerca transferência/claim atomicamente.
      if (!(await deps.db.responsavelVigente(p, assigned.userId))) return "stale" as const;
      // Reservar consumo antes da rede: timeout pode ter enviado de verdade.
      // Falha de persistência bloqueia o envio, nunca ignora o teto do canal.
      await deps.pacing.registraEnvio(p.organizationId, canal.id, deps.clock());
      await deps.db.marcaTentativa(p, claim.claimId);
      let externalId: string | null;
      try {
        externalId = (await deps.transporte.envia(p.organizationId, canal, to, body)).externalId;
      } catch {
        await deps.db.concluirAviso(p, claim.claimId, "ambiguous", null);
        return "ambiguous" as const;
      }
      // Sem ACK identificável, entrega não pode ser afirmada nem repetida cegamente.
      if (!externalId) {
        await deps.db.concluirAviso(p, claim.claimId, "ambiguous", null);
        return "ambiguous" as const;
      }
      // Se a gravação falha depois do envio, o requested durável bloqueia replay.
      await deps.db.concluirAviso(p, claim.claimId, "delivered", externalId);
      return "delivered" as const;
    });
    if (outcome === "blocked") return { ...result, status: "blocked", reason: "self_destination" };
    if (outcome === "stale") return { ...result, status: "stale" };
    if (outcome === "delivered" || outcome === "already_delivered") result.delivered++;
    else {
      result.pending++;
      if (outcome === "ambiguous") result.status = "ambiguous";
      else if (result.status !== "ambiguous") result.status = "retry";
    }
  }
  if (result.status === "retry" && !result.retryAt) result.retryAt = retry().retryAt;
  return result;
}

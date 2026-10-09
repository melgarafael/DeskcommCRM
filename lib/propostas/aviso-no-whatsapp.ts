// lib/propostas/aviso-no-whatsapp.ts
/**
 * P4B — o rascunho da IA vira mensagem ao número da EQUIPE, onde o "Aviso no
 * WhatsApp" está configurado. Mesmo desenho do aviso de caso
 * (`lib/escalacao/aviso-ao-suporte.ts`): regra pura, dependências injetadas,
 * nunca devolve `error`.
 *
 * Sem tabela de entrega (D12 da spec de 26/09): a baixa do evento é a trava.
 * Uma queda exatamente entre o envio e a baixa pode repetir o aviso — para a
 * equipe, nunca para o cliente.
 */
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  ADIAMENTO_DO_CANAL_MS,
  ADIAMENTO_DO_DRENO_EM_REQUEST_MS,
  IDADE_MAXIMA_DO_EVENTO_MS,
  TETO_DE_TENTATIVAS_DE_ENVIO,
  TETO_DE_TENTATIVAS_DO_CANAL,
  mascara,
  type CanalDoAviso,
  type ConfigDoAviso,
  type PacingDoAviso,
  type TransporteDoAviso,
} from "@/lib/escalacao/aviso-ao-suporte";
import { primeiroNome } from "@/lib/escalacao/texto-do-aviso";
import { urlPublicaUsavel } from "@/lib/escalacao/url-publica";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export const EVENTO_PROPOSTA_PRONTA = "proposal.ready_for_review";

export interface AvisoDePropostaDb {
  preferencia(orgId: string): Promise<boolean>;
  carregaConfig(orgId: string): Promise<ConfigDoAviso | null>;
  carregaProposta(orgId: string, propostaId: string): Promise<{ titulo: string | null; status: string; contact_id: string | null } | null>;
  avisoAberto(orgId: string, propostaId: string): Promise<boolean>;
  nomeDoContato(orgId: string, contactId: string): Promise<string | null>;
  carregaCanal(orgId: string, channelSessionId: string): Promise<CanalDoAviso | null>;
  registraJidDoAviso(orgId: string, jid: string): Promise<void>;
  marcaDaOrganizacao(orgId: string): Promise<{ nome: string; idioma: Idioma }>;
}

export interface AvisoDePropostaDeps {
  db: AvisoDePropostaDb;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
  urlPublica: string;
  origemDoDreno: () => "worker" | "request";
  audita: (entrada: {
    action: "proposal.aviso_whatsapp_enviado" | "proposal.aviso_whatsapp_falhou";
    organizationId: string;
    propostaId: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export interface DesfechoDoAvisoDeProposta {
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

const skipped = (detail: string): DesfechoDoAvisoDeProposta => ({ status: "skipped", detail });
const retry = (quando: Date, detail: string): DesfechoDoAvisoDeProposta => ({ status: "retry", detail, retry_at: quando.toISOString() });

export function linkDaProposta(base: string, propostaId: string): string {
  return `${base.replace(/\/+$/, "")}/app/proposals/${propostaId}`;
}

export function montarAvisoDeProposta(e: { marca: string; idioma: Idioma; titulo: string | null; cliente: string | null; link: string }): string {
  const t = (texto: string): string => traduzir(texto, e.idioma);
  const linhas = [`📄 ${e.marca}: ${t("a IA rascunhou uma proposta")}`, ""];
  const titulo = (e.titulo ?? "").trim().slice(0, 80);
  if (titulo) linhas.push(`${t("Proposta")}: ${titulo}`);
  const cliente = primeiroNome(e.cliente);
  if (cliente) linhas.push(`${t("Cliente")}: ${cliente}`);
  linhas.push("", `${t("Revisar e enviar")}: ${e.link}`, "");
  linhas.push(t("Responder aqui não chega ao cliente — abra o link para revisar."));
  return linhas.join("\n");
}

function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  return !Number.isNaN(emitido) && agora.getTime() - emitido > IDADE_MAXIMA_DO_EVENTO_MS;
}

export async function aplicaAvisoDeProposta(deps: AvisoDePropostaDeps, row: EventRow): Promise<DesfechoDoAvisoDeProposta> {
  if (row.event_type !== EVENTO_PROPOSTA_PRONTA) return skipped("evento_ignorado");
  const agora = deps.clock();
  const orgId = row.organization_id;

  if (deps.origemDoDreno() === "request") {
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS), "adiado: dreno dentro da requisição");
  }

  const propostaId =
    (typeof row.payload.proposal_id === "string" ? row.payload.proposal_id : null) ??
    (typeof row.entity_id === "string" ? row.entity_id : null);
  if (!propostaId) return skipped("payload_incompleto");

  if (!(await deps.db.preferencia(orgId))) return skipped("desligado_em_propostas");

  const cfg = await deps.db.carregaConfig(orgId);
  if (!cfg || !cfg.ligado || !cfg.channel_session_id) return skipped("sem_configuracao");
  const canalId = cfg.channel_session_id;

  if (passouDoTeto(row, agora)) return skipped("evento_velho");

  const proposta = await deps.db.carregaProposta(orgId, propostaId);
  if (!proposta || proposta.status !== "rascunho") return skipped("proposta_fora_de_rascunho");
  if (!(await deps.db.avisoAberto(orgId, propostaId))) return skipped("aviso_ja_resolvido");

  const tentativa = row.attempts + 1;
  const falha = (codigo: string): DesfechoDoAvisoDeProposta => {
    deps.audita({
      action: "proposal.aviso_whatsapp_falhou",
      organizationId: orgId,
      propostaId,
      metadata: { codigo, canal: canalId, tentativas: tentativa },
    });
    return skipped(codigo);
  };

  const canal = await deps.db.carregaCanal(orgId, canalId);
  if (!canal || canal.archived_at) return falha("canal_arquivado");
  if (canal.desativado) return falha("canal_desativado");
  if (!canal.aceitaMensagemLivre) return falha("canal_nao_aceita_aviso_livre");
  if (canal.status !== "WORKING") {
    if (tentativa >= TETO_DE_TENTATIVAS_DO_CANAL) return falha("canal_desconectado");
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), `canal ${canal.status}`);
  }

  if (!urlPublicaUsavel(deps.urlPublica)) return falha("sem_endereco_publico");

  if (!(await deps.transporte.configurado(orgId, canal))) {
    if (tentativa >= TETO_DE_TENTATIVAS_DE_ENVIO) return falha("transporte_ausente");
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }

  const pacing = await deps.pacing.decide(orgId, canalId, agora);
  if (!pacing.liberado) return retry(pacing.liberaEm, `pacing:${pacing.motivo}`);

  const to = await deps.transporte.resolveDestino(orgId, canal, cfg.telefone_destino);
  if (!to) return falha("destino_invalido");

  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const cliente = proposta.contact_id ? await deps.db.nomeDoContato(orgId, proposta.contact_id) : null;
  const body = montarAvisoDeProposta({
    marca: marca.nome,
    idioma: marca.idioma,
    titulo: proposta.titulo,
    cliente,
    link: linkDaProposta(deps.urlPublica, propostaId),
  });

  try {
    await deps.transporte.envia(orgId, canal, to, body);
  } catch {
    if (tentativa >= TETO_DE_TENTATIVAS_DE_ENVIO) return falha("falha_no_envio");
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "envio recusado");
  }

  // Depois do envio TUDO falha aberto: a mensagem já saiu, e lançar aqui faria
  // o dreno reprocessar e a equipe receber de novo.
  try {
    await deps.pacing.registraEnvio(orgId, canalId, agora);
  } catch {
    /* o ledger é best-effort depois do envio — ver comentário acima */
  }
  try {
    await deps.db.registraJidDoAviso(orgId, to);
  } catch {
    /* idem */
  }
  deps.audita({
    action: "proposal.aviso_whatsapp_enviado",
    organizationId: orgId,
    propostaId,
    metadata: { canal: canalId, tentativas: tentativa, destino_mascarado: mascara(cfg.telefone_destino) },
  });
  return { status: "ok", detail: `enviado canal=${canalId}` };
}

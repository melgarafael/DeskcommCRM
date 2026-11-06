/**
 * AVISO DE STATUS DO MODELO — canal oficial direto (fatia 3 do #3635).
 *
 * ─── O que estava invisível ────────────────────────────────────────────────
 *
 * A plataforma revisa as definições DEPOIS da criação: aprova, reprova, pausa,
 * desativa. O espelho (`meta_templates.status`) era atualizado em silêncio — e
 * ninguém abre a tela de modelos por acaso. A descoberta acontecia no disparo
 * que não saiu, com a campanha montada e o cliente esperando. O canal de
 * parceiro já avisava na Central (`lib/channels/zernio/avisos.ts`); isto leva o
 * MESMO aviso ao canal oficial direto.
 *
 * ─── Por que aqui, e não dentro do handler ─────────────────────────────────
 *
 * O handler do webhook decide o que fazer com o payload; a tradução de um
 * evento da plataforma em aviso para o operador é outra responsabilidade — é o
 * que o canal de parceiro também separou. E é esta função que os testes do
 * webhook exercitam pelo caminho real, sem arrastar HTTP.
 *
 * ─── NUNCA lança ───────────────────────────────────────────────────────────
 *
 * O webhook responde 2xx a um evento que já foi espelhado. Deixar uma falha de
 * INSERT de aviso subir viraria 5xx, e a Meta re-entrega tudo que não recebe
 * 2xx — em backoff, por horas. Um erro de escrita na Central vira
 * `"falhou"` e o espelho — que já aconteceu antes — permanece. Auto-DDoS é
 * proibido; visibilidade é o objetivo, não a nova fonte de indisponibilidade.
 *
 * ─── Idempotência ──────────────────────────────────────────────────────────
 *
 * A entrega do webhook se repete. A chave é a que o repo já usa nos avisos com
 * referência: `(organization_id, kind, ref_kind, ref_id, title)` com
 * `status = 'open'`. O título carrega modelo + idioma + desfecho, então duas
 * entregas do MESMO evento casam; o índice único parcial
 * `agent_inbox_modelo_direto_aberto_unico` (migration 9084) fecha a corrida
 * entre duas entregas simultâneas, e o `23505` é lido como `"ja_aberto"`.
 *
 * O `ref_id` é a CONEXÃO (`channel_session_id`), nunca a organização sozinha:
 * duas conexões da mesma empresa podem ter modelos de mesmo nome, e o aviso de
 * uma não pode aparecer como se fosse da outra.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { telaDeModelos } from "../templates-fonte";

/** Kind próprio do canal direto — a Central dá rótulo e destino por kind. */
export const KIND_DO_AVISO_DO_MODELO = "channel_template_review_direct";

/**
 * O que cada desfecho significa para quem opera.
 *
 * `critical` para o que INTERROMPE o envio (reprovado, desativado): a campanha
 * que dependia do modelo não vai sair. `warn` para a pausa, que pede atenção
 * sem ser definitiva. `info` para a aprovação, que vale registrar e não vale
 * interromper. Marcar tudo como crítico é o mesmo que não marcar nada.
 */
const DESFECHOS: Record<string, { severity: "info" | "warn" | "critical"; frase: string }> = {
  APPROVED: { severity: "info", frase: "foi aprovado" },
  REJECTED: { severity: "critical", frase: "foi reprovado" },
  PAUSED: { severity: "warn", frase: "foi pausado" },
  DISABLED: { severity: "critical", frase: "foi desativado" },
};

/**
 * Motivo da reprovação em português de gente.
 *
 * O `reason` do webhook é um CÓDIGO da Meta (`INCORRECT_CATEGORY`), não uma
 * frase: despejá-lo na Central é mostrar o vocabulário do fornecedor para quem
 * precisa decidir o que corrigir. Código fora do dicionário NÃO vaza — vira o
 * texto genérico abaixo, e o detalhe fica no Gerenciador do WhatsApp.
 *
 * `NONE` já chega como `null` do parser (é como a Meta diz "sem motivo"), mas a
 * normalização aqui repete a régua para quem chamar a função direto.
 */
const MOTIVOS: Record<string, string> = {
  ABUSIVE_CONTENT: "a plataforma considerou o conteúdo abusivo",
  CATEGORY_NOT_AVAILABLE: "a categoria escolhida não está disponível para esta conta",
  INCORRECT_CATEGORY: "a categoria do modelo não corresponde ao conteúdo",
  INVALID_FORMAT: "o formato do modelo não é aceito pela plataforma",
  INVALID_MEDIA: "a mídia de exemplo foi recusada",
  INVALID_PARAMETER: "um parâmetro do modelo está incorreto",
  INVALID_VARIABLE: "uma variável do modelo está incorreta",
  PROMOTIONAL_CONTENT: "o conteúdo foi classificado como promocional",
  SCAM: "a plataforma classificou o conteúdo como suspeito",
  TAG_CONTENT_VIOLATION: "o conteúdo viola as políticas de mensagem da plataforma",
};

const MOTIVO_DESCONHECIDO =
  "a plataforma não detalhou o motivo — confira o modelo no Gerenciador do WhatsApp";
const MOTIVO_AUSENTE = "a plataforma não informou o motivo";

function motivoLegivel(reason: string | null): string {
  const codigo = (reason ?? "").trim().toUpperCase();
  if (!codigo || codigo === "NONE") return MOTIVO_AUSENTE;
  return MOTIVOS[codigo] ?? MOTIVO_DESCONHECIDO;
}

export interface EventoDoModelo {
  templateName: string;
  templateLanguage: string;
  /** Desfecho cru da Meta (`APPROVED`, `REJECTED`, `PAUSED`, `DISABLED`, …). */
  event: string;
  /** Código cru da Meta; `null` quando ela não manda motivo. */
  reason: string | null;
}

export interface ContextoDoAviso {
  organizationId: string;
  /** A CONEXÃO desta entrega — o escopo do aviso e do espelho. */
  channelSessionId: string;
  /** Como o operador chama a conexão; com dois números, "um modelo" não diz qual. */
  conexao: string;
}

/** O aviso pronto, ou `null` para evento que não é dos nossos. */
export function avisoDoModelo(
  evento: EventoDoModelo,
  conexao: string,
): { severity: "info" | "warn" | "critical"; title: string; body: string } | null {
  const desfecho = DESFECHOS[evento.event.trim().toUpperCase()];
  if (!desfecho) return null; // evento desconhecido é IGNORADO, não erro

  const nome = evento.templateName;
  const idioma = evento.templateLanguage;
  // Título curto e ÚNICO por (modelo, idioma, desfecho): é a chave do dedupe.
  const title = `Modelo "${nome}" (${idioma}) ${desfecho.frase}`;

  const motivo =
    desfecho === DESFECHOS.REJECTED ? ` Motivo: ${motivoLegivel(evento.reason)}.` : "";

  const body =
    `O modelo "${nome}" (idioma ${idioma}) ${desfecho.frase} pela Meta na conexão ` +
    `"${conexao}".${motivo} Abra Modelos em Conexões para conferir: ${telaDeModelos("oficial")}`;

  return { severity: desfecho.severity, title, body };
}

export type DesfechoDoAviso = "criado" | "ja_aberto" | "nao_se_aplica" | "falhou";

/**
 * Abre o aviso na Central, sem repetir o que já está aberto e sem lançar.
 *
 * O espelho do template é atualizado ANTES desta chamada, no handler. Aqui só
 * se empurra o operador para olhar — e uma falha aqui nunca desfaz o espelho.
 */
export async function abrirAvisoDoModelo(
  admin: SupabaseClient,
  contexto: ContextoDoAviso,
  evento: EventoDoModelo,
): Promise<DesfechoDoAviso> {
  const aviso = avisoDoModelo(evento, contexto.conexao);
  if (!aviso) return "nao_se_aplica";

  try {
    const { data: jaAberto } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", contexto.organizationId)
      .eq("kind", KIND_DO_AVISO_DO_MODELO)
      .eq("ref_kind", "channel_session")
      .eq("ref_id", contexto.channelSessionId)
      .eq("title", aviso.title)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();

    if (jaAberto) return "ja_aberto";

    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: contexto.organizationId,
      kind: KIND_DO_AVISO_DO_MODELO,
      severity: aviso.severity,
      title: aviso.title,
      body: aviso.body,
      ref_kind: "channel_session",
      ref_id: contexto.channelSessionId,
    });

    // 23505 = outra entrega simultânea abriu o mesmo aviso primeiro. Não é erro.
    if (error?.code === "23505") return "ja_aberto";
    if (error) return "falhou";
    return "criado";
  } catch {
    return "falhou";
  }
}

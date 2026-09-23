/**
 * A RESPOSTA do contato volta para a campanha que falou com ele.
 *
 * ═══ Por que existe ═══
 *
 * Sem isto, o funil da campanha para em "lida": o operador vê que a mensagem
 * chegou e foi aberta, e nunca descobre se alguém respondeu — que é a única
 * coisa que diz se a copy e a oferta prestam. A resposta já entra pelo inbox
 * normal; o que falta é ATRIBUIR.
 *
 * ═══ A janela de 72 horas ═══
 *
 * Decisão do dono do produto (2026-09-18), e não um número escolhido aqui: três
 * dias pega quem responde no fim de semana sem atribuir à campanha uma conversa
 * que começou por outro motivo semanas depois. Sem janela, toda mensagem que um
 * ex-destinatário mandasse — por meses — viraria "resposta à campanha", e a taxa
 * de resposta subiria sozinha com o tempo.
 *
 * ═══ Por que não cria régua própria de opt-out ═══
 *
 * Quem decide que uma mensagem é um pedido de parar é `lib/opt-out/deteccao.ts`,
 * pela ingestão, que grava `contacts.is_blocked`. Aqui só se LÊ essa marca. Uma
 * segunda regex seria uma segunda regra, e o dia em que as duas discordassem o
 * contato estaria bloqueado num lado e não no outro.
 *
 * ═══ Por que não intercepta nada ═══
 *
 * Este consumidor não decide atendimento, não silencia agente e não segura o
 * inbound. Ele carimba `replied_at` e sai. Falha dele não pode custar a resposta
 * de um cliente — por isso devolve `skipped`/`error` ao dispatcher em vez de
 * lançar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ATRIBUICAO_PADRAO_HORAS, janelaDeAtribuicaoMs, lerConfiguracao } from "./configuracao";

/**
 * Janela de atribuição de resposta — o DEFAULT.
 *
 * Decisão de produto de 2026-09-18. Desde a tela de padrões de campanha, a
 * organização pode mudá-la sem trocar de versão: quem manda é
 * `organizations.settings.campanhas.atribuicao_horas`, e isto é o que vale
 * quando ninguém escolheu. Mexer aqui muda a taxa de resposta de toda campanha
 * já enviada, então não é ajuste de implementação.
 */
export const JANELA_DE_ATRIBUICAO_MS = ATRIBUICAO_PADRAO_HORAS * 60 * 60 * 1000;

/** Estados que uma resposta pode promover. Quem não saiu não "respondeu". */
const PROMOVIVEIS = new Set(["sent", "delivered", "read"]);

export interface DestinatarioCandidato {
  id: string;
  status: string;
  sent_at: string | null;
  replied_at: string | null;
}

/**
 * Qual destinatário essa mensagem responde — puro.
 *
 * O MAIS RECENTE dentro da janela, e não o primeiro: se duas campanhas falaram
 * com a mesma pessoa, quem ela está respondendo é quem falou por último. Fora da
 * janela, ninguém — e devolver `null` aqui é a diferença entre uma métrica e um
 * palpite.
 */
export function destinatarioQueEssaRespostaFecha(
  candidatos: readonly DestinatarioCandidato[],
  recebidoEm: Date,
  janelaMs: number = JANELA_DE_ATRIBUICAO_MS,
): DestinatarioCandidato | null {
  const piso = recebidoEm.getTime() - janelaMs;
  let escolhido: DestinatarioCandidato | null = null;
  let maisRecente = -Infinity;

  for (const c of candidatos) {
    if (c.replied_at !== null) continue;
    if (!c.sent_at) continue;
    if (!PROMOVIVEIS.has(c.status)) continue;
    const quando = new Date(c.sent_at).getTime();
    if (Number.isNaN(quando)) continue;
    // Enviada DEPOIS da resposta não é o que a resposta responde — acontece
    // quando o ack e o inbound chegam quase juntos.
    if (quando > recebidoEm.getTime()) continue;
    if (quando < piso) continue;
    if (quando > maisRecente) {
      maisRecente = quando;
      escolhido = c;
    }
  }

  return escolhido;
}

export interface ResumoDaResposta {
  /** `true` quando alguma linha foi carimbada. */
  atribuiu: boolean;
  /** Quantos destinatários pendentes foram fechados por opt-out. */
  optOut: number;
}

/**
 * Carimba a resposta e, se o contato passou a estar bloqueado, fecha o que ainda
 * iria para ele.
 *
 * Idempotente pelos dois lados: o `UPDATE` da resposta só alcança linha com
 * `replied_at is null`, e o do opt-out só alcança linha que ainda não é
 * `opted_out`. Um evento entregue duas vezes não duplica métrica.
 */
export async function aplicarRespostaNaCampanha(
  admin: SupabaseClient,
  entrada: { organizationId: string; contactId: string; recebidoEm: Date },
): Promise<ResumoDaResposta> {
  const { organizationId, contactId, recebidoEm } = entrada;

  // A janela vem da ORGANIZAÇÃO, com o default do produto quando ninguém
  // escolheu. Ler config nunca derruba a atribuição: `lerConfiguracao` cai no
  // padrão em vez de lançar.
  const { data: org } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  const janelaMs = janelaDeAtribuicaoMs(lerConfiguracao((org as { settings?: unknown } | null)?.settings));
  const piso = new Date(recebidoEm.getTime() - janelaMs).toISOString();

  const { data, error } = await admin
    .from("campaign_recipients")
    .select("id, status, sent_at, replied_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .is("replied_at", null)
    .not("sent_at", "is", null)
    .gte("sent_at", piso)
    .order("sent_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`resposta de campanha: leitura — ${error.message}`);

  const alvo = destinatarioQueEssaRespostaFecha(
    (data ?? []) as unknown as DestinatarioCandidato[],
    recebidoEm,
    janelaMs,
  );

  let atribuiu = false;
  if (alvo) {
    const { data: carimbadas } = await admin
      .from("campaign_recipients")
      .update({ replied_at: recebidoEm.toISOString(), status: "replied" })
      .eq("id", alvo.id)
      .is("replied_at", null)
      .select("id");
    atribuiu = (carimbadas ?? []).length > 0;
  }

  const optOut = await fecharPorOptOut(admin, organizationId, contactId, recebidoEm);
  return { atribuiu, optOut };
}

/**
 * Se a ingestão marcou o contato como bloqueado, nenhuma campanha fala mais com
 * ele — e as linhas que ainda esperavam viram `opted_out`, com o carimbo.
 *
 * O envio já revalida o bloqueio antes de cada mensagem, então isto não é o que
 * IMPEDE o envio: é o que faz o número aparecer na tela e nas métricas. Sem ele,
 * o operador veria a campanha parar de crescer sem saber por quê.
 *
 * Alcança também quem já recebeu (`sent`/`delivered`/`read`): para essas linhas
 * `opted_out` é métrica — a mensagem saiu e a pessoa pediu para parar, e é isso
 * que a taxa de opt-out mede.
 */
async function fecharPorOptOut(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
  agora: Date,
): Promise<number> {
  const { data: contato } = await admin
    .from("contacts")
    .select("is_blocked")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (!(contato as { is_blocked?: boolean } | null)?.is_blocked) return 0;

  const { data } = await admin
    .from("campaign_recipients")
    .update({
      status: "opted_out",
      opted_out_at: agora.toISOString(),
      eligibility_status: "excluded",
      exclusion_reason: "opt_out",
    })
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .in("status", ["pending", "queued", "sent", "delivered", "read", "replied"])
    .select("id");
  return (data ?? []).length;
}

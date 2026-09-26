import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * O ENVIO do aviso de escalação — lado do CRM (`supabase-js`).
 *
 * ## Por que existe um segundo emissor
 *
 * O repo tem DOIS motores de passagem para humano, e eles não se falam:
 *
 *   - `performHumanHandoff` (`lib/agent-engine/agent/human-handoff.ts`) roda no
 *     motor de conversa, sobre `pg.Pool`, dentro de um turno com job e canal;
 *   - `triggerHandoff` (`./orchestrator.ts`) roda no mundo do CRM, sobre
 *     `supabase-js`, disparado por evento (sentimento) ou por tool MCP — sem
 *     job, sem `pg.Pool`, às vezes dentro de uma requisição Next.
 *
 * Consertar só o primeiro conserta metade do defeito. A conversa `b934ba2d`
 * medida em produção em 2026-08-26 — a que ficou muda depois que a IA PERGUNTOU
 * o e-mail do cliente — foi silenciada por ESTE lado, com
 * `last_handoff_reason='low_sentiment'`.
 *
 * ## Por que o texto é o mesmo e o encanamento não
 *
 * O texto é `lib/escalacao/aviso-ao-lead.ts`, compartilhado — duas redações
 * envelheceriam separadas. O encanamento não pode ser: `runBeforeSend` exige
 * `pg.Pool` e um `job_id` para o ledger, e aqui não há nem um nem outro. Abrir
 * um pool dentro de uma rota Next para mandar uma frase seria pagar caro por
 * simetria de fachada.
 *
 * O que se perde sem a cadeia, dito com todas as letras: janela/throttle
 * anti-ban, spinning, disclosure e o gate de LGPD. O que NÃO se perde é o que
 * mais importa aqui — `sendMessageHandler` recusa contato `is_blocked` com 403
 * (`app/api/v1/messages/_handler.ts`), que é a trava irrevogável (regra dura
 * nº 2). E o aviso do lado do motor, esse sim, passa pela cadeia inteira.
 *
 * ## Ordem
 *
 * Chamado ANTES do UPDATE que silencia. Do lado do motor a ordem é obrigatória
 * (o `force_human` que ele grava arma o `stopGate` e mata o envio seguinte);
 * deste lado ela é apenas honesta — `triggerHandoff` não grava `force_human`, e
 * o silêncio que ele grava não é lido pelo caminho de envio. Mantê-la igual nos
 * dois evita que alguém "otimize" um deles sem perceber que no outro isso apaga
 * a mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { motivoDoAviso, textoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import { carregarRosterDeAtendimento, podeAssumirAgora } from "@/lib/escalacao/atendentes";
// Dois `MotivoDoAviso` no repositório: o de `escalacao/aviso-ao-lead` diz QUE
// FRASE o cliente lê; este diz POR QUE ele não leu nada. O apelido impede a
// confusão numa leitura rápida.
import type {
  DesfechoDoAvisoAoCliente,
  MotivoDoAviso as MotivoDoAvisoDaPassagem,
} from "@/lib/escalacao/passagem";
import type { QuemPodeAssumir } from "@/lib/escalacao/disponibilidade";
import { logger } from "@/lib/logger";

/** Ator do envio — é o automático falando, não uma pessoa. */
const ATOR_DO_AVISO = "handoff-orchestrator";

export interface AvisoDoCrmInput {
  serviceBoundary?: ServiceBoundary;
  organizationId: string;
  conversationId: string;
  /** `contacts.id` — semente da variante do texto (nada dele aparece na frase). */
  contactId: string;
  /** `conversations.last_handoff_reason` que está sendo gravado agora. */
  reason: string;
}

/**
 * O desfecho do aviso. É o MESMO tipo do outro emissor, por definição — ver
 * `DesfechoDoAvisoAoCliente`: enquanto eram dois, este lado tinha um
 * `{ avisado: boolean }` solto, e foi por essa folga que "avisado: true" passou
 * sem ninguém olhar o status da mensagem.
 */
export type DesfechoDoAvisoDoCrm = DesfechoDoAvisoAoCliente;

/**
 * `messages.error_code` → o motivo fechado. Parcial de propósito: código que não
 * está aqui vira "não avisado, motivo desconhecido", que é a verdade disponível.
 */
const CODIGO_DO_ERRO: Readonly<Record<string, MotivoDoAvisoDaPassagem>> = {
  pre_go_live: "pre_go_live",
  pre_go_live_indisponivel: "pre_go_live",
  channel_archived: "canal_arquivado",
  missing_phone_number: "sem_telefone",
};

/**
 * Avisa o lead. NUNCA lança: o orquestrador inteiro é fire-and-forget por
 * contrato ("nunca propaga exceção pro caller"), e um erro aqui não pode impedir
 * a passagem que ele antecede.
 *
 * ⚠️ **O QUE MUDOU, e por que era grave.** Esta função devolvia `avisado: true`
 * sempre que `sendMessageHandler` não LANÇAVA — e ele quase nunca lança: canal
 * em modo de teste, canal arquivado, contato sem telefone e recusa do transporte
 * viram `status='failed'` DENTRO da linha da mensagem, com `error_code`, e a
 * chamada volta normal. O resultado é que a Central afirmava "O cliente JÁ FOI
 * avisado" para uma pessoa que não recebeu nada, e o atendente abria a conversa
 * respondendo a alguém que não sabia que ele vinha. Agora o desfecho é lido do
 * `status` da mensagem devolvida, que é o único lugar onde ele existe.
 */
export async function avisarLeadDoCrm(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<DesfechoDoAvisoDoCrm> {
  try {
    // O aviso sai no idioma da ORGANIZAÇÃO (ver `textoDoAviso`). A leitura que
    // falha não pode derrubar o aviso: sem idioma, sai em português, como antes.
    let idioma: string | null = null;
    try {
      const { data: org } = await admin
        .from("organizations")
        .select("locale")
        .eq("id", input.organizationId)
        .maybeSingle();
      idioma = (org as { locale?: string | null } | null)?.locale ?? null;
    } catch {
      idioma = null;
    }
    const body = textoDoAviso(
      motivoDoAviso(input.reason),
      await quemPodeAssumir(admin, input.organizationId),
      input.contactId,
      idioma,
    );
    const mensagem = await sendMessageHandler(
      admin,
      {
        organization_id: input.organizationId,
        serviceBoundary: input.serviceBoundary,
        actor: { type: "ai_agent", id: ATOR_DO_AVISO, role: "manager" },
        requestId: `handoff-aviso-${input.conversationId}`,
      },
      {
        conversation_id: input.conversationId,
        type: "text",
        body,
        // A linha se DECLARA. Sem isto, no banco e na tela, este aviso é
        // indistinguível de uma fala do agente — e ele não é: é texto de
        // sistema, escrito em código, que sai no instante em que a IA se
        // retira. Quem audita a conversa depois precisa saber a diferença, e
        // quem escreve teste sobre este caminho também.
        metadata: { aviso_de_escalacao: true, handoff_reason: input.reason },
      },
    );
    if (mensagem.status === "sent") return { avisado: true };
    if (mensagem.status === "queued") {
      // `queued` é canal fora do ar OU instalação sem transporte configurado —
      // nos dois casos o cliente não recebeu nada e pode nunca receber. Chamar
      // isso de "avisado" é a promessa que quebrava a primeira frase de quem
      // assume a conversa.
      return {
        avisado: false,
        porque: "na_fila_canal_fora",
        motivoCodigo: "na_fila_canal_fora",
      };
    }
    const codigo = CODIGO_DO_ERRO[mensagem.error_code ?? ""] ?? "falhou_no_envio";
    return { avisado: false, porque: mensagem.error_code ?? "falhou_no_envio", motivoCodigo: codigo };
  } catch (err) {
    // PII fora do log: só o motivo da falha.
    const porque = err instanceof Error ? err.name : "erro_desconhecido";
    logger.warn("[handoff-orchestrator] aviso ao lead não saiu", {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { avisado: false, porque };
  }
}


/**
 * Quantos podem assumir agora, no vocabulário que o texto espera.
 *
 * Reusa `carregarRosterDeAtendimento` + `podeAssumirAgora` — o par supabase-js
 * que a rota do painel e a capacidade do agente já usam. Não é um terceiro
 * leitor: é o MESMO predicado (`isAttendantEligible`) que o motor lê por `pg` em
 * `quemPodeAssumirAgora`. Duas portas, uma régua.
 *
 * `null` quando a leitura falha — e `textoDoAviso` lê `null` como "não prometa
 * prazo", que é a direção certa do erro.
 */
async function quemPodeAssumir(
  admin: SupabaseClient,
  organizationId: string,
): Promise<QuemPodeAssumir | null> {
  try {
    const agora = new Date();
    const roster = await carregarRosterDeAtendimento(admin, organizationId, agora);
    return {
      total: roster.length,
      disponiveis: roster.filter((a) => podeAssumirAgora(a, agora)).length,
    };
  } catch (err) {
    logger.warn("[handoff-orchestrator] disponibilidade não lida — aviso sem prazo", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }
}

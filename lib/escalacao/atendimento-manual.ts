/**
 * ATENDIMENTO MANUAL PELO CANAL — o dono pegou o celular e respondeu o cliente
 * direto no WhatsApp (ou por outra plataforma ligada à mesma conta). A IA para
 * NESSA conversa, para não responder junto — e volta sozinha quando o prazo
 * vence.
 *
 * ## Por que existe
 *
 * `app/api/v1/messages/_handler.ts` (composer) já silencia o bot quando o ATOR é
 * uma pessoa — mas por uma janela deslizante de 5 min. O envio feito do celular
 * do operador NÃO passa por ali: ele entra pela ingestão de saída do canal (o
 * caminho `fromMe` do webhook, mensagem enviada fora do CRM) e era gravado como
 * histórico sem tocar em trava nenhuma. Resultado: a IA continuava respondendo
 * por cima de quem estava atendendo à mão.
 *
 * A lacuna foi medida em produção (tenant YADEA): um humano negociou preço e
 * pagamento de peça direto no WhatsApp, e a IA, sem saber disso, se meteu de
 * volta na conversa afirmando que "os dados do PIX estão sendo confirmados" —
 * algo que ela não tem nenhuma ferramenta para saber.
 *
 * ## O prazo, e por que ele é 60 minutos
 *
 * O silêncio EXPIRA sozinho. Não é `'infinity'`: `'infinity'` é o handoff
 * FORMAL, aquele em que alguém clicou "assumir" na tela e assumiu junto a
 * responsabilidade de devolver. Aqui ninguém clicou em nada — a pessoa só
 * respondeu uma mensagem pelo celular. Silêncio durável nesse gesto significa
 * que um "oi" do próprio dono testando o número desliga o atendimento
 * automático daquela conversa para sempre, e ninguém fica sabendo: a conversa
 * some do robô sem aparecer para nenhum humano.
 *
 * 60 minutos porque é a ordem de grandeza de um atendimento humano de verdade
 * — quem parou para responder pelo celular termina o assunto dentro da hora —,
 * é muito mais que a janela de 5 min do composer (que cobre só o tempo de
 * digitar dentro do CRM) e é curto o bastante para que um engano se pague
 * sozinho no mesmo turno de trabalho, em vez de virar uma conversa morta.
 *
 * ⚠️ Quem quiser outro prazo mexe AQUI, num lugar só: a constante é lida por
 * TODO canal cuja ingestão reconhece saída feita fora do CRM, e pelo teste.
 *
 * ## Cada mensagem nova do humano RENOVA o prazo
 *
 * O relógio conta a partir da ÚLTIMA fala humana, não da primeira. Sem isso, um
 * atendimento de uma hora e meia veria a IA voltar a falar no meio — que é o
 * pior desfecho possível, porque é justamente quando há uma pessoa na conversa.
 * Na prática: cada chamada propõe `agora + PRAZO` e grava se isso for MAIS
 * TARDE que o silêncio em vigor.
 *
 * ## O que NUNCA encurta
 *
 * Um silêncio maior já em vigor fica: handoff formal (`'infinity'`, que
 * `normalizarInstante` devolve como `Infinity`) e qualquer janela mais longa
 * que a nossa. A pausa por resposta manual é o silêncio mais FRACO da casa —
 * ela estende, nunca regride.
 *
 * ## O que grava, e o que NÃO grava
 *
 *   - `bot_silenced_until = agora + PRAZO_DO_SILENCIO_MS`
 *   - `last_handoff_at` / `last_handoff_reason` — rastro visível de que uma
 *     pessoa assumiu por fora.
 *
 * **NÃO toca `contacts.ai_authorized_at`.** A origem/autorização do lead é
 * estado SEPARADO (elegibilidade), não handoff. Uma resposta manual pausa a
 * conversa; não apaga que o lead veio do Respondi. Quando o prazo vence, a
 * autorização ainda está lá.
 *
 * **NÃO toca `contacts.force_human`** (trava do CONTATO inteiro — pausar uma
 * conversa não é bloquear o cliente) nem `assignee_kind` (exige um
 * `assigned_to_user_id`, e o celular do dono não é necessariamente um usuário do
 * CRM) nem `status` (mandar para `pending` diria "na fila esperando atendente",
 * o oposto de "estou atendendo").
 *
 * Fire-and-forget: a ingestão da mensagem do cliente não pode cair porque a
 * pausa falhou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { normalizarInstante } from "@/lib/ai/elegibilidade/gate";

/**
 * Quanto tempo a IA fica calada depois de uma resposta manual pelo canal.
 * Ver "O prazo, e por que ele é 60 minutos" na docstring do módulo — o número
 * tem motivo, e mudá-lo é uma decisão de produto, não de implementação.
 */
export const PRAZO_DO_SILENCIO_MS = 60 * 60 * 1000;

const MOTIVO = "Atendimento manual pelo canal (resposta fora do CRM)";

export interface PausaPorAtendimentoManualInput {
  organizationId: string;
  conversationId: string;
  /** Rótulo da origem do evento, só para log (o adapter que chamou se identifica). */
  canal?: string;
  /**
   * O instante da fala humana. INJETADO para o teste não depender do relógio
   * real: o `now()` do banco e o `Date.now()` do processo são dois relógios, e
   * comparar um com o outro produz falha intermitente. Default = agora.
   */
  agora?: Date;
}

/**
 * Pausa a IA numa conversa porque uma pessoa respondeu por fora do CRM, por
 * `PRAZO_DO_SILENCIO_MS` a contar de `agora`. Devolve `true` se gravou (pausa
 * nova ou prazo renovado), `false` se havia silêncio mais longo em vigor ou se
 * falhou.
 */
export async function pausarIaPorAtendimentoManual(
  admin: SupabaseClient,
  input: PausaPorAtendimentoManualInput,
): Promise<boolean> {
  const agora = input.agora ?? new Date();
  const proposto = new Date(agora.getTime() + PRAZO_DO_SILENCIO_MS);

  try {
    const { data: atual, error: readErr } = await admin
      .from("conversations")
      .select("bot_silenced_until")
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId)
      .maybeSingle();

    if (readErr) {
      logger.warn("[atendimento-manual] leitura da conversa falhou — IA não pausada", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: readErr.message.slice(0, 160),
      });
      return false;
    }
    if (atual == null) return false;

    // NUNCA encurta um silêncio maior já em vigor. `Infinity` (handoff formal)
    // vence qualquer prazo finito; uma janela mais longa que a nossa também.
    // Instante ilegível vira `null` e é tratado como "sem silêncio" — a leitura
    // conservadora seria não pausar, e ela deixaria a IA falando por cima do
    // humano, que é o defeito que este módulo existe para não ter.
    const silenciadaAte = normalizarInstante(
      (atual as { bot_silenced_until: string | null }).bot_silenced_until,
    );
    const atualMs =
      silenciadaAte === null
        ? Number.NEGATIVE_INFINITY
        : silenciadaAte instanceof Date
          ? silenciadaAte.getTime()
          : silenciadaAte;
    if (atualMs >= proposto.getTime()) return false;

    const { error: updErr } = await admin
      .from("conversations")
      .update({
        bot_silenced_until: proposto.toISOString(),
        last_handoff_at: agora.toISOString(),
        last_handoff_reason: MOTIVO,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId);

    if (updErr) {
      logger.warn("[atendimento-manual] pausa da IA não gravada", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: updErr.message.slice(0, 160),
      });
      return false;
    }

    logger.info("[atendimento-manual] IA pausada — pessoa respondeu pelo canal", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      canal: input.canal ?? "desconhecido",
      silenciada_ate: proposto.toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn("[atendimento-manual] pausa da IA lançou", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
    });
    return false;
  }
}

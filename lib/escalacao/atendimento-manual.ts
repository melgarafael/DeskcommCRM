/**
 * ATENDIMENTO MANUAL PELO CANAL — o dono pegou o celular e respondeu o cliente
 * direto no WhatsApp (ou por outra plataforma ligada à mesma conta). A IA para
 * NESSA conversa, para não responder junto — e fica parada até um humano
 * devolver o atendimento (`#on` pelo celular ou "devolver ao automático" na
 * tela).
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
 * ## Duração: DURÁVEL, não um prazo (decisão do dono, 2026-09-24)
 *
 * A primeira versão gravava `agora + 60 min` e o silêncio expirava sozinho. O
 * dono decidiu o contrário: uma resposta humana pelo celular significa "eu
 * assumo esta conversa", e a IA só volta quando ele mandar `#on` (ou clicar
 * "devolver ao automático" na tela). O silêncio agora é gravado com o MESMO
 * literal do handoff formal, `'infinity'` — `bot_silenced_until > now()` é sempre
 * verdadeiro.
 *
 * ## O defeito que a versão antiga tinha, e que este arquivo conserta
 *
 * O UPDATE de antes **não usava `.select()`**: com a linha já apagada, ou sob a
 * concorrência real que o `HANDOFF-silencio-retomada-humana-nao-gruda.md`
 * documenta, o PostgREST respondia `error: null` tendo afetado ZERO linhas — e a
 * função devolvia `true`, logava "IA pausada" e seguia. O bot nunca parou e a
 * tela nunca mostrou nada. Agora o UPDATE pede a linha de volta (`.select("id")`)
 * e ausência de linha é tratada como FALHA, com log — não como sucesso.
 *
 * ## O que grava, e o que NÃO grava
 *
 *   - `bot_silenced_until = 'infinity'`
 *   - `last_handoff_at` / `last_handoff_reason` — rastro visível de que uma
 *     pessoa assumiu por fora.
 *
 * **NÃO toca `contacts.ai_authorized_at`.** A origem/autorização do lead é
 * estado SEPARADO (elegibilidade), não handoff. Uma resposta manual pausa a
 * conversa; não apaga que o lead veio do Respondi.
 *
 * **NÃO toca `contacts.force_human`** (trava do CONTATO inteiro — pausar uma
 * conversa não é bloquear o cliente) nem `assignee_kind` (exige um
 * `assigned_to_user_id`, e o celular do dono não é necessariamente um usuário do
 * CRM) nem `status` (mandar para `pending` diria "na fila esperando atendente",
 * o oposto de "estou atendendo").
 *
 * Fire-and-forget do lado de quem chama: a ingestão da mensagem do cliente não
 * pode cair porque a pausa falhou.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizarInstante } from "@/lib/ai/elegibilidade/gate";
import { logger } from "@/lib/logger";

/**
 * O mesmo literal do handoff formal: `bot_silenced_until > now()` é sempre
 * verdadeiro. `normalizarInstante` o traduz para `Infinity`.
 */
export const SILENCIO_DURAVEL = "infinity";

/** Motivo gravado quando uma pessoa responde pelo canal, fora do CRM. */
export const MOTIVO_ATENDIMENTO_MANUAL = "Atendimento manual pelo canal (resposta fora do CRM)";

/**
 * Motivo gravado quando o operador manda `#off` do celular. Separado do motivo
 * acima de propósito: a tela e a trilha precisam distinguir "alguém respondeu à
 * mão" de "alguém desligou o automático com o comando".
 */
export const MOTIVO_COMANDO_OFF = "Comando #off enviado pelo celular";

export interface PausaDuravelInput {
  organizationId: string;
  conversationId: string;
  /** Rótulo da origem do evento, só para log (o adapter que chamou se identifica). */
  canal?: string;
  /** Texto gravado em `last_handoff_reason`. Default = motivo do atendimento manual. */
  motivo?: string;
  /**
   * O instante da fala humana. INJETADO para o teste não depender do relógio
   * real: o `now()` do banco e o `Date.now()` do processo são dois relógios, e
   * comparar um com o outro produz falha intermitente. Default = agora.
   */
  agora?: Date;
}

/**
 * Pausa a IA numa conversa de forma DURÁVEL (`'infinity'`), por uma pessoa ter
 * respondido por fora do CRM. Devolve `true` se gravou; `false` se já havia
 * silêncio durável em vigor, se a conversa não existe, ou se a escrita falhou.
 *
 * Idempotente por natureza: reexecutar sobre uma conversa já durável não faz
 * nada e devolve `false`.
 */
export async function pausarIaDuravelmente(
  admin: SupabaseClient,
  input: PausaDuravelInput,
): Promise<boolean> {
  const agora = input.agora ?? new Date();
  const motivo = input.motivo ?? MOTIVO_ATENDIMENTO_MANUAL;

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

    // `'infinity'` já em vigor (handoff formal ou pausa anterior): nada a fazer.
    // `normalizarInstante` traduz o literal do Postgres para `Infinity`; só ele
    // satisfaz a comparação abaixo, então um instante finito ou ilegível cai no
    // caminho de escrita (a leitura conservadora da versão antiga — data que não
    // dá para ler conta como "sem silêncio" e a pausa é reafirmada).
    const silenciadaAte = normalizarInstante(
      (atual as { bot_silenced_until: string | null }).bot_silenced_until,
    );
    const atualMs =
      silenciadaAte === null
        ? Number.NEGATIVE_INFINITY
        : silenciadaAte instanceof Date
          ? silenciadaAte.getTime()
          : silenciadaAte;
    if (atualMs >= Number.POSITIVE_INFINITY) return false;

    // `.select("id")` NÃO é decoração: sem ele, um UPDATE que afeta zero linhas
    // responde `error: null` e a função mentiria "pausei". É o conserto do
    // defeito relatado no handoff do silêncio que não gruda.
    const { data: atualizada, error: updErr } = await admin
      .from("conversations")
      .update({
        bot_silenced_until: SILENCIO_DURAVEL,
        last_handoff_at: agora.toISOString(),
        last_handoff_reason: motivo,
      })
      .eq("organization_id", input.organizationId)
      .eq("id", input.conversationId)
      .select("id")
      .maybeSingle();

    if (updErr) {
      logger.warn("[atendimento-manual] pausa da IA não gravada", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        detail: updErr.message.slice(0, 160),
      });
      return false;
    }
    if (atualizada == null) {
      // 0 linhas: o desfecho silencioso que este arquivo existe para não ter.
      logger.warn("[atendimento-manual] pausa da IA não afetou nenhuma linha", {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        canal: input.canal ?? "desconhecido",
      });
      return false;
    }

    logger.info("[atendimento-manual] IA pausada (durável) — atendimento humano pelo canal", {
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      canal: input.canal ?? "desconhecido",
      motivo,
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

/**
 * Atalho histórico para a resposta manual pelo canal. Mantido porque é o nome
 * que os canais (WAHA e Zernio) e os testes já conhecem — a regra vive em
 * `pausarIaDuravelmente`.
 */
export async function pausarIaPorAtendimentoManual(
  admin: SupabaseClient,
  input: Omit<PausaDuravelInput, "motivo">,
): Promise<boolean> {
  return pausarIaDuravelmente(admin, { ...input, motivo: MOTIVO_ATENDIMENTO_MANUAL });
}

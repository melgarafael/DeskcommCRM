/**
 * A LIGAÇÃO QUE FICA "TOCANDO" PARA SEMPRE — o prazo de saída (issue #3977).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `voice_calls` só sai de `starting`/`ringing` quando chega o evento de fim do
 * canal (`ChannelDestroyed`) ou quando alguém atende/recusa pela tela. O #3972
 * consertou a CAUSA mais comum (o UUID do AudioSocket não casava com o
 * `channel.id` do evento), mas o evento ainda pode se perder: se o worker de voz
 * está fora do ar — reinício, deploy, queda — no instante em que o canal cai,
 * ninguém processa o `ChannelDestroyed` e a linha fica `ringing` para sempre.
 *
 * O sintoma é o pior tipo para um produto que a pessoa instala sozinha: a tela
 * de Chamadas mostra uma ligação tocando desde ontem, e não há nada que a
 * destrave. Nas instalações que já viveram o defeito, as linhas presas ficam lá
 * — destravar à mão exigiria um `update` no banco, que ninguém vai fazer.
 *
 * ─── O que este módulo faz, e o que NÃO faz ─────────────────────────────────
 *
 *   - encerra (`status='ended'`) as linhas em `starting`/`ringing` mais velhas
 *     que o prazo, com o MOTIVO gravado em `end_reason`
 *     (`encerrada_por_prazo_sem_evento`) e `ended_at` preenchido — quem olhar a
 *     ligação depois precisa saber que não foi o cliente que desligou;
 *   - na primeira rodada depois da atualização, a MESMA varredura destrava as
 *     linhas que já estavam presas: não há passo de migração nem ação do
 *     operador, e não há estado novo para o banco conhecer (o `status` continua
 *     sendo o vocabulário do upstream);
 *   - **não toca em ligação atendida**: `connected` (e tudo que tem
 *     `answered_at`) está fora do recorte. Encerrar por idade uma conversa em
 *     andamento seria transformar um remédio em defeito pior que a doença;
 *   - **não inventa vocabulário no `status`**: só `ending`→`ended`, que já
 *     existe no CHECK. A granularidade vai em `end_reason`, a coluna livre.
 *
 * ─── O prazo: por que 15 minutos, e por que configurável ────────────────────
 *
 * Este repositório NÃO tem um timer de toque: medido, não existe constante de
 * ring timeout no worker de voz (`workers/voice-agent/`), no cliente ARI
 * (`lib/voip/`) nem no dialplan (`asterisk/extensions.conf`) — o toque acaba
 * quando quem liga desiste ou quando o provedor derruba a chamada. Os números
 * conhecidos vêm do lado de fora: a chamada de voz do WhatsApp toca por cerca de
 * 60 s antes de virar "sem resposta", e o Timer B do SIP (RFC 3261, 64×T1)
 * desiste da transação em 32 s. Um prazo de 15 min é ~15× o toque do WhatsApp e
 * ~28× o Timer B: nenhuma ligação viva chega perto, e quem fica preso sai da
 * tela no máximo uma batida depois do vencimento.
 *
 * O valor é lido de `VOICE_CALL_STUCK_AFTER_MIN` (default 15) porque instalação
 * com tronco lento — toque encaminhado para outro PBX, fila com música — pode
 * legitimamente tocar mais que o comum, e um prazo cravado no código faria o
 * conserto virar o defeito nessas instalações. Valor inválido NÃO derruba a
 * varredura: cai no padrão e o motivo aparece no log.
 *
 * ─── Por que `started_at` e não `updated_at` ────────────────────────────────
 *
 * A idade é medida por `started_at`, que ninguém reescreve. `updated_at` tem
 * gatilho (`trg_voice_calls_set_updated_at`) e muda a cada escrita: medir por
 * ele faria a linha rejuvenescer e escapar da varredura para sempre — a mesma
 * armadilha que o `recover-stuck-messages` documenta com `sent_at`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/**
 * O motivo gravado em `end_reason`. Distinto de `timeout` de propósito: o
 * `timeout` do upstream significa "o telefone tocou e ninguém atendeu" — um
 * FATO do provedor. Aqui o fato é outro: o CRM não sabe como a ligação acabou,
 * só sabe que o aviso de queda não chegou.
 */
export const MOTIVO_PRAZO_SEM_EVENTO = "encerrada_por_prazo_sem_evento";

/** Estados de antes de alguém atender. Só eles têm prazo de saída. */
export const ESTADOS_DE_TOQUE = ["starting", "ringing"] as const;

/**
 * Prazo padrão, em minutos. Ver o cabeçalho: acima do toque plausível de
 * qualquer provedor (WhatsApp ~60 s, Timer B do SIP 32 s) com folga de ordem de
 * grandeza.
 */
export const PRAZO_PADRAO_MIN = 15;

/**
 * Teto do que a configuração pode pedir. Um `525600` (um ano) transformaria o
 * prazo em decoração: a linha ficaria presa até a próxima atualização do
 * produto. Um dia é o máximo que ainda significa "varredura com prazo".
 */
export const PRAZO_MAXIMO_MIN = 24 * 60;

/** Teto por invocação — a rodada seguinte pega o resto. */
const TETO_POR_RODADA = 500;

export interface ResultadoDaVarredura {
  /** Linhas em toque mais velhas que o prazo, encontradas na rodada. */
  varridas: number;
  /** Linhas que ESTA rodada encerrou (a corrida pode levar algumas). */
  encerradas: number;
  /** Organizações com pelo menos uma linha encerrada agora. */
  organizacoes: number;
  /** Prazo efetivo da rodada, em minutos — vai para a auditoria. */
  prazo_min: number;
}

interface LinhaPresa {
  id: string;
  organization_id: string;
  status: string;
  started_at: string;
}

/**
 * Interpreta o valor cru de `VOICE_CALL_STUCK_AFTER_MIN`.
 *
 * Puro de propósito: quem chama decide o que fazer com `recusado`, e o teste
 * consegue exercitar cada borda sem mexer em `process.env`.
 */
export function interpretarPrazo(bruto: string | undefined): { minutos: number; recusado: string | null } {
  if (bruto === undefined || bruto.trim() === "") return { minutos: PRAZO_PADRAO_MIN, recusado: null };

  // Só dígitos, de propósito: `Number()` aceita `1e3` e `0x10`, que ninguém
  // escreve à mão num `.env` — e um `1e3` viraria 1000 minutos em silêncio.
  // O trim separa "não configurado" de "configurado errado".
  const limpo = bruto.trim();
  const numero = Number(limpo);
  if (!/^\d+$/.test(limpo) || numero <= 0) {
    return { minutos: PRAZO_PADRAO_MIN, recusado: `não é inteiro positivo: ${JSON.stringify(bruto)}` };
  }
  if (numero > PRAZO_MAXIMO_MIN) {
    return { minutos: PRAZO_MAXIMO_MIN, recusado: `acima do teto de ${PRAZO_MAXIMO_MIN} min: ${numero}` };
  }
  return { minutos: numero, recusado: null };
}

/** Prazo efetivo da rodada (lido a cada chamada, nunca no import do módulo). */
export function prazoDeEncerramentoMin(bruto: string | undefined = process.env.VOICE_CALL_STUCK_AFTER_MIN): number {
  const { minutos, recusado } = interpretarPrazo(bruto);
  if (recusado) {
    logger.warn("[ligacao-presa] VOICE_CALL_STUCK_AFTER_MIN recusada — usando o padrão", {
      valor: bruto,
      motivo: recusado,
      usando_min: minutos,
    });
  }
  return minutos;
}

/**
 * A rodada. Separada do handler HTTP para o teste exercitar a REGRA sem montar
 * request/auth — e para a rota ficar sendo só borda (mesmo desenho do
 * `recover-stuck-messages`).
 */
export async function encerrarLigacoesPresas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  agora: Date,
  requestId: string,
): Promise<ResultadoDaVarredura> {
  const prazoMin = prazoDeEncerramentoMin();
  const corte = new Date(agora.getTime() - prazoMin * 60_000).toISOString();

  const { data, error } = await supabase
    .from("voice_calls")
    .select("id, organization_id, status, started_at")
    .in("status", [...ESTADOS_DE_TOQUE])
    .lt("started_at", corte)
    .limit(TETO_POR_RODADA);

  if (error) throw new Error(`query_failed: ${error.message}`);

  const presas = (data ?? []) as LinhaPresa[];
  if (presas.length === 0) {
    return { varridas: 0, encerradas: 0, organizacoes: 0, prazo_min: prazoMin };
  }

  // Agrupado por organização porque o UPDATE é por organização: a lista de ids é
  // da rodada, mas o filtro de tenant vai junto — nenhuma escrita atravessa
  // organização, nem quando a varredura é global.
  const porOrg = new Map<string, string[]>();
  for (const linha of presas) {
    const ids = porOrg.get(linha.organization_id) ?? [];
    ids.push(linha.id);
    porOrg.set(linha.organization_id, ids);
  }

  let encerradas = 0;
  const orgsComEfeito: string[] = [];

  for (const [orgId, ids] of porOrg) {
    const { data: tocadas, error: erroDoUpdate } = await supabase
      .from("voice_calls")
      .update({
        status: "ended",
        end_reason: MOTIVO_PRAZO_SEM_EVENTO,
        ended_at: agora.toISOString(),
        updated_at: agora.toISOString(),
      })
      .in("id", ids)
      .eq("organization_id", orgId)
      // O filtro de status no UPDATE é o claim atômico: se alguém atendeu (ou o
      // `ChannelDestroyed` finalmente chegou) entre o SELECT e o UPDATE, a linha
      // já não está em toque e não é tocada. Sem isso, esta varredura encerraria
      // por baixo uma ligação que está acontecendo.
      .in("status", [...ESTADOS_DE_TOQUE])
      .select("id");

    if (erroDoUpdate) {
      logger.error("[ligacao-presa] update falhou", {
        error: erroDoUpdate.message,
        organization_id: orgId,
        requestId,
      });
      continue;
    }

    const quantas = ((tocadas ?? []) as { id: string }[]).length;
    if (quantas === 0) continue; // a corrida levou todas
    encerradas += quantas;
    orgsComEfeito.push(orgId);
  }

  return {
    varridas: presas.length,
    encerradas,
    organizacoes: orgsComEfeito.length,
    prazo_min: prazoMin,
  };
}

/**
 * Adapter fino que pluga `aplicaAvisoDeCaso` (`./aviso-ao-suporte.ts`) no
 * dispatcher genérico do `event_log` — mesmo padrão de
 * `lib/followup/gatilho-caso.handler.ts`: a lógica fica pura e testável, aqui só
 * há a ligação com o registry e os clients de produção.
 *
 * ⚠️ UM HANDLER PARA OS DOIS EVENTOS, e não dois. Abertura e fechamento são o
 * mesmo laço: um caso pode abrir às 23h e fechar às 23h05, e se o aviso estiver
 * represado pelo espaçamento a equipe receberia depois um recado sobre algo já
 * resolvido. Separar em dois consumidores abriria a porta para o dia em que só
 * um dos dois é registrado — e o pior desfecho possível aqui é o que avisa sem
 * nunca parar de avisar.
 *
 * ⚠️ O `status` NUNCA é `error`. `aplicaAvisoDeCaso` só devolve `ok`, `skipped`
 * e `retry`; o `catch` abaixo é a ÚNICA fonte de `error`, e ele existe para
 * defeito de PROGRAMA (um `select` com coluna errada, um client que não subiu),
 * nunca para estado de mundo. A diferença é o que separa "o dreno precisa
 * tentar de novo" de "não havia aviso configurado nesta organização" — e tratar
 * o segundo como o primeiro mataria o evento de todo caso de toda instalação
 * que nunca ligou o aviso.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { audit } from "@/lib/audit";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { env } from "@/lib/env";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  EVENTO_CASO_ABERTO,
  EVENTO_CASO_FECHADO,
  type TransporteDoAviso,
  aplicaAvisoDeCaso,
  createSupabaseAvisoDb,
} from "@/lib/escalacao/aviso-ao-suporte";

export const AVISO_DE_CASO_HANDLER_KEY = "escalacao-aviso-ao-suporte.v1";

export const avisoDeCasoAoSuporteHandler: EventHandler = {
  key: AVISO_DE_CASO_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_CASO_ABERTO, EVENTO_CASO_FECHADO],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const desfecho = await aplicaAvisoDeCaso(
        {
          db: createSupabaseAvisoDb(admin),
          // O transporte é resolvido em `lib/channels/` — este arquivo nunca
          // conhece provedor. O import é tardio para o topo não arrastar os
          // adapters para dentro do bundle de quem só registra o handler.
          transporte: await criarTransporteDoAviso(admin),
          pacing: await criarPacingDoCanal(admin),
          clock: () => new Date(),
          urlPublica: env.NEXT_PUBLIC_APP_URL,
          origemDoDreno,
          audita: (entrada) => {
            // Fire-and-forget, como todo audit do produto: a trilha nunca pode
            // segurar o efeito que ela registra.
            void audit({
              action: entrada.action,
              organizationId: entrada.organizationId,
              resourceType: "agent_case",
              resourceId: entrada.caseId,
              bypassedRls: true,
              metadata: entrada.metadata,
            });
          },
        },
        row,
      );
      return {
        consumer_key: AVISO_DE_CASO_HANDLER_KEY,
        status: desfecho.status,
        ...(desfecho.retry_at ? { retry_at: desfecho.retry_at } : {}),
        detail: desfecho.detail,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: AVISO_DE_CASO_HANDLER_KEY, status: "error", detail };
    }
  },
};

/**
 * O transporte, montado a partir do canal — sem nome de provedor fora de
 * `lib/channels/`.
 *
 * ⚠️ EXPORTADA porque a rota do botão "enviar aviso de teste" (onda 8) usa o
 * MESMO transporte. Duas montagens do mesmo envelope divergiriam no dia em que
 * uma delas ganhasse um campo — e a que ficasse para trás produziria um teste
 * verde sobre um caminho que o aviso real não percorre, que é o único desfecho
 * que aquele botão não pode ter.
 *

 * `getAdapter`, `resolveSessionRef` e `resolveRecipient` moram lá porque os três
 * precisam saber QUAL canal é; este arquivo só sabe que existe um envelope a
 * preencher. O import é TARDIO para o topo não arrastar os adapters de todos os
 * provedores para dentro do bundle de quem apenas registra o handler — e porque
 * `lib/event-log/drain-loop.ts` carrega este módulo por import dinâmico sob
 * `tsx`, onde um import de topo pesado já parou o dreno por dez dias (#648).
 */
export async function criarTransporteDoAviso(
  admin: ReturnType<typeof createAdminClient>,
): Promise<TransporteDoAviso> {
  const { getAdapter, resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS } = await import(
    "@/lib/channels"
  );

  /**
   * Uma leitura por canal, memoizada pelo id.
   *
   * O handler pergunta ao transporte três vezes (configurado, destino, envio) e
   * ir ao banco em cada uma seria três idas para a mesma linha. O memo vive só
   * enquanto este objeto vive — um por rodada do dreno, nunca de módulo: memo de
   * módulo guardaria a credencial de uma organização entre requisições.
   */
  const refs = new Map<string, { provider: string; sessionRef: string } | null>();
  async function refDoCanal(organizationId: string, canalId: string) {
    const chave = `${organizationId}:${canalId}`;
    if (refs.has(chave)) return refs.get(chave) ?? null;
    // ⚠️ `organization_id` filtrado À MÃO: o client é o de service role, que
    // BYPASSA a RLS. A organização vem da linha do `event_log`, não de um corpo.
    const { data } = await admin
      .from("channel_sessions")
      .select(CHANNEL_SESSION_REF_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("id", canalId)
      .maybeSingle();
    const linha = data as Parameters<typeof resolveSessionRef>[0] | null;
    const resolvido = linha
      ? { provider: linha.provider, sessionRef: resolveSessionRef(linha) }
      : null;
    refs.set(chave, resolvido);
    return resolvido;
  }

  return {
    async configurado(organizationId, canal) {
      const ref = await refDoCanal(organizationId, canal.id);
      if (!ref) return false;
      return getAdapter(ref.provider as never).isConfigured();
    },

    async resolveDestino(organizationId, canal, telefone) {
      const ref = await refDoCanal(organizationId, canal.id);
      if (!ref) return null;
      // O CHECK do banco já garantiu E.164 com `+`. Quem traduz para o endereço
      // do canal é o adapter — e é por isso que a tradução não mora aqui.
      return getAdapter(ref.provider as never).resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: telefone,
        waIdentity: null,
        waLid: null,
      });
    },

    async envia(organizationId, canal, to, body) {
      const ref = await refDoCanal(organizationId, canal.id);
      if (!ref) throw new Error("canal_sem_referencia_de_transporte");
      // TRANSPORTE DIRETO, fora do `sendMessageHandler`: o aviso NÃO nasce como
      // linha em `messages`. Ele não é uma mensagem do atendimento — não tem
      // conversa, não tem contato, não entra na timeline de ninguém — e gravá-lo
      // ali criaria uma conversa com o número da própria equipe, que é
      // exatamente o que o corte da ingestão existe para impedir.
      return getAdapter(ref.provider as never).send({
        organizationId,
        sessionRef: ref.sessionRef,
        to,
        kind: "text",
        body,
      });
    },
  };
}

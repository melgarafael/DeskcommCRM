"use client";
/**
 * A CONVERSA INTERNA DA EQUIPE COM A IA QUE ABRIU O CASO — o lado do cliente.
 *
 * ─── Por que CONSULTA PERIÓDICA e não realtime ─────────────────────────────
 *
 * A decisão do dono é "guardada e compartilhada": um colega que perguntou
 * precisa aparecer para quem está com a mesma tela aberta. O caminho não é
 * canal de realtime, e a razão é medida, não gosto:
 *
 *   · `agent_cases` e `agent_case_events` NÃO estão na publicação
 *     `supabase_realtime`, e a tabela nova também não — pô-la lá exigiria
 *     apêndice idempotente e uma policy de realtime que replicasse a RLS. Um
 *     erro ali entrega a conversa a quem a RLS nega, ou seja, a feature
 *     nasceria com a brecha que ela veio fechar.
 *   · O cookie de sessão é `httpOnly`: canal criado fora de
 *     `hooks/realtime/useRealtimeChannel.ts` assina, responde `SUBSCRIBED` e
 *     NÃO RECEBE NADA. É o modo de falha mudo que este repositório já pagou.
 *   · A resposta do próprio turno volta na requisição (não há streaming). O
 *     único evento que precisaria de push é "um colega perguntou agora" — que
 *     acontece em minutos, não em segundos.
 *
 * 15s e não os 60s de `useCases`: a janela em que duas pessoas olham o MESMO
 * caso é curta e o payload é pequeno. `refetchIntervalInBackground` fica no
 * default (`false`) — aba escondida não gasta chamada.
 *
 * ─── Por que a tela NÃO renderiza a partir da resposta do POST ─────────────
 *
 * O POST tem duas formas: a normal e a de REPLAY (quando o `turn_id` já
 * entrou — clique duplo, retentativa). Renderizar otimista obrigaria a tela a
 * conhecer as duas e a escolher entre elas. Invalidando a consulta, a thread
 * vem sempre do banco: uma forma só, e o que a pessoa lê é o que ficou
 * gravado.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import type { Citation } from "@/lib/ai/citations/types";
import type { CaseChatAuthorKind } from "@/lib/ai/conversa-do-caso/vocabulario";

/** Uma linha de `agent_case_chat_messages`, como o GET a projeta. */
export interface CaseChatMessage {
  id: string;
  /** Agrupa a pergunta e a resposta dela. */
  turn_id: string;
  author_kind: CaseChatAuthorKind;
  author_user_id: string | null;
  /** `null` quando a resposta falhou — ou quando a LGPD apagou. */
  body: string | null;
  /** `null` = deu certo. Não existe coluna `status`. */
  error_code: string | null;
  agent_id: string | null;
  service_stale: boolean;
  redacted_at: string | null;
  created_at: string;
}

/**
 * Quem respondeu, e por quê não foi o agente do caso.
 *
 * `fonte` é `string` e não uma união fechada de propósito: o valor vem do
 * servidor, e uma união aqui obrigaria a tela a quebrar no dia em que o
 * servidor ganhasse uma terceira fonte. Quem prende o vocabulário é o backend;
 * a tela compara com o que conhece e degrada no resto.
 */
export interface CaseChatPersona {
  fonte: string;
  nome: string | null;
  motivo: string | null;
}

/**
 * O que a tela precisa saber ANTES de oferecer o campo.
 *
 * Todos anuláveis, e isso é contrato: o GET degrada de forma honesta quando o
 * banco não responde — devolve as mensagens e `null` no que não deu para
 * medir. `null` significa DESCONHECIDO, nunca `false`.
 *
 * ⚠️ `cases_enabled` NÃO está aqui porque a rota não o devolve (medido no
 * disco, não no plano). Declarar um campo que o wire não promete é o defeito
 * que `hooks/ai/useCases.ts` documenta: a tela lê `undefined` e mostra o ramo
 * errado, com typecheck e suíte verdes.
 */
export interface CaseChatEstado {
  caso_obsoleto: boolean | null;
  contato_bloqueado: boolean | null;
  contato_anonimizado: boolean | null;
  status: string | null;
  /** Falso ⇒ a tela não oferece o clique: numa VPS nova ele sempre falharia. */
  ia_configurada: boolean | null;
}

export interface CaseChatData {
  mensagens: CaseChatMessage[];
  persona: CaseChatPersona | null;
  estado: CaseChatEstado;
}

export function useCaseChat(caseId: string | null) {
  return useQuery({
    queryKey: ["ai-case-chat", caseId],
    enabled: caseId !== null,
    refetchInterval: 15_000,
    // Uma conversa de outra pessoa devolve 404, e repetir não muda isso: a
    // recusa é de visibilidade, não de disponibilidade.
    retry: false,
    queryFn: () =>
      apiClient
        .get<{ data: CaseChatData }>(`/api/v1/ai/cases/${caseId}/chat`)
        .then((r) => r.data),
  });
}

/**
 * 90 segundos, e o número não é folga: o default de mutação é 30s
 * (`lib/api/client.ts`), e uma chamada de modelo com o caso inteiro no contexto
 * passa disso. Abortar no navegador não cancela nada no servidor — só joga fora
 * a resposta que estava a caminho, depois de a chamada já ter sido cobrada.
 *
 * O `turn_id` é gerado AQUI, no cliente, e é ele que dá a idempotência: a
 * unique `(organization_id, case_id, turn_id, author_kind)` transforma o
 * segundo envio do mesmo turno em replay, sem uma segunda chamada paga.
 *
 * ⚠️ O id sai de `randomId()`, nunca do gerador nativo de uuid: o navegador só
 * o expõe em contexto seguro, e uma VPS recém-instalada é acessada por
 * `http://IP` até o TLS subir. Ali a chamada nativa é um `TypeError` ANTES do
 * fetch — o painel morreria mudo justamente na instalação fresca. Quem guarda
 * isso é `lib/random-id.test.ts`, e foi ele que me pegou nesta onda.
 *
 * Esta prosa NÃO escreve o nome daquela função seguido de parêntese de
 * propósito: a régua casa o TEXTO do arquivo, comentários inclusive — escrevê-lo
 * aqui reprovaria o arquivo que faz a coisa CERTA.
 */
export function useAskCase() {
  const qc = useQueryClient();
  return useMutation({
    // A resposta do POST carrega os trechos do acervo ligados à pergunta (F3
    // da #1869); a tela os abre no painel logo depois de perguntar. Opcional:
    // o replay do mesmo `turn_id` (retry de 429/503 do `apiClient`) não os traz.
    mutationFn: ({ id, pergunta }: { id: string; pergunta: string }) =>
      apiClient
        .post<{
          data: { turn_id: string; citacoes?: Citation[] };
        }>(
          `/api/v1/ai/cases/${id}/chat`,
          { turn_id: randomId(), pergunta },
          { timeoutMs: 90_000 },
        )
        .then((r) => r.data),
    onSettled: (_data, _erro, vars) => {
      qc.invalidateQueries({ queryKey: ["ai-case-chat", vars.id] });
    },
  });
}

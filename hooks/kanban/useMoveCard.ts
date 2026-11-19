"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { liberarEcoLocal, marcarEcoLocal } from "@/lib/kanban/local-echo";
import { fundeRespostaNoCard } from "@/lib/kanban/owner";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Lead } from "@/lib/types/leads";
import type { BoardData } from "@/lib/kanban/types";

export interface MoveArgs {
  leadId: string;
  stageId: string;
  /**
   * A POSIÇÃO NA ETAPA DE DESTINO — opcional desde a página inteira do negócio
   * (#4151). Arrastar no quadro sempre a manda (o ponto entre dois cards está na
   * tela). Quem move pela página não tem a coluna: ele só conhece a etapa, e o
   * servidor posiciona pela régua de entrada (`posicaoDeEntradaNaEtapa`, #3461).
   * Ver `position_in_stage` em `moveLeadSchema`.
   */
  positionInStage?: number;
  expectedUpdatedAt: string;
  /**
   * Os campos que o diálogo de campos obrigatórios coletou (issue #1536) —
   * viajam NA MESMA escrita que muda a etapa, nunca num PATCH anterior.
   */
  customFields?: Record<string, unknown>;
  /** O motivo do ganho coletado pelo mesmo diálogo, quando o destino fecha. */
  wonReason?: string;
  /** O motivo da perda, quando o destino é a etapa de perda — na MESMA escrita (#917). */
  lostReason?: string;
}

/**
 * O arrasto que o servidor RECUSOU por `reabertura_cria_novo` (issue #1538) e
 * que tem porta: o funil é `novo_negocio`, o card encerrado continua encerrado,
 * e a saída é criar a nova tentativa. Guardada AQUI, no próprio hook do arrasto,
 * porque este é o único lugar que conhece os dois lados ao mesmo tempo — o card
 * que foi arrastado e a etapa que ele tentou alcançar (a retomada nasce justamente
 * na etapa em que o operador soltou o card).
 */
export interface RetomadaPendente {
  leadId: string;
  stageId: string;
}

/** O que a recusa `required_fields_missing` devolve para a tela abrir o diálogo. */
export interface RecusaDeCampos {
  /** Os argumentos originais do move — o diálogo só acrescenta o que coletou. */
  args: MoveArgs;
  faltando: { chave: string; rotulo: string; tipo?: string; opcoes?: { value: string; label: string }[] }[];
}

interface OpcoesDeMove {
  /**
   * A recusa de campos obrigatórios vira DIÁLOGO, não toast (issue #1536):
   * toast diz "deu errado" sem o que fazer; o diálogo pede só o que falta e
   * reenvia o MESMO move. Quem não passa esta opção (outros consumidores do
   * hook) cai no `showApiError` de sempre.
   */
  onCamposFaltando?: (recusa: RecusaDeCampos) => void;
  /**
   * A recusa `reabertura_cria_novo` (issue #1538) também vira diálogo: o funil
   * retoma como novo negócio, e a tela oferece criar a nova tentativa na etapa
   * em que o card foi solto. Sem esta opção, cai no toast de sempre.
   */
  onRetomada?: (retomada: RetomadaPendente) => void;
}

export function useMoveCard(pipelineId: string, opcoes: OpcoesDeMove = {}) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId] as const;

  return useMutation({
    mutationFn: async (args: MoveArgs) => {
      // Minha própria ação não pulsa: o card já se moveu sob o cursor.
      marcarEcoLocal(args.leadId);
      return apiClient.post<{ data: Lead }>(`/api/v1/leads/${args.leadId}/move`, {
        stage_id: args.stageId,
        // Omitida de propósito quando ausente: o servidor lê a etapa de destino
        // e posiciona (#4151). Mandar `undefined` não é o mesmo que mandar 0.
        ...(args.positionInStage !== undefined
          ? { position_in_stage: args.positionInStage }
          : {}),
        expected_updated_at: args.expectedUpdatedAt,
        ...(args.customFields ? { custom_fields: args.customFields } : {}),
        ...(args.wonReason !== undefined ? { won_reason: args.wonReason } : {}),
        ...(args.lostReason !== undefined ? { lost_reason: args.lostReason } : {}),
      });
    },
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey });
      const snapshot = qc.getQueryData<BoardData>(queryKey);
      if (snapshot) {
        qc.setQueryData<BoardData>(queryKey, {
          ...snapshot,
          leads: snapshot.leads.map((l) =>
            l.id === args.leadId
              ? {
                  ...l,
                  stage_id: args.stageId,
                  // A ENTRADA NA ETAPA também, quando a etapa muda: o gatilho
                  // da 0071 vai carimbar `stage_changed_at` agora, e sem isto
                  // a barra de etapas e o rodapé do card mostravam, até a
                  // resposta chegar, os dias da etapa ANTIGA na etapa nova.
                  ...(args.stageId !== l.stage_id
                    ? { stage_changed_at: new Date().toISOString() }
                    : {}),
                  ...(args.positionInStage !== undefined
                    ? { position_in_stage: args.positionInStage }
                    : {}),
                }
              : l,
          ),
        });
      }
      return { snapshot };
    },
    onSuccess: (res, args) => {
      // A ÚNICA RECONCILIAÇÃO DO ARRASTE (#4788) — e ela é do CARD, não do quadro.
      //
      // A resposta é o lead como o servidor o deixou, com o `updated_at` final.
      // Gravá-la aqui é o que fecha o #916 (o segundo arrasto manda o carimbo
      // novo, não o velho — 409) E o que dispensa reler o funil inteiro: o
      // servidor já mandou o estado autoritativo da linha que mudou. É também a
      // convergência: se a etapa que voltou for diferente da otimista (recusa
      // parcial, regra de entrada, reabertura), o `fundeRespostaNoCard` corrige
      // o card na tela sem nenhuma requisição a mais.
      qc.setQueryData<BoardData>(queryKey, (atual) =>
        atual
          ? {
              ...atual,
              leads: atual.leads.map((l) =>
                l.id === args.leadId ? fundeRespostaNoCard(l, res.data) : l,
              ),
            }
          : atual,
      );
    },
    onError: (err, args, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(queryKey, ctx.snapshot);
      // Relê em TODO erro, não só no 409. Rede caída, timeout ou 5xx podem
      // chegar DEPOIS de a rota já ter gravado o movimento: o snapshot devolve
      // o card à coluna antiga, e o evento de realtime desse lead cai na marca
      // de eco (useBoard o ignora). Sem esta releitura, a tela ficaria errada
      // até o próximo evento do funil. Erro é raro; o arraste que dá certo
      // continua sem reler (#4788).
      qc.invalidateQueries({ queryKey });
      if (err instanceof ApiError && err.code === "reabertura_cria_novo" && opcoes.onRetomada) {
        // NÃO toast: um "erro" genérico mentiria sobre uma recusa que tem
        // porta. O diálogo É a resposta — e ele leva a etapa que o operador
        // alvejou, para a retomada nascer no lugar certo. Vem ANTES do ramo de
        // campos: o servidor recusa a reabertura antes da régua de campos.
        opcoes.onRetomada({ leadId: args.leadId, stageId: args.stageId });
        return;
      }
      // O DIAGNÓGOSTO em vez do toast (issue #1536): a recusa traz em
      // `details.faltando` chave e rótulo de cada campo — é a tela que sabe
      // transformar isso em formulário, então quem move é quem decide como
      // perguntar. O rollback acima já devolveu o card; o reenvio parte do
      // MESMO `expected_updated_at`, porque a recusa veio antes de qualquer
      // escrita — não há segundo carimbo para recolher.
      const faltando = (err instanceof ApiError ? err.details?.faltando : undefined) as
        | RecusaDeCampos["faltando"]
        | undefined;
      if (err instanceof ApiError && err.status === 422 && Array.isArray(faltando) && faltando.length > 0) {
        if (opcoes.onCamposFaltando) {
          opcoes.onCamposFaltando({ args, faltando });
          return;
        }
      }
      showApiError(err);
    },
    onSettled: (_data, _err, args) => {
      // A marca fecha com a AÇÃO, não com o relógio: daqui em diante só a folga
      // curta do último evento da cascata (ver lib/kanban/local-echo.ts).
      liberarEcoLocal(args.leadId);
      // ─── AQUI NÃO SE RELE O QUADRO (#4788) ────────────────────────────────
      // Era esta linha, e só ela, que fazia TODO arraste recarregar o funil
      // INTEIRO: num funil com milhares de negócios é uma leitura completa da
      // rota do quadro (paginada, enriquecida por card) a cada card solto, e o
      // operador sente como "o card trava ao arrastar".
      //
      // O que a substitui já é autoritativo: o `onSuccess` funde a resposta do
      // servidor no card — etapa, posição, `updated_at`, `status` —, então a
      // releitura não traria nada que a tela já não tenha. O que chegar de
      // fora continua chegando pelo realtime, que reconcilia o quadro UMA vez
      // por rajada (hooks/kanban/useBoard.ts), e a rede de segurança
      // (`useRefetchDeSeguranca`) confere a assinatura na volta para a aba.
      //
      // Fail-safe preservado: quando o servidor NÃO confirma (qualquer erro), o
      // `onError` acima devolve o snapshot e relê — ali a releitura é
      // obrigatória, porque o estado do servidor é desconhecido.
    },
  });
}

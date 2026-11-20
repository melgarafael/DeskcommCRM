"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ehEcoLocal } from "@/lib/kanban/local-echo";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import type { BoardData } from "@/lib/kanban/types";

/**
 * Fetch board via API route (NOT direct supabase-js).
 *
 * Why: the auth cookie `sb-deskcomm-auth` is httpOnly so the browser Supabase
 * client cannot read it — auth.uid() ends up null, RLS hides the pipeline,
 * and PostgREST returns PGRST116. Routing through /api/v1/pipelines/[id]/board
 * uses the server-side cookie reader, identical to every other authed query.
 */
async function fetchBoard(pipelineId: string, leadPedido: string | null): Promise<BoardData> {
  // `?lead=` faz o recorte de encerrados antigos (#2995) manter o negócio que o
  // link pediu, para o dossiê dele abrir mesmo com a opção ligada.
  const qs = leadPedido ? `?lead=${encodeURIComponent(leadPedido)}` : "";
  const res = await apiClient.get<{ data: BoardData }>(
    `/api/v1/pipelines/${pipelineId}/board${qs}`,
  );
  // apiClient unwraps { data, meta } envelope already in some helpers;
  // ours returns the parsed JSON literally. Handle both shapes safely.
  if (res && typeof res === "object" && "data" in res) {
    return (res as { data: BoardData }).data;
  }
  return res as unknown as BoardData;
}

/**
 * Quanto tempo o card fica marcado como "acabou de chegar".
 *
 * NÃO é para bater com `--duration-slow` (320ms) do CSS, e a diferença é
 * DELIBERADA: com movimento normal a animação dura os 320ms e o resto da
 * janela é invisível; com `prefers-reduced-motion` o fundo estático fica os
 * 1200ms inteiros, que é o que torna a alternativa perceptível — 320ms de
 * fundo estático ninguém vê. Alinhar os dois números "para consertar a
 * divergência" apaga a pista de acessibilidade.
 */
const PULSE_MS = 1_200;

/**
 * O id do lead dentro do payload do postgres_changes (new, ou old no delete).
 */
function idDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { new?: { id?: unknown }; old?: { id?: unknown } };
  const id = p.new?.id ?? p.old?.id;
  return typeof id === "string" ? id : null;
}

/**
 * O FUNIL do evento, quando o payload o traz.
 *
 * O canal já assina com `filter: pipeline_id=eq.<funil>`, então na prática só
 * chega o que é deste quadro. Ler o campo mesmo assim é a guarda que não depende
 * do servidor ter aplicado o filtro: um canal sem filtro (versão antiga da
 * peça, `REPLICA IDENTITY` mexida) entregaria o funil do vizinho, e reconciliar
 * o quadro inteiro por causa de outro funil é exatamente o custo que a #4788
 * manda tirar do caminho.
 */
function funilDoEvento(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { new?: { pipeline_id?: unknown }; old?: { pipeline_id?: unknown } };
  const funil = p.new?.pipeline_id ?? p.old?.pipeline_id;
  return typeof funil === "string" ? funil : null;
}

/**
 * A JANELA DA RAJADA (#4788): o tempo quieto que fecha um lote de eventos.
 *
 * Uma única ação do produto gera VÁRIAS linhas de `postgres_changes` — o
 * `UPDATE` do movimento, o carimbo de `last_activity_at` da atividade, o
 * fechamento que muda `status` — e cada uma delas reinvalidava o quadro. Num
 * funil com milhares de negócios, dez eventos em 300 ms eram dez leituras do
 * funil inteiro, cada uma enriquecida card a card: é o "quadro lento" da issue.
 *
 * 250 ms é curto o bastante para o operador não perceber atraso (o alvo do
 * produto é ~250 ms de reconciliação entre usuários) e largo o bastante para
 * caber a cascata inteira de um arrasto.
 */
export const JANELA_DA_RAJADA_MS = 250;

/**
 * O TETO da rajada, e não um detalhe.
 *
 * Debounce que só reinicia vira fome: num funil movimentado (ou durante um
 * bulk de mil cards) sempre há um evento novo dentro da janela, o timer é
 * sempre adiado e o quadro NUNCA reconcilia — a tela congela em silêncio, que é
 * o pior desfecho possível para uma peça de frescor. Com o teto, a primeira
 * leitura sai no máximo 1 s depois do primeiro evento do lote, mesmo sob
 * tempestade; o resto do lote entra na leitura seguinte.
 */
export const TETO_DA_RAJADA_MS = 1_000;

/**
 * A CHAVE DE CACHE DO QUADRO — uma só, e exportada.
 *
 * `useMotivosDePerdaDoFunil` lê o quadro pela cache em vez de buscar de novo. Com
 * a chave escrita como literal nos dois lados, mudar a daqui faria aquele hook
 * devolver `[]` em silêncio — a janela de perder voltaria ao padrão do produto,
 * que é exatamente o defeito da #918, e os testes continuariam verdes porque
 * cada um escreve a sua própria literal.
 */
export function chaveDoQuadro(pipelineId: string | null) {
  return ["board", pipelineId] as const;
}

/**
 * A LEITURA DO QUADRO ACONTECE SÓ QUANDO ALGUÉM OLHA O QUADRO (#3172, item 4 do
 * CR). `enabled: false` não é cache morno nem consulta adiada: é a leitura do
 * funil INTEIRO que não sai — nem a query, nem o canal de realtime, nem a rede
 * de segurança que a acompanha.
 *
 * É o que deixa a aba Lista abrir num funil com milhares de negócios: `select
 * *` em `crm_leads` com a visibilidade por linha avaliada em cada card é
 * justamente a leitura que estoura o `statement_timeout` do papel
 * `authenticated`, e a lista existe para não pagá-la.
 *
 * O padrão é `true` porque há dois consumidores além da página do funil
 * (`KanbanBoard`, com este hook para o quadro embutido), e nenhum deles quer
 * "não ler" por omissão.
 */
export function useBoard(
  pipelineId: string | null,
  leadPedido: string | null = null,
  opcoes?: { enabled?: boolean },
) {
  const qc = useQueryClient();
  const queryKey = useMemo(() => chaveDoQuadro(pipelineId), [pipelineId]);
  const ativo = !!pipelineId && (opcoes?.enabled ?? true);

  /**
   * Cards que acabaram de mudar POR EVENTO REMOTO — o pulso da Wave 3.
   *
   * Só entra aqui o que veio de fora: a própria ação já tem feedback (o card se
   * move sob o cursor) e pulsar nela seria ruído com cara de novidade. Cada id
   * sai sozinho depois de PULSE_MS: o pulso acontece UMA vez e cessa, em vez de
   * virar destaque persistente.
   */
  const [pulses, setPulses] = useState<Map<string, number>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /**
   * A RECONCILIAÇÃO DO LOTE (#4788).
   *
   * Uma rajada de eventos do MESMO funil vira UMA releitura do quadro — nunca
   * uma por evento. `inicioDoLote` guarda o instante do primeiro evento ainda não
   * atendido, e é ele que dá o teto: sem isso, um fluxo contínuo de eventos
   * adiaria o timer para sempre e a tela pararia de acompanhar o servidor.
   */
  const reconciliacao = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inicioDoLote = useRef<number | null>(null);

  const agendarReconciliacao = useCallback(() => {
    const agora = Date.now();
    if (inicioDoLote.current === null) inicioDoLote.current = agora;
    const ateOTeto = TETO_DA_RAJADA_MS - (agora - inicioDoLote.current);
    const atraso = Math.max(0, Math.min(JANELA_DA_RAJADA_MS, ateOTeto));

    if (reconciliacao.current) clearTimeout(reconciliacao.current);
    reconciliacao.current = setTimeout(() => {
      reconciliacao.current = null;
      inicioDoLote.current = null;
      void qc.invalidateQueries({ queryKey });
    }, atraso);
  }, [qc, queryKey]);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchBoard(pipelineId as string, leadPedido),
    enabled: ativo,
    // Com o staleTime global de 30 s (lib/query/client.ts), um quadro fresco no
    // cache seria entregue sem buscar, e o `?lead=` não chegaria à rota. A chave
    // NÃO leva o lead: useMoveCard, KanbanBoard e useMotivosDePerdaDoFunil
    // leem e escrevem a chave exata.
    refetchOnMount: leadPedido ? "always" : true,
  });

  const onChange = useCallback(
    (payload: unknown) => {
      // ─── EVENTO DE OUTRO FUNIL NÃO É ASSUNTO DESTE QUADRO (#4788) ────────
      // A guarda é do payload, e não da assinatura do canal: quem entrega o
      // evento não é quem decide se ele interessa a esta tela.
      const funil = funilDoEvento(payload);
      if (funil !== null && funil !== pipelineId) return;

      const leadId = idDoEvento(payload);
      // Eco da MINHA ação: o cache já tem o estado autoritativo (o `onSuccess`
      // do move fundiu a resposta do servidor), então reler o funil aqui seria
      // pagar de novo por uma leitura que acabou de ser respondida. O pulso
      // também não entra — a ação local tem o feedback dela.
      const eco = leadId !== null && ehEcoLocal(leadId);

      if (!eco) agendarReconciliacao();

      if (!leadId || eco) return;

      // CONTADOR, não booleano. Com um Set, o segundo evento remoto no mesmo
      // card dentro da janela não mudava nada: o id já estava lá, a classe
      // nunca saía do elemento e a animação CSS não reinicia sem a classe
      // sair — pior, o timeout do primeiro evento apagava tudo no meio do
      // segundo. Chegava coisa de fora e a tela não dizia nada, que é o pecado
      // que esta peça existe para matar.
      setPulses((atual) => {
        const proximo = new Map(atual);
        proximo.set(leadId, (proximo.get(leadId) ?? 0) + 1);
        return proximo;
      });

      // Cada evento reinicia a contagem: a janela é do ÚLTIMO evento.
      const anterior = timers.current.get(leadId);
      if (anterior) clearTimeout(anterior);
      timers.current.set(
        leadId,
        setTimeout(() => {
          timers.current.delete(leadId);
          setPulses((atual) => {
            if (!atual.has(leadId)) return atual;
            const proximo = new Map(atual);
            proximo.delete(leadId);
            return proximo;
          });
        }, PULSE_MS),
      );
    },
    [agendarReconciliacao, pipelineId],
  );

  // O STATUS DO CANAL NÃO PODE SER DESCARTADO. `useRealtimeChannel` calcula
  // SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED e, sem atribuir o retorno,
  // esse valor morria na linha seguinte — enquanto ele é o único que separa
  // DUAS FAMÍLIAS INTEIRAS de causa: "a assinatura morreu" e "nada aconteceu"
  // têm exatamente a mesma aparência na tela, que é silêncio.
  //
  // Assinatura que morre calada é peça sem sinal de vida: o "log morto" do
  // checklist do sistema vivo, na versão cara, porque a tela continua parecendo
  // certa enquanto o board já não escuta mais nada.
  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
    name: pipelineId ? `kanban-${pipelineId}` : "kanban-disabled",
    postgresChanges: pipelineId
      ? {
          event: "*",
          schema: "public",
          table: "crm_leads",
          filter: `pipeline_id=eq.${pipelineId}`,
        }
      : undefined,
    onChange,
    enabled: ativo,
  });

  // Timers pendentes morrem com o componente — senão um setState chega depois
  // do unmount e o React reclama (e o Map de timers vaza). A releitura do lote
  // entra na mesma limpeza: um `invalidateQueries` agendado que dispara depois
  // do unmount é rede pendurada sem tela para redesenhar.
  useEffect(() => {
    const pendentes = timers.current;
    return () => {
      for (const t of pendentes.values()) clearTimeout(t);
      pendentes.clear();
      if (reconciliacao.current) clearTimeout(reconciliacao.current);
      reconciliacao.current = null;
      inicioDoLote.current = null;
    };
  }, []);

  // Trocar de funil no mesmo componente não pode arrastar a rajada do funil
  // ANTERIOR: o lote pendente releia a chave velha e some com ele.
  useEffect(() => {
    return () => {
      if (reconciliacao.current) clearTimeout(reconciliacao.current);
      reconciliacao.current = null;
      inicioDoLote.current = null;
    };
  }, [queryKey]);

  // A REDE DE SEGURANÇA. Sem ela, um canal que para de entregar deixa o board
  // congelado num passado que parece presente — e nem voltar para a aba
  // conserta. A assinatura é a contagem de leads mais o maior `updated_at`: é
  // sensível a exatamente o que o canal deveria ter trazido (lead novo, lead
  // movido, lead editado) e barata de calcular a cada verificação.
  const seguranca = useRefetchDeSeguranca<BoardData>({
    queryKey,
    assinatura: (d) => {
      const leads = d?.leads ?? [];
      let maior = "";
      for (const l of leads) {
        const u = (l as { updated_at?: string }).updated_at ?? "";
        if (u > maior) maior = u;
      }
      return `${leads.length}:${maior}`;
    },
    ultimaEntrega,
    enabled: ativo,
  });

  return { ...query, pulses, realtimeStatus, seguranca };
}

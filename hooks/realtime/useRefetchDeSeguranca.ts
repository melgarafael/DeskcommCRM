"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * O REFETCH DE SEGURANÇA — uma peça com três papéis.
 *
 *  1. CURA a perda. Hoje, quando o realtime deixa de entregar, board e dossiê
 *     NUNCA se recuperam — nem ao voltar para a aba. A tela fica congelada num
 *     passado que parece presente, e só um F5 conserta. Aqui ela volta sozinha.
 *
 *  2. DETECTA a falha. Se o refetch traz um estado DIFERENTE do que está na
 *     tela e o canal não entregou nada no intervalo, alguma coisa se perdeu no
 *     caminho. Essa é a única forma de saber que a entrega morreu — e é a
 *     resposta ao único achado do dia que atravessou três retratações intacto:
 *     **quando a entrega morre, nenhuma tela avisa**.
 *
 *  3. DESTRAVA a cerca. Uma verificação que só sabe dizer "o dado não chegou"
 *     só consegue REPROVAR: sem o sinal "houve entrega recente?", divergência é
 *     indistinguível de "nada aconteceu no intervalo".
 *
 * ⚠️ E ELE TEM UMA VANTAGEM QUE O REALTIME NÃO TEM: não pode nascer anônimo nem
 * morrer calado. É requisição com resposta — ou volta, ou dá erro. O canal
 * responde SUBSCRIBED e pode nunca entregar nada, em silêncio, e foi
 * exatamente isso que custou o dia.
 */

export interface RefetchDeSeguranca {
  /** Quantas vezes o refetch trouxe novidade que o canal não tinha entregue. */
  divergencias: number;
  /** Instante da última divergência — null enquanto tudo bate. */
  ultimaDivergencia: number | null;
  /** Quando o refetch rodou pela última vez. */
  ultimaVerificacao: number | null;
}

interface Opts<T> {
  queryKey: readonly unknown[];
  /**
   * O que caracteriza o estado da tela — contagem, maior `updated_at`, o que
   * mudar quando algo muda. NÃO precisa ser o dado inteiro: precisa ser
   * sensível ao que o realtime deveria ter trazido.
   */
  assinatura: (dado: T | undefined) => string;
  /**
   * A REF do instante da última entrega do canal (de `useRealtimeChannel`).
   *
   * Ref e não valor porque a leitura acontece dentro do timer, e o timer roda
   * fora do render: um valor capturado no render estaria congelado no instante
   * errado — exatamente na janela entre a entrega e o redesenho, que é quando
   * este detector dispara.
   */
  ultimaEntrega: RefObject<number | null>;
  /** De quanto em quanto tempo conferir. */
  intervaloMs?: number;
  enabled?: boolean;
}

/**
 * ⚠️ NÃO É "só um refetch periódico com outro nome". A diferença é o
 * COMPARADOR: um refetch periódico esconde a perda (o dado volta e ninguém sabe
 * que faltou); este a DENUNCIA, porque compara o antes com o depois e sabe se o
 * canal tinha entregue algo no meio.
 *
 * Curar sem detectar seria pior que o estado atual — a falha vira invisível
 * em vez de visível-tarde, e ninguém consertaria a causa.
 */
export function useRefetchDeSeguranca<T>({
  queryKey,
  assinatura,
  ultimaEntrega,
  intervaloMs = 45_000,
  enabled = true,
}: Opts<T>): RefetchDeSeguranca {
  const qc = useQueryClient();
  const [estado, setEstado] = useState<RefetchDeSeguranca>({
    divergencias: 0,
    ultimaDivergencia: null,
    ultimaVerificacao: null,
  });
  // Ref para o efeito não re-montar a cada render e o intervalo não reiniciar
  // — reiniciar adiaria a verificação para sempre numa tela que redesenha.
  //
  // A escrita mora num efeito, não no corpo do render: render pode ser
  // descartado ou reexecutado pelo React 19, e escrever ali é efeito colateral
  // que ninguém rastreia. Como quem lê é o timer (depois do render, sempre), a
  // ref já está atualizada quando importa.
  const assinaturaRef = useRef(assinatura);
  useEffect(() => {
    assinaturaRef.current = assinatura;
  }, [assinatura]);

  const verificar = useCallback(async () => {
    const antes = assinaturaRef.current(qc.getQueryData<T>(queryKey));

    await qc.refetchQueries({ queryKey, exact: true });

    const depois = assinaturaRef.current(qc.getQueryData<T>(queryKey));

    setEstado((prev) => {
      // O CRITÉRIO, em duas perguntas:
      //   a tela mudou depois de reler o servidor?          → `mudou`
      //   o canal trouxe alguma coisa desde a última vez?   → `canalTrouxe`
      //
      // Mudou E o canal não trouxe nada = ele PERDEU. Se o canal trouxe, a
      // mudança tem dono e não há divergência: a tela mudou porque foi avisada.
      //
      // A primeira versão comparava com `entregaAntes!` e um `null` fazia a
      // comparação virar `>= 0`, que é sempre verdadeira — o detector acusaria
      // divergência em toda mudança legítima, e um detector que grita sempre é
      // desligado na primeira semana.
      const mudou = depois !== antes;
      const entrega = ultimaEntrega.current;
      const canalTrouxe =
        entrega !== null && (prev.ultimaVerificacao === null || entrega > prev.ultimaVerificacao);
      const perdeu = mudou && !canalTrouxe;
      return {
        divergencias: perdeu ? prev.divergencias + 1 : prev.divergencias,
        ultimaDivergencia: perdeu ? Date.now() : prev.ultimaDivergencia,
        ultimaVerificacao: Date.now(),
      };
    });
    // `ultimaEntrega` é ref (identidade estável): entra na lista por higiene,
    // sem recriar o callback nem reiniciar o intervalo.
  }, [qc, queryKey, ultimaEntrega]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      // ABA OCULTA NÃO CONFERE (issue #2235): ninguém está vendo a tela, e a
      // conferência custa payload de página — o inbox esquecido refazia
      // conversas e mensagens a cada 45 s. É a convenção da casa: presença,
      // voz, alertas e `InterfaceRefresh` já pulam o trabalho de rede com a aba
      // escondida, e o refetch de segurança era o único sem a guarda.
      if (document.visibilityState !== "visible") return;
      void verificar();
    }, intervaloMs);

    // AO VOLTAR PARA A ABA, imediatamente: é o momento em que o usuário mais
    // acredita no que vê, e é justamente quando a tela pode estar mais velha —
    // o socket cai em aba de fundo e ninguém avisa. É também o que faz a pausa
    // acima não custar nada: o que ficou para trás é conferido na volta.
    const aoVoltar = () => {
      if (document.visibilityState === "visible") void verificar();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", aoVoltar);
    };
  }, [enabled, intervaloMs, verificar]);

  return estado;
}

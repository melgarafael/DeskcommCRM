"use client";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { createClient, prepareRealtimeAuthentication } from "@/lib/supabase/browser";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type RealtimeStatus =
  | "connecting"
  | "subscribed"
  | "channel_error"
  | "timed_out"
  | "closed";

export interface UseRealtimeChannelOpts {
  name: string;
  postgresChanges?: {
    event: "INSERT" | "UPDATE" | "DELETE" | "*";
    schema?: string;
    table: string;
    filter?: string;
  };
  broadcast?: { event: string };
  onChange: (payload: unknown) => void;
  enabled?: boolean;
}

/**
 * ONDE MORA A AUTENTICAÇÃO DESTE CANAL — não é aqui, e isso é o conserto.
 *
 * Este hook já teve um bloco que buscava o token e chamava
 * `supabase.realtime.setAuth(token)` antes de cada `subscribe`, com memo,
 * corrida contra um teto de 4s e remontagem quando o token chegava atrasado.
 * Tudo isso existia para compensar o cookie httpOnly, que deixa o supabase-js
 * do browser sem enxergar a sessão.
 *
 * ⚠️ AQUELE BLOCO PAROU DE FUNCIONAR NUM BUMP DE DEPENDÊNCIA, e ficou verde.
 * A partir do realtime-js 2.112.x a callback `accessToken` do client vence o
 * token manual — a própria biblioteca documenta isso — e a callback PADRÃO,
 * sem sessão visível, devolve a anon key. Medido no socket: o token do usuário
 * durava ~2ms, e todo canal criado depois joinava anônimo. Anônimo assina,
 * responde SUBSCRIBED e não recebe nada, porque a RLS filtra do outro lado.
 *
 * Os testes não pegaram porque exercitavam `authenticateRealtime` contra um
 * cliente FAKE: provavam que `setAuth` era CHAMADO, e o que quebrou foi o
 * EFEITO de chamá-lo. Guardar a chamada em vez do comportamento é o que os
 * deixou verdes enquanto o inbox não atualizava.
 *
 * A fonte do token agora é única e mora em `lib/supabase/browser.ts`, na
 * callback que o socket chama sozinho — no join, em cada reconexão e a cada
 * heartbeat. Duas fontes de token eram o defeito; não se conserta somando uma
 * terceira.
 */
export function useRealtimeChannel(opts: UseRealtimeChannelOpts): {
  status: RealtimeStatus;
  /**
   * Instante da última entrega deste canal (`.current` é null se nunca entregou).
   *
   * ⚠️ DEVOLVE A REF, NÃO O VALOR, e isso é correção e não estilo: ler
   * `.current` aqui no render entregaria um número CONGELADO naquele render —
   * a ref muda depois e nada redesenha, então quem recebeu ficaria com carimbo
   * velho até algo mais causar um render. Funcionava por acidente (a query
   * redesenha ao invalidar), e falharia justamente na janela entre a entrega e
   * esse redesenho, que é onde o detector de perda dispara.
   *
   * Virar `useState` resolveria a propagação e criaria pior: o valor entra nas
   * dependências do efeito e o canal RE-ASSINA a cada evento, perdendo eventos
   * na reassinatura. Quem lê isto é um timer — roda fora do render e enxerga
   * `.current` sempre fresco.
   */
  ultimaEntrega: RefObject<number | null>;
} {
  const { name, postgresChanges, broadcast, onChange, enabled = true } = opts;

  // ref makes onChange identity-stable so changing handler doesn't re-subscribe
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /**
   * QUANDO este canal entregou algo pela última vez.
   *
   * Existe para o refetch de segurança poder responder "houve entrega
   * recente?" — sem esse sinal, uma diferença entre o que o servidor tem e o
   * que a tela mostra é indistinguível de "nada aconteceu no intervalo", e a
   * checagem só consegue REPROVAR, nunca aprovar.
   *
   * `useRef` e não `useState` porque virar dependência de efeito faria o canal
   * re-assinar a cada evento, perdendo eventos na janela da reassinatura. A
   * ref ATRAVESSA a fronteira do hook em vez de ser lida aqui — ver o tipo de
   * retorno, onde está por que ler `.current` no render seria defeito.
   */
  const ultimaEntrega = useRef<number | null>(null);

  const [status, setStatus] = useState<RealtimeStatus>(enabled ? "connecting" : "closed");

  // React 19 strict mode mounts effects twice in dev. If two consumers ever
  // share the same logical channel name (or the same component re-mounts),
  // Supabase reuses the existing channel object — calling `.on()` after the
  // prior `.subscribe()` errors out. Append a stable per-instance suffix so
  // every hook call owns its own channel topology.
  const instanceId = useId();

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    const supabase = createClient();
    const channelName = `${name}::${instanceId}`;

    const handler = (payload: unknown) => {
      // Carimba ANTES de entregar: se o consumidor lançar, a entrega ainda
      // aconteceu — e o refetch de segurança precisa saber disso para não
      // acusar o canal de ter perdido o que ele trouxe.
      ultimaEntrega.current = Date.now();
      onChangeRef.current(payload);
    };

    // `active` guarda o canal VIGENTE. Cada tentativa cria um objeto novo, e a
    // comparação `active !== novo` nos callbacks descarta o que sobrou de uma
    // tentativa anterior — sem ela, um canal velho que responde tarde
    // sobrescreveria o estado do canal que já está de pé.
    let active: RealtimeChannel | null = null;
    let cancelado = false;
    let tentativas = 0;
    let retomada: ReturnType<typeof setTimeout> | null = null;
    setStatus("connecting");

    /**
     * Monta o canal do zero e assina.
     *
     * DO ZERO, e não `subscribe()` de novo no mesmo objeto: um canal que entrou
     * em erro não volta — o socket já derrubou a topologia dele, e reassinar o
     * mesmo objeto devolve SUBSCRIBED sem nunca mais entregar. Morte silenciosa,
     * a mesma classe de defeito que a memo de auth já tinha aqui.
     */
    const agendarRetomada = () => {
      if (cancelado) return;
      const espera = Math.min(30_000, 1_000 * 2 ** tentativas);
      tentativas++;
      if (retomada) clearTimeout(retomada);
      retomada = setTimeout(() => {
        if (cancelado) return;
        if (active) supabase.removeChannel(active);
        montar();
      }, espera);
    };
    const montar = async () => {
      if (cancelado) return;
      try {
        await prepareRealtimeAuthentication();
      } catch {
        if (cancelado) return;
        setStatus("channel_error");
        agendarRetomada();
        return;
      }
      if (cancelado) return;

      let novo: RealtimeChannel = supabase.channel(`${channelName}#${tentativas}`);
      if (postgresChanges) {
        novo = novo.on(
          "postgres_changes",
          {
            event: postgresChanges.event,
            schema: postgresChanges.schema ?? "public",
            table: postgresChanges.table,
            ...(postgresChanges.filter ? { filter: postgresChanges.filter } : {}),
          },
          handler,
        );
      }
      if (broadcast) novo = novo.on("broadcast", { event: broadcast.event }, handler);
      active = novo;

      // Bootstrap concluído antes do primeiro join; a callback do client mantém
      // a renovação. Nenhum canal anônimo nasce enquanto o token está em voo.
      novo.subscribe((s) => {
        if (cancelado || active !== novo) return;
        // s is one of "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED"
        const map: Record<string, RealtimeStatus> = {
          SUBSCRIBED: "subscribed",
          CHANNEL_ERROR: "channel_error",
          TIMED_OUT: "timed_out",
          CLOSED: "closed",
        };
        setStatus(map[s] ?? "connecting");

        if (s === "SUBSCRIBED") {
          // Voltou depois de ter caído. O que aconteceu enquanto ele estava
          // morto NÃO vai chegar — o Realtime não guarda nada para entregar
          // depois. Uma entrega sintética força quem escuta a buscar de novo,
          // e é ela que fecha o buraco de verdade: sem isso o canal volta a
          // funcionar para o PRÓXIMO evento e a tela segue sem o anterior.
          if (tentativas > 0) {
            tentativas = 0;
            handler({ tipo: "reassinado" });
          }
          return;
        }

        if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          // Antes daqui não havia NADA: o estado era anotado e o canal ficava
          // morto até a pessoa recarregar a página. Foi o sintoma relatado —
          // "às vezes preciso atualizar para a mensagem aparecer".
          //
          // Recuo exponencial com teto de 30s: reconectar em rajada contra um
          // socket que caiu por sobrecarga piora a sobrecarga, e o teto evita
          // que uma queda longa deixe a espera em minutos.
          agendarRetomada();
        }
      });
    };

    montar();

    return () => {
      cancelado = true;
      if (retomada) clearTimeout(retomada);
      if (active) {
        supabase.removeChannel(active);
        active = null;
      }
    };
    // intentionally omit onChange (ref); only re-subscribe when channel topology changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, enabled, instanceId, postgresChanges?.event, postgresChanges?.table, postgresChanges?.filter, postgresChanges?.schema, broadcast?.event]);

  return { status, ultimaEntrega };
}

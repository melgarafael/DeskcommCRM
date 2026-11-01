"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { useEffect, useMemo } from "react";
import { useT } from "@/hooks/i18n/useT";
import { format, isToday, isYesterday } from "date-fns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./MessageBubble";
import { separarReacoes } from "@/lib/inbox/reacoes-no-fio";
import { NoteCard } from "./NoteCard";
import { PassagemCard } from "./PassagemCard";
import { useThreadAutoScroll } from "@/hooks/inbox/useThreadAutoScroll";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useConversationNotes } from "@/hooks/inbox/useConversationNotes";
import { usePassagensDaConversa } from "@/hooks/inbox/usePassagensDaConversa";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useDeleteNote } from "@/hooks/inbox/useDeleteNote";
import { useAlterarMensagem } from "@/hooks/inbox/useAlterarMensagem";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { capabilitiesOf, transportaMensagem, type ChannelProvider } from "@/lib/channels/capabilities";
import { montarCartoesDaPassagem, type CartaoDaPassagem } from "@/lib/escalacao/cartao-da-passagem";
import type { Message, Note } from "@/lib/types/messaging";

interface Props {
  conversationId: string | null;
  searchTerm?: string;
  provider?: string | null;
  /** Escolher uma mensagem para responder. Sobe até o composer. */
  onResponder?: (m: Message) => void;
  /** Escolher uma mensagem para encaminhar a outra conversa (#2835). */
  onEncaminhar?: (m: Message) => void;
  /**
   * Quem é o dono da conversa HOJE, e quem é o contato.
   *
   * O cartão da passagem precisa dos dois para escolher o gesto: sem dono ele
   * convida a assumir; com outro dono ele diz quem atende (oferecer "assumir"
   * ali seria oferecer um gesto que a rota recusa); e o caminho de opt-out leva
   * à ficha do contato, que é onde mora o bloqueio.
   *
   * Opcional para o fio continuar renderizável sem a conversa em mãos — o
   * cartão então cai no estado mais conservador (nenhum convite).
   */
  dono?: { userId: string | null; nome: string | null } | null;
  contatoId?: string | null;
}

/**
 * Onda 5.2: union de item do thread — mensagem real ou nota interna (nunca vai
 * ao cliente). A passagem é o TERCEIRO tipo: também não é mensagem, também não
 * vai ao cliente, e entra no fio pelo mesmo mecanismo.
 */
export type ThreadItem =
  | { kind: "message"; ts: string; data: Message }
  | { kind: "note"; ts: string; data: Note }
  | { kind: "passagem"; ts: string; data: CartaoDaPassagem };

/** Intercala mensagens, notas e passagens por timestamp asc (puro, sem I/O — testado em thread-merge.test.ts). */
export function mergeThreadItems(
  messages: Message[],
  notes: Note[],
  // Opcional porque o fio existe desde antes da passagem, e uma conversa que
  // nunca saiu do automático não tem nenhuma.
  passagens: CartaoDaPassagem[] = [],
): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((data): ThreadItem => ({ kind: "message", ts: data.sent_at, data })),
    ...notes.map((data): ThreadItem => ({ kind: "note", ts: data.created_at, data })),
    ...passagens.map((data): ThreadItem => ({ kind: "passagem", ts: data.criadoEm, data })),
  ];
  // Sort estável (Array#sort é estável no V8/Node): empate mantém a ordem de
  // inserção acima — mensagens antes de notas no mesmo instante, e a passagem
  // DEPOIS das duas, que é o que aconteceu: ela é consequência da última fala.
  items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return items;
}

function dayLabel(d: Date, t: (texto: string) => string = (texto) => texto, locale: Locale): string {
  if (isToday(d)) return t("Hoje");
  if (isYesterday(d)) return t("Ontem");
  return format(d, "dd/MM/yyyy", { locale: locale });
}

export function ChatThread({
  conversationId,
  provider,
  onResponder,
  onEncaminhar,
  dono,
  contatoId,
  searchTerm = "",
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const q = useMessagesRealtime(conversationId);
  const notes = useConversationNotes(conversationId);
  const passagens = usePassagensDaConversa(conversationId);
  const claim = useClaimConversation();
  const activeOrg = useActiveOrg();
  const currentUser = useUser();
  const deleteNote = useDeleteNote(conversationId ?? "");
  const { editar, apagar, ocultar, restaurar, reenviar } = useAlterarMensagem(conversationId);
  const canManage = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  // Reenviar é envio: a rota exige `agent`, e quem só lê não ganha um botão que ela recusa.
  const podeEnviar = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const canalAlteraEnviada = transportaMensagem(provider)
    && capabilitiesOf(provider as ChannelProvider).alteraMensagemEnviada;
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  const messages: Message[] = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  /**
   * BUSCA NO QUE JÁ ESTÁ NA TELA (#1793). Não vai ao servidor: filtra as
   * páginas carregadas, e o rótulo diz isso para ninguém ler "zero" como "não
   * existe na conversa". Apagada e oculta ficam de fora — o texto delas não
   * aparece na bolha, e marcar uma bolha sem o termo visível seria mentir.
   */
  const termo = searchTerm.trim().toLocaleLowerCase();
  const resultados = useMemo(
    () =>
      new Set(
        messages
          .filter(
            (m) =>
              termo &&
              !m.revoked_at &&
              !m.metadata?.crm_hidden_at &&
              m.body?.toLocaleLowerCase().includes(termo),
          )
          .map((m) => m.id),
      ),
    [messages, termo],
  );
  /**
   * As mensagens por id, para resolver a CITADA sem ir ao servidor.
   *
   * Uma consulta por bolha citada seria uma cascata de requisições numa
   * conversa longa. Aqui o fio sai da lista que já está na tela — e quando a
   * citada ficou fora da página carregada, ele simplesmente não aparece, que é
   * melhor que segurar a conversa esperando por um texto de enfeite.
   */
  const porId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const cartoes: CartaoDaPassagem[] = useMemo(
    () =>
      montarCartoesDaPassagem(passagens, {
        usuarioId: currentUser.id,
        donoId: dono?.userId ?? null,
        donoNome: dono?.nome ?? null,
      }),
    [passagens, currentUser.id, dono?.userId, dono?.nome],
  );

  const { falas, reacoesPorAlvo } = useMemo(() => separarReacoes(messages), [messages]);

  const items: ThreadItem[] = useMemo(
    () => mergeThreadItems(falas, notes, cartoes),
    [falas, notes, cartoes],
  );

  const lastItem = items[items.length - 1];
  const lastMessage = [...items].reverse().find((item) => item.kind === "message");
  const latest = lastMessage?.kind === "message" ? lastMessage.data : null;
  const scroll = useThreadAutoScroll({
    conversationId,
    ready: !!conversationId && !q.isLoading && !q.isError && items.length > 0,
    itemCount: items.length,
    lastItemKey: lastItem ? `${lastItem.kind}:${lastItem.data.id}` : "",
    lastMessageId: latest?.id ?? "",
    lastMessageIsOwn: latest?.direction === "outbound"
      && (latest.sent_by_user_id === currentUser.id || latest.metadata?._optimistic === true),
    pages: q.data?.pages.length ?? 0,
    searching: !!termo,
  });
  const { scrollerRef, contentRef, bottomRef } = scroll;

  // Só o TERMO leva à ocorrência. Depender do conjunto de resultados faria cada
  // mensagem nova do tempo real arrancar quem lê de volta à primeira ocorrência.
  useEffect(() => {
    if (termo)
      scrollerRef.current
        ?.querySelector('[data-search-match="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [termo, scrollerRef]);

  /**
   * O ESTADO DO CANAL DESTE THREAD, PUBLICADO SEMPRE — inclusive quando não há
   * mensagem nenhuma.
   *
   * ⚠️ A primeira versão punha estes atributos só no caso de SUCESSO, junto com
   * o `data-testid`. Isso os tornava invisíveis exatamente no estado em que
   * mais importam: conversa sem mensagens, esperando a primeira chegar. O canal
   * existe desde que a conversa abre; o sinal dele não pode depender de já
   * haver o que mostrar.
   *
   * Custou uma rodada de CI para aparecer, e por um motivo que vale registrar:
   * na máquina de quem desenvolve a conversa tem histórico acumulado, então o
   * caminho de sucesso é o único que se exercita. No CI o banco é fresco e a
   * conversa nasce vazia — o estado que nunca se vê localmente é o normal lá.
   *
   * Os dois atributos dizem coisas diferentes e nenhum sozinho basta:
   * `-status-mensagens` distingue "assinou" de "nem chegou a assinar";
   * `-divergencias-mensagens` é o que denuncia canal ASSINADO E MUDO, porque só
   * incrementa quando o refetch traz o que o canal não trouxe.
   */
  const sinalDoCanal = {
    "data-testid": "chat-thread",
    "data-realtime-status-mensagens": q.realtimeStatus,
    "data-refetch-divergencias-mensagens": q.seguranca?.divergencias ?? 0,
  } as const;

  if (!conversationId) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        {t("Selecione uma conversa")}
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div {...sinalDoCanal} className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-2/3" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <p>{t("Erro ao carregar mensagens.")}</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          {t("Tentar novamente")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        {t("Nenhuma mensagem nesta conversa.")}
      </div>
    );
  }

  // Group by day for separators (usa o timestamp do item — sent_at pra mensagem, created_at pra nota).
  const groups: { key: string; date: Date; items: ThreadItem[] }[] = [];
  for (const item of items) {
    const d = new Date(item.ts);
    const key = format(d, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, date: d, items: [item] });
  }

  return (
    <div {...sinalDoCanal} className="relative flex h-full min-h-0 min-w-0 flex-col">
      {termo && (
        <div className="px-4 py-1 text-xs text-muted-foreground" role="status">
          {t("Resultados nas mensagens carregadas")}: {resultados.size}
        </div>
      )}
      <div ref={scrollerRef} role="region" aria-label={t("Mensagens da conversa")} tabIndex={0}
        onScroll={scroll.onScroll} onWheel={scroll.onWheel} onTouchMove={scroll.onTouchMove}
        onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain py-2">
        <div ref={contentRef}>
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { scroll.beforeLoadOlder(); q.fetchNextPage(); }}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais antigas")}
            </Button>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key} className="space-y-1">
            <div className="sticky top-0 z-10 flex justify-center py-1">
              <span className="rounded-full bg-background/80 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground backdrop-blur">
                {dayLabel(g.date, t, localeDaData)}
              </span>
            </div>
            {g.items.map((item) =>
              item.kind === "passagem" ? (
                <PassagemCard
                  key={`passagem-${item.data.id}`}
                  cartao={item.data}
                  contatoId={contatoId ?? null}
                  assumindo={claim.isPending}
                  // O MESMO gesto do cabeçalho — uma rota, um efeito. Uma
                  // segunda maneira de assumir seria uma segunda chance de os
                  // dois caminhos divergirem sobre o que "assumir" faz.
                  onAssumir={() =>
                    conversationId &&
                    claim.mutate({
                      conversation_id: conversationId,
                      expected_assignee: dono?.userId ?? null,
                    })
                  }
                />
              ) : item.kind === "note" ? (
                <NoteCard
                  key={`note-${item.data.id}`}
                  note={item.data}
                  // Só o autor ou manager+ vê o excluir — o backend barra o resto (403),
                  // então não mostramos um botão que daria erro.
                  onDelete={
                    item.data.created_by_user_id === currentUser.id || canManage
                      ? () => deleteNote.mutate(item.data.id)
                      : undefined
                  }
                />
              ) : (
                <MessageBubble
                  key={`msg-${item.data.id}`}
                  message={item.data}
                  searchMatch={resultados.has(item.data.id)}
                  debugCitations={debugCitations}
                  onResponder={onResponder}
                  onEncaminhar={onEncaminhar}
                  // A citada sai da MESMA lista já carregada: buscar no servidor
                  // por cada citação faria uma consulta por bolha. Quando a
                  // citada é antiga demais e ficou fora da página, o fio some —
                  // que é melhor que segurar a conversa esperando.
                  citada={porId.get(item.data.reply_to_message_id ?? "") ?? null}
                  reacoes={reacoesPorAlvo.get(item.data.id)}
                  // Sem isto o balão diz "Você" em toda mensagem digitada no
                  // CRM — inclusive nas do colega, porque `sent_via='user'` só
                  // registra que um humano digitou, nunca qual.
                  viewerUserId={currentUser.id}
                  onEditar={canalAlteraEnviada && item.data.sent_by_user_id === currentUser.id
                    ? (text) => editar.mutateAsync({ id: item.data.id, text }).then(() => undefined)
                    : undefined}
                  onApagar={canalAlteraEnviada && item.data.sent_by_user_id === currentUser.id
                    ? () => apagar.mutateAsync(item.data.id).then(() => undefined)
                    : undefined}
                  onOcultar={canManage && item.data.direction === "inbound"
                    ? () => ocultar.mutateAsync(item.data.id).then(() => undefined)
                    : undefined}
                  onRestaurar={canManage && item.data.direction === "inbound"
                    ? () => restaurar.mutateAsync(item.data.id).then(() => undefined)
                    : undefined}
                  onReenviar={podeEnviar && item.data.direction === "outbound"
                    ? (confirmado) => reenviar.mutateAsync({ id: item.data.id, confirmado }).then(() => undefined)
                    : undefined}
                  podeReenviarDeOutros={canManage}
                />
              ),
            )}
          </div>
        ))}

        <div ref={bottomRef} />
        </div>
      </div>
      {scroll.hasNewMessages && (
        <div className="absolute inset-x-0 bottom-3 z-20 flex justify-center px-3" role="status" aria-live="polite">
          <Button size="sm" className="h-auto max-w-full whitespace-normal rounded-full shadow-lg"
            onClick={() => scroll.scrollToEnd()}>
            {t("Novas mensagens · Ir para o fim")}
          </Button>
        </div>
      )}
    </div>
  );
}

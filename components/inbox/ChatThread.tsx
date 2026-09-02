"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { useEffect, useMemo, useRef } from "react";
import { useT } from "@/hooks/i18n/useT";
import { format, isToday, isYesterday } from "date-fns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./MessageBubble";
import { NoteCard } from "./NoteCard";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useConversationNotes } from "@/hooks/inbox/useConversationNotes";
import { useDeleteNote } from "@/hooks/inbox/useDeleteNote";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import type { Message, Note } from "@/lib/types/messaging";

interface Props {
  conversationId: string | null;
  /** Escolher uma mensagem para responder. Sobe até o composer. */
  onResponder?: (m: Message) => void;
}

/** Onda 5.2: union de item do thread — mensagem real ou nota interna (nunca vai ao cliente). */
export type ThreadItem =
  | { kind: "message"; ts: string; data: Message }
  | { kind: "note"; ts: string; data: Note };

/** Intercala mensagens e notas por timestamp asc (puro, sem I/O — testado em thread-merge.test.ts). */
export function mergeThreadItems(messages: Message[], notes: Note[]): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((data): ThreadItem => ({ kind: "message", ts: data.sent_at, data })),
    ...notes.map((data): ThreadItem => ({ kind: "note", ts: data.created_at, data })),
  ];
  // Sort estável (Array#sort é estável no V8/Node): empate mantém a ordem de
  // inserção acima — mensagens antes de notas no mesmo instante.
  items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return items;
}

function dayLabel(d: Date, t: (texto: string) => string = (texto) => texto, locale: Locale): string {
  if (isToday(d)) return t("Hoje");
  if (isYesterday(d)) return t("Ontem");
  return format(d, "dd/MM/yyyy", { locale: locale });
}

export function ChatThread({ conversationId, onResponder }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const q = useMessagesRealtime(conversationId);
  const notes = useConversationNotes(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const paginasVistas = useRef(0);
  const activeOrg = useActiveOrg();
  const currentUser = useUser();
  const deleteNote = useDeleteNote(conversationId ?? "");
  const canManage = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  const messages: Message[] = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
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

  const items: ThreadItem[] = useMemo(
    () => mergeThreadItems(messages, notes),
    [messages, notes],
  );

  const paginas = q.data?.pages.length ?? 0;

  // Conversa nova: a contagem de páginas recomeça, senão a primeira carga da
  // próxima conversa seria confundida com um "carregar mais antigas".
  useEffect(() => {
    paginasVistas.current = 0;
  }, [conversationId]);

  // Rola ao fim na primeira carga e quando chega mensagem/nota nova — mas NÃO
  // quando o crescimento veio do "Carregar mais antigas".
  //
  // A thread pagina para o PASSADO: cada `fetchNextPage` traz mensagens mais
  // antigas, que entram ACIMA das que já estão na tela. Rolar ao fim aqui
  // devolveria o usuário ao rodapé no instante em que ele pediu para subir —
  // o clique parece não ter efeito, embora tenha carregado (medido: thread vai
  // de msg#15..#64 para msg#1..#64 e a viewport volta a 7px do fim).
  //
  // A segunda guarda cobre o outro caso: se o usuário rolou para ler o
  // histórico, mensagem nova não deve arrancá-lo de onde estava.
  useEffect(() => {
    const primeiraCarga = paginasVistas.current === 0;
    const carregouAntigas = !primeiraCarga && paginas > paginasVistas.current;
    paginasVistas.current = paginas;
    if (carregouAntigas) return;

    // A guarda de distância NÃO vale na primeira carga: ali o scroller ainda
    // está no topo por definição, e tratá-lo como "usuário lendo o histórico"
    // abriria a conversa na mensagem mais antiga da página em vez da mais nova
    // (medido: a thread abria em msg#15 em vez de msg#64).
    if (!primeiraCarga) {
      const sc = scrollerRef.current;
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 120) return;
    }

    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, conversationId, paginas]);

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
    <div {...sinalDoCanal} className="flex h-full flex-col">
      <div ref={scrollerRef} className="flex-1 overflow-y-auto py-2">
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => q.fetchNextPage()}
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
              item.kind === "note" ? (
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
                  debugCitations={debugCitations}
                  onResponder={onResponder}
                  // A citada sai da MESMA lista já carregada: buscar no servidor
                  // por cada citação faria uma consulta por bolha. Quando a
                  // citada é antiga demais e ficou fora da página, o fio some —
                  // que é melhor que segurar a conversa esperando.
                  citada={porId.get(item.data.reply_to_message_id ?? "") ?? null}
                />
              ),
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

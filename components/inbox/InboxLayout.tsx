"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useIsMobile } from "@/hooks/useIsMobile";
import { CaretLeft, Info } from "@/lib/ui/icons";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ConversationList } from "./ConversationList";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { RetentionNotice } from "./RetentionNotice";
import { CRMSidePanel } from "./CRMSidePanel";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";
import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";

/**
 * O QUE CADA ABA SIGNIFICA. Exportada porque é a definição em si — o defeito
 * que este mapa já teve (Minhas mostrando tudo que o atendente fechou) não
 * aparece em nenhuma tela até alguém reclamar, então vale prender por teste.
 */
export function tabToFilter(tab: InboxFiltersValue["tab"]): Partial<ConversationsFilters> {
  switch (tab) {
    case "unassigned":
      return { assigned_to: "unassigned", status: "open" };
    case "mine":
      // Sem `exclude_finished` a aba mostra tudo que o atendente JÁ atendeu —
      // `Fechar` muda o status mas não solta o dono (de propósito: quem atendeu
      // é histórico). O lugar de "minhas fechadas" é a aba Fechadas.
      return { assigned_to: "me", exclude_finished: true };
    case "closed":
      return { status: "closed" };
    case "ai":
      return { status: "ai_handling" };
    case "all":
    default:
      return {};
  }
}

const FILTER_TABS: InboxTab[] = ["unassigned", "mine", "all", "closed", "ai"];

/**
 * Lê ?filter= (G4-02, deep-link). ?filter=all é HONRADO mesmo para agent — a
 * lista volta RLS-scoped (a tab só some cosmeticamente); default: fila.
 */
function parseFilterParam(v: string | null): InboxTab {
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "unassigned";
}

interface InboxLayoutProps {
  initialSelectedId?: string | null;
}

export function InboxLayout({ initialSelectedId = null }: InboxLayoutProps = {}) {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseFilterParam(searchParams.get("filter"));

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão.
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: "",
    onlyUnread: false,
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, router, pathname],
  );

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const composerRef = useRef<ComposerHandle | null>(null);
  const isMobile = useIsMobile();

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab),
      search: filterValue.search || undefined,
      channel_session_id: filterValue.channel_session_id,
      tag: filterValue.tag,
    }),
    [filterValue.tab, filterValue.search, filterValue.channel_session_id, filterValue.tag],
  );

  const clientFilter = useMemo(
    () =>
      filterValue.onlyUnread
        ? (c: ConversationWithContact) => (c.unread_count_for_assignee ?? 0) > 0
        : undefined,
    [filterValue.onlyUnread],
  );

  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  const needsFetch = !!selectedId && !inList && !listQ.isLoading;
  const single = useConversation(selectedId, needsFetch);
  const selectedConversation: ConversationWithContact | null = inList ?? single.data ?? null;
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const claim = useClaimConversation();
  const close = useCloseConversation();

  const handleSelect = useCallback((id: string) => setSelectedId(id), []);
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    close.mutate({ conversation_id: selectedConversation.id });
  }, [close, selectedConversation]);

  const blockedReason = selectedConversation?.contacts?.is_blocked
    ? "Contato bloqueado — envio de mensagens desabilitado."
    : selectedConversation?.contacts?.is_anonymized
      ? "Contato anonimizado — não é possível enviar mensagens."
      : null;

  // MOBILE: lista OU thread, nunca as duas — o grid `grid-cols-1` de baixo
  // colapsava pra 1 coluna, mas lista e thread continuavam IRMÃS no mesmo
  // grid (ambas montadas), então só a lista era alcançável. Aqui é um branch
  // de verdade: decide o que MONTA, não só o que aparece via CSS.
  //
  // Não promovi `selectedId` pra URL (`?id=`) pra fazer o botão-voltar do
  // navegador funcionar sozinho — teria que mudar de `useState` pra derivar
  // de `useSearchParams`, um refactor maior num arquivo que já tem lógica
  // fina de realtime/deep-link. Optei pelo caminho de menor risco: uma seta
  // "voltar" explícita que limpa `selectedId` — mesmo resultado pro usuário,
  // sem tocar em como a seleção é computada hoje.
  if (isMobile) {
    return (
      <div className="flex h-[calc(100dvh-3.5rem)] w-full flex-col">
        {selectedConversation ? (
          <>
            <div className="flex items-center gap-1 border-b border-border py-1 pl-1 pr-2">
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label="Voltar para a lista"
                className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
              >
                <CaretLeft size={20} aria-hidden />
              </button>
              <div className="min-w-0 flex-1">
                <ConversationHeader conversation={selectedConversation} />
              </div>
              <button
                type="button"
                onClick={() => setDetailsOpen(true)}
                aria-label="Detalhes do contato"
                className="flex h-11 w-11 shrink-0 items-center justify-center text-muted-foreground"
              >
                <Info size={20} aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread conversationId={selectedConversation.id} />
            </div>
            <RetentionNotice conversationId={selectedConversation.id} />
            <Composer
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={blockedReason}
              disabled={selectedConversation.status === "closed"}
              contactName={selectedConversation.contacts?.name ?? null}
            />
            <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
              <SheetContent
                side="bottom"
                className="flex max-h-[85dvh] flex-col overflow-y-auto"
              >
                <SheetTitle className="sr-only">Detalhes do contato</SheetTitle>
                <CRMSidePanel conversation={selectedConversation} />
              </SheetContent>
            </Sheet>
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Conversa não encontrada ou fora do seu acesso.
          </div>
        ) : (
          <>
            <InboxFilters value={filterValue} onChange={setFilterValue} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <ConversationList
                filters={filters}
                orgId={orgId}
                selectedId={selectedId}
                onSelect={handleSelect}
                clientFilter={clientFilter}
                onVisibleChange={handleVisibleChange}
              />
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="grid h-[calc(100dvh-3.5rem-2*var(--space-6))] w-full grid-cols-1 md:grid-cols-[300px_1fr] xl:grid-cols-[272px_1fr_296px] 2xl:grid-cols-[300px_1fr_320px]">
      <div className="flex h-full min-h-0 flex-col border-r border-border">
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            filters={filters}
            orgId={orgId}
            selectedId={selectedId}
            onSelect={handleSelect}
            clientFilter={clientFilter}
            onVisibleChange={handleVisibleChange}
          />
        </div>
      </div>

      <div className="flex h-full min-h-0 flex-col">
        {selectedConversation ? (
          <>
            <ConversationHeader conversation={selectedConversation} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread conversationId={selectedConversation.id} />
            </div>
            <RetentionNotice conversationId={selectedConversation.id} />
            <Composer
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={blockedReason}
              disabled={selectedConversation.status === "closed"}
              contactName={selectedConversation.contacts?.name ?? null}
            />
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Conversa não encontrada ou fora do seu acesso.
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Selecione uma conversa
          </div>
        )}
      </div>

      <div className="hidden h-full min-h-0 xl:block">
        <CRMSidePanel conversation={selectedConversation} />
      </div>

      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={handleClaim}
        onClose={handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

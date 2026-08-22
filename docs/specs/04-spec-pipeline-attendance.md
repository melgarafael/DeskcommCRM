---
title: Spec Técnica 04 — Pipeline Kanban + Atendimento
parent: 04-prd-pipeline-attendance.md
depends_on: 01-spec-platform-base.md, 02-spec-customer-360.md, 03-spec-whatsapp-waha.md
version: 0.1
status: em revisão
date: 2026-04-28
owner: Songhai, Lda
referencia_arquitetural: docs/research/reference-synthesis.md
---

# Spec Técnica 04 — Pipeline Kanban + Atendimento

> Especificação de implementação frontend da camada operacional: Inbox 3 colunas, Kanban com drag-drop, hooks Realtime, claim atômico de conversation, supervisor read-only, notas internas, status do atendente, dashboard lite. Profundidade orientada a *staff engineer reading code* — types, props, hooks, fluxo de erro.

---

## 1. Visão Geral

O sub-PRD 04 entrega a UI e o cliente-de-API de duas superfícies:

- **Inbox** — `/inbox` e `/inbox/[conversationId]`. Layout 3 colunas em desktop, 2 rotas em mobile. É onde >80% do tempo do atendente acontece.
- **Kanban** — `/pipeline/[pipelineId]`. Visualização funil com drag-drop, filtros, bulk actions. É onde gerentes priorizam.

Esta spec NÃO redefine schema (que vive nas Specs 02 e 03), NÃO redefine endpoints REST de mensageria (Spec 03) e NÃO trata de IA/handoff (Spec 05). Ela define:

1. Stack frontend exata e versões mínimas
2. Estrutura de pastas do `app/`, `components/`, `lib/`, `hooks/`
3. Hooks de Realtime (primitivo `useRealtimeChannel` + composições)
4. Componentes da Inbox (`<ConversationList>`, `<ChatThread>`, `<CRMSidePanel>`) com props tipadas
5. Componente Kanban (`<KanbanBoard>`, `<KanbanColumn>`, `<KanbanCard>`) com fluxo de drag-drop end-to-end
6. Hook `useSendMessage` com optimistic UI e rollback
7. Status do atendente (toggle + heartbeat + auto-offline 15min — AT-08)
8. Claim atômico "Eu cuido" (AT-02) com tratamento de race 409
9. Supervisor read-only (AT-04) com audit `conversation.observed_by_supervisor`
10. Pipeline vocabulary integrada via hook + linter custom (P-07)
11. Notas internas (AT-05) com UI distintiva
12. Dashboard lite (4 cards de métrica)
13. Lista exaustiva de componentes shadcn/ui usados
14. Estratégia de testes e performance

**Princípios de execução** (herdados do PRD-mestre):
- Estado de servidor via TanStack Query; estado efêmero local via `useState`/`useReducer`; sem Redux/Zustand global no MVP — Context API resolve para `currentUser`, `pipelineVocabulary` e `realtimeStatus`.
- Optimistic UI obrigatório em send, drag-drop, claim, status toggle, mark-as-read.
- Acessibilidade não-negociável: WCAG AA, navegação teclado, ARIA roles em listas e drag-drop.
- Mobile-first em CSS, mas layout 3 colunas é desktop-only — em mobile usamos rotas separadas.

---

## 2. Tech Stack do Frontend

### 2.1 Versões mínimas (lock no `package.json`)

| Pacote | Versão | Razão |
|---|---|---|
| `next` | `^14.2.0` (App Router) | Server components, streaming, route groups |
| `react` | `^18.3.0` | Concurrent features, `useTransition` |
| `typescript` | `^5.4.0` | `satisfies` operator, const type params |
| `tailwindcss` | `^3.4.0` | `@layer`, JIT, `aspect-ratio` |
| `@supabase/supabase-js` | `^2.45.0` | Realtime v2 client |
| `@supabase/ssr` | `^0.5.0` | Cookie-based auth no App Router |
| `@tanstack/react-query` | `^5.50.0` | Suspense queries, optimistic helpers |
| `@hello-pangea/dnd` | `^16.6.0` | Fork mantido do `react-beautiful-dnd` |
| `react-hook-form` | `^7.52.0` | Composer + forms de pipeline |
| `zod` | `^3.23.0` | Validação de payload de API client |
| `date-fns` | `^3.6.0` | `formatDistanceToNow`, locale `pt-BR` |
| `lucide-react` | `^0.400.0` | Ícones (paperclip, send, etc.) |
| `class-variance-authority` | `^0.7.0` | Variants em components shadcn |
| `tailwind-merge` | `^2.4.0` | Merge de classes em `cn()` |
| `clsx` | `^2.1.0` | Combinador de classes |
| `sonner` | `^1.5.0` | Toasts (claim 409, send error, etc.) |

### 2.2 shadcn/ui — components instalados

Lista exaustiva (gerada via `npx shadcn-ui add <name>`):

`avatar`, `badge`, `button`, `card`, `checkbox`, `command`, `dialog`, `drawer`, `dropdown-menu`, `form`, `input`, `label`, `popover`, `scroll-area`, `select`, `separator`, `sheet`, `skeleton`, `switch`, `tabs`, `textarea`, `toast` (sonner replace), `tooltip`.

Adicionais (não-shadcn, custom):
- `<EmojiPicker>` — wrapper sobre `emoji-mart` lazy-loaded
- `<ChannelStatusBanner>` — banner amarelo de reconexão Realtime
- `<MessageBubble>` — componente de bolha por tipo

### 2.3 Tooling

- **ESLint** com `eslint-plugin-react-hooks`, `@typescript-eslint`, e plugin custom `eslint-plugin-deskcomm` (item §11.3).
- **Prettier** com `prettier-plugin-tailwindcss`.
- **Vitest** + `@testing-library/react` + `@testing-library/user-event` para unit/integration de componentes.
- **Playwright** para E2E (drag-drop, send, claim concorrente).

---

## 3. Estrutura de Pastas

```
app/
  (app)/
    inbox/
      page.tsx                 # /inbox — desktop 3 col / mobile lista
      [conversationId]/
        page.tsx               # /inbox/:id — thread + side panel
    pipeline/
      [pipelineId]/
        page.tsx               # Kanban
        settings/page.tsx      # editar stages, vocabulary, custom fields
    dashboard/
      atendimento/page.tsx     # dashboard lite
    layout.tsx                 # CurrentUserProvider, RealtimeProvider
  api/                         # (delegada à Spec 01/03)
  globals.css

components/
  inbox/
    ConversationList.tsx
    ConversationItem.tsx
    ConversationFilters.tsx
    ChatThread.tsx
    ChatHeader.tsx
    MessageBubble/
      index.tsx
      TextBubble.tsx
      ImageBubble.tsx
      AudioBubble.tsx
      DocumentBubble.tsx
      LocationBubble.tsx
      NoteBubble.tsx
    Composer/
      Composer.tsx
      QuickReplyMenu.tsx
      AttachmentButton.tsx
      EmojiButton.tsx
    CRMSidePanel/
      index.tsx
      ContactSection.tsx
      DealSection.tsx
      NotesSection.tsx
      TimelineSection.tsx
    ChannelStatusBanner.tsx
    TypingIndicator.tsx

  kanban/
    KanbanBoard.tsx
    KanbanColumn.tsx
    KanbanCard.tsx
    KanbanFilters.tsx
    BulkActionBar.tsx
    PipelineSwitcher.tsx

  attendance/
    AttendantStatusToggle.tsx
    SupervisorBanner.tsx
    ClaimButton.tsx
    ReassignDialog.tsx

  dashboard/
    OpenConversationsCard.tsx
    FirstResponseTimeCard.tsx
    PendingConversationsCard.tsx
    ResolutionRateCard.tsx

  ui/                          # shadcn (não editar manualmente)

hooks/
  realtime/
    useRealtimeChannel.ts      # primitivo
    useConversationsRealtime.ts
    useMessagesRealtime.ts
    useChannelSession.ts
    useTypingIndicator.ts
    useBoard.ts
  data/
    useSendMessage.ts
    useClaimConversation.ts
    useResolveConversation.ts
    useMoveCard.ts
    useBulkAction.ts
    useMarkAsRead.ts
  presence/
    useAgentStatus.ts
    useHeartbeat.ts
    useInactivityDetector.ts
  pipeline/
    usePipelineVocabulary.ts
    usePipeline.ts

lib/
  api/
    client.ts                  # fetch wrapper com Idempotency-Key
    conversations.ts
    messages.ts
    leads.ts
    pipelines.ts
    presence.ts
  supabase/
    client.ts                  # browser client
    server.ts                  # server client (SSR)
  utils/
    cn.ts
    fractional-index.ts        # midpoint(prev, next)
    interpolate-template.ts    # quick reply {nome} → João
    format.ts                  # currency, date relative
  types/
    db.ts                      # gerados via supabase gen types
    api.ts                     # request/response shapes
    domain.ts                  # tipos de UI (Conversation, Lead, etc.)

config/
  shadcn.json
  tailwind.config.ts
  pipeline-defaults.ts         # stages e-commerce seed

styles/
  globals.css
```

**Convenções:**
- 1 componente por arquivo, default export é o componente
- Props sempre tipadas com `interface XxxProps`
- `client components` marcados com `"use client"` no topo; default no App Router é server component
- Imports absolutos via `@/components/...`, `@/hooks/...`, `@/lib/...` (configurar `tsconfig.paths`)

---

## 4. Hooks de Realtime

Toda assinatura de Supabase Realtime no app **passa por** `useRealtimeChannel` — primitivo único responsável por subscribe/unsubscribe, detecção de queda, dedup e handoff de eventos. Os hooks de domínio (`useConversationsRealtime`, etc.) são compositores acima dele.

### 4.1 `useRealtimeChannel` — primitivo

```ts
// hooks/realtime/useRealtimeChannel.ts
import { useEffect, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

type ChangeEvent = "INSERT" | "UPDATE" | "DELETE" | "*";

export interface UseRealtimeChannelOptions<T extends Record<string, unknown>> {
  channel: string;                     // ex: "org-123-conversations"
  table: string;                       // ex: "conversations"
  schema?: string;                     // default "public"
  event?: ChangeEvent;                 // default "*"
  filter?: string;                     // ex: "org_id=eq.123"
  enabled?: boolean;                   // default true
  onChange: (payload: RealtimePostgresChangesPayload<T>) => void;
  onStatusChange?: (status: ChannelStatus) => void;
}

export type ChannelStatus =
  | "subscribing"
  | "subscribed"
  | "channel_error"
  | "timed_out"
  | "closed";

export function useRealtimeChannel<T extends Record<string, unknown>>(
  options: UseRealtimeChannelOptions<T>,
) {
  const {
    channel,
    table,
    schema = "public",
    event = "*",
    filter,
    enabled = true,
    onChange,
    onStatusChange,
  } = options;

  const [status, setStatus] = useState<ChannelStatus>("subscribing");
  const channelRef = useRef<RealtimeChannel | null>(null);
  // refs estabilizam closures sem re-subscribe a cada render
  const onChangeRef = useRef(onChange);
  const onStatusChangeRef = useRef(onStatusChange);

  useEffect(() => {
    onChangeRef.current = onChange;
    onStatusChangeRef.current = onStatusChange;
  }, [onChange, onStatusChange]);

  useEffect(() => {
    if (!enabled) return;

    const ch = supabase
      .channel(channel)
      .on(
        "postgres_changes",
        { event, schema, table, ...(filter ? { filter } : {}) },
        (payload) => onChangeRef.current(payload as never),
      )
      .subscribe((s) => {
        const next = s as ChannelStatus;
        setStatus(next);
        onStatusChangeRef.current?.(next);
      });

    channelRef.current = ch;

    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
    // dependências controladas — strings only
  }, [channel, table, schema, event, filter, enabled]);

  return { status };
}
```

**Pontos de design:**
- Ref-pattern para callbacks: evita re-subscribe a cada render do consumidor.
- `enabled` permite suspender (ex: aba em background, conversation deselecionada).
- `status` exposto para o consumidor decidir UI (banner amarelo).

### 4.2 Hooks de domínio

#### `useConversationsRealtime`

```ts
// hooks/realtime/useConversationsRealtime.ts
import { useQueryClient } from "@tanstack/react-query";
import { useRealtimeChannel } from "./useRealtimeChannel";
import type { ConversationRow } from "@/lib/types/db";
import type { ConversationFilter } from "@/lib/types/domain";

export function useConversationsRealtime(
  orgId: string,
  filter: ConversationFilter,
) {
  const qc = useQueryClient();

  return useRealtimeChannel<ConversationRow>({
    channel: `org-${orgId}-conversations`,
    table: "conversations",
    filter: `org_id=eq.${orgId}`,
    onChange: (payload) => {
      // patch in-place na queryKey, evita refetch
      qc.setQueryData<ConversationRow[]>(
        ["conversations", orgId, filter],
        (prev) => mergePayload(prev, payload),
      );
      // cache do detalhe também
      const newRow = payload.new as ConversationRow | undefined;
      if (newRow?.id) {
        qc.setQueryData(["conversation", newRow.id], newRow);
      }
    },
  });
}

function mergePayload<T extends { id: string }>(
  prev: T[] | undefined,
  payload: { eventType: string; new: T; old: Partial<T> },
): T[] {
  if (!prev) return prev ?? [];
  switch (payload.eventType) {
    case "INSERT":
      return [payload.new, ...prev];
    case "UPDATE":
      return prev.map((r) => (r.id === payload.new.id ? payload.new : r));
    case "DELETE":
      return prev.filter((r) => r.id !== (payload.old.id as string));
    default:
      return prev;
  }
}
```

#### `useMessagesRealtime`

```ts
// hooks/realtime/useMessagesRealtime.ts
export function useMessagesRealtime(conversationId: string) {
  const qc = useQueryClient();

  return useRealtimeChannel<MessageRow>({
    channel: `conv-${conversationId}-messages`,
    table: "messages",
    filter: `conversation_id=eq.${conversationId}`,
    enabled: Boolean(conversationId),
    onChange: (payload) => {
      qc.setQueryData<MessageRow[]>(["messages", conversationId], (prev) => {
        if (!prev) return prev ?? [];
        if (payload.eventType === "INSERT") {
          // dedupe: optimistic insert pode ter chegado antes via send
          const incoming = payload.new;
          const idx = prev.findIndex(
            (m) =>
              m.id === incoming.id ||
              (m.client_message_id &&
                m.client_message_id === incoming.client_message_id),
          );
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = incoming;
            return next;
          }
          return [...prev, incoming];
        }
        if (payload.eventType === "UPDATE") {
          return prev.map((m) =>
            m.id === payload.new.id ? payload.new : m,
          );
        }
        return prev;
      });
    },
  });
}
```

**Decisão de dedup:** mensagens otimistas têm `client_message_id` (UUID gerado no cliente); ao chegar a INSERT real do servidor, comparamos por ele e substituímos. Isso resolve o problema clássico de "vejo duas bolhas".

#### `useChannelSession`

Espelha o status da sessão WAHA do tenant (Spec 03). Renderiza o `<ChannelStatusBanner>`.

```ts
export function useChannelSession(orgId: string) {
  const qc = useQueryClient();

  const { status } = useRealtimeChannel<ChannelSessionRow>({
    channel: `channel-sessions-${orgId}`,
    table: "channel_sessions",
    filter: `org_id=eq.${orgId}`,
    onChange: (payload) =>
      qc.setQueryData(["channel-session", orgId], payload.new),
  });

  return { realtimeStatus: status };
}
```

### 4.3 `useTypingIndicator` — broadcast (não postgres_changes)

Eventos de "está digitando" são efêmeros — não vão pra DB. Usamos broadcast channel.

```ts
// hooks/realtime/useTypingIndicator.ts
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";

const TYPING_THROTTLE_MS = 2000;
const TYPING_EXPIRE_MS = 5000;

export function useTypingIndicator(conversationId: string, userId: string) {
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const lastEmitRef = useRef(0);
  const expireTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  useEffect(() => {
    const ch = supabase
      .channel(`conv-${conversationId}-typing`, {
        config: { broadcast: { self: false } },
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const uid = payload.userId as string;
        setTypingUsers((s) => new Set(s).add(uid));
        const t = expireTimers.current.get(uid);
        if (t) clearTimeout(t);
        const newT = setTimeout(() => {
          setTypingUsers((s) => {
            const next = new Set(s);
            next.delete(uid);
            return next;
          });
          expireTimers.current.delete(uid);
        }, TYPING_EXPIRE_MS);
        expireTimers.current.set(uid, newT);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(ch);
      expireTimers.current.forEach(clearTimeout);
      expireTimers.current.clear();
    };
  }, [conversationId]);

  const emitTyping = () => {
    const now = Date.now();
    if (now - lastEmitRef.current < TYPING_THROTTLE_MS) return;
    lastEmitRef.current = now;
    supabase
      .channel(`conv-${conversationId}-typing`)
      .send({ type: "broadcast", event: "typing", payload: { userId } });
  };

  return { typingUsers, emitTyping };
}
```

### 4.4 `useBoard` — Kanban com filtros

```ts
// hooks/realtime/useBoard.ts
export interface BoardFilters {
  ownerId?: string | null;
  status?: LeadStatus[];
  tagIds?: string[];
  search?: string;
}

export function useBoard(pipelineId: string, filters: BoardFilters) {
  const qc = useQueryClient();
  const queryKey = ["board", pipelineId, filters] as const;

  // 1) fetch inicial via TanStack Query
  const query = useQuery({
    queryKey,
    queryFn: () => fetchBoard(pipelineId, filters),
    staleTime: 30_000,
  });

  // 2) realtime patch (não refetch); ignora UPDATE de cards em "dragging"
  const draggingRef = useDraggingState(); // expõe Set<string> de leadIds

  useRealtimeChannel<LeadRow>({
    channel: `pipeline-${pipelineId}-leads`,
    table: "crm_leads",
    filter: `pipeline_id=eq.${pipelineId}`,
    onChange: (payload) => {
      const lead = payload.new as LeadRow | undefined;
      if (lead && draggingRef.current.has(lead.id)) return; // ignora salto
      qc.setQueryData<BoardData>(queryKey, (prev) =>
        prev ? mergeLead(prev, payload) : prev,
      );
    },
  });

  return query;
}
```

**Decisão (PRD §6.6):** **patch in-place**, não refetch. UPDATE com mesma `(stage_id, position_in_stage)` que o cliente já tem é ignorado. UPDATE de lead em `dragging` set é ignorado para não causar "salto" durante o drag.

### 4.5 Detecção de canal caído + UX de reconexão

Provider raiz expõe `realtimeHealth` para qualquer componente.

```ts
// app/(app)/layout.tsx (parcial)
"use client";

const RECONNECT_TIMEOUT_MS = 3000;

export function RealtimeHealthProvider({ children }: PropsWithChildren) {
  const [healthy, setHealthy] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const downSinceRef = useRef<number | null>(null);

  // Hook global ouve um canal heartbeat ("org-{id}-heartbeat") postgres_changes
  // sobre tabela 'realtime_heartbeat' com row updada server-side via cron 30s.
  useRealtimeChannel({
    channel: `org-${orgId}-heartbeat`,
    table: "realtime_heartbeat",
    onStatusChange: (s) => {
      if (s === "subscribed") {
        downSinceRef.current = null;
        if (reconnecting) {
          toast.success("Conexão restabelecida");
          setReconnecting(false);
        }
        setHealthy(true);
      } else if (s === "channel_error" || s === "timed_out") {
        if (!downSinceRef.current) downSinceRef.current = Date.now();
        const elapsed = Date.now() - downSinceRef.current;
        if (elapsed > RECONNECT_TIMEOUT_MS) {
          setHealthy(false);
          setReconnecting(true);
        }
      }
    },
  });

  return (
    <RealtimeHealthCtx.Provider value={{ healthy, reconnecting }}>
      {!healthy && <ChannelStatusBanner />}
      {children}
    </RealtimeHealthCtx.Provider>
  );
}
```

`<ChannelStatusBanner>`: barra amarela `bg-yellow-100 text-yellow-900`, ícone `AlertTriangle`, texto "Reconectando ao tempo real…", `role="status"` `aria-live="polite"`.

Se a desconexão durar >30s, ao reconectar invalidamos as queries dos canais críticos:

```ts
useEffect(() => {
  if (healthy && reconnecting === false && wasDownLong.current) {
    qc.invalidateQueries({ queryKey: ["conversations"] });
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["board"] });
    wasDownLong.current = false;
  }
}, [healthy, reconnecting]);
```

---

## 5. Componentes de Inbox (3 colunas)

### 5.1 `<ConversationList>`

Coluna 1 (desktop ~340px). Search, filtros, lista virtualizada.

```ts
// components/inbox/ConversationList.tsx
"use client";

export interface ConversationListProps {
  orgId: string;
  selectedId?: string;
  initialFilter?: ConversationFilter;
}

export type ConversationFilterKey =
  | "all"
  | "unread"
  | "open"
  | "pending"
  | "resolved"
  | "mine"
  | "unassigned";

export interface ConversationFilter {
  key: ConversationFilterKey;
  search?: string;
  channel?: "whatsapp" | null;
  pipelineId?: string | null;
}
```

```tsx
export function ConversationList({
  orgId,
  selectedId,
  initialFilter = { key: "all" },
}: ConversationListProps) {
  const [filter, setFilter] = useState(initialFilter);
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 250);

  const effectiveFilter = useMemo(
    () => ({ ...filter, search: debouncedSearch || undefined }),
    [filter, debouncedSearch],
  );

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["conversations", orgId, effectiveFilter],
      queryFn: ({ pageParam }) =>
        api.conversations.list({ orgId, filter: effectiveFilter, cursor: pageParam }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor,
    });

  // realtime patch
  useConversationsRealtime(orgId, effectiveFilter);

  const items = useMemo(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  );

  return (
    <div className="flex flex-col h-full border-r bg-background">
      <div className="p-3 border-b space-y-2">
        <Input
          placeholder="Buscar conversas…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar conversas"
        />
        <ConversationFilters value={filter} onChange={setFilter} />
      </div>
      <ScrollArea
        className="flex-1"
        onScrollEnd={() => hasNextPage && !isFetchingNextPage && fetchNextPage()}
      >
        <ul role="list" aria-label="Conversas">
          {items.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
            />
          ))}
        </ul>
        {isFetchingNextPage && <ListSkeleton rows={4} />}
      </ScrollArea>
    </div>
  );
}
```

`<ConversationItem>` props:

```ts
interface ConversationItemProps {
  conversation: ConversationListItem;
  selected: boolean;
}

interface ConversationListItem {
  id: string;
  contact: { id: string; name: string | null; phone: string; avatar_url?: string };
  channel: "whatsapp";
  status: "open" | "pending" | "resolved";
  last_message_preview: string;          // truncado a 140 chars no servidor
  last_message_at: string;               // ISO
  unread_count: number;
  pipeline_tag: { name: string; color: string } | null;
  assigned_to_user_id: string | null;
  is_supervisor_view: boolean;
}
```

Render visual (textual mockup):

```
┌─────────────────────────────────────────────┐
│ ⚪ João Silva           14:32   [3 não-lid] │
│ +55 11 99999-1234            🟢 WhatsApp    │
│ Oi, recebi o produto mas tem… Pedidos       │
└─────────────────────────────────────────────┘
```

### 5.2 `<ChatThread>`

Coluna 2. Header + scroll de mensagens + composer + typing indicator.

```ts
export interface ChatThreadProps {
  conversationId: string;
  currentUserId: string;
  isSupervisorView: boolean;            // composer disabled se true
}
```

```tsx
"use client";
export function ChatThread({
  conversationId,
  currentUserId,
  isSupervisorView,
}: ChatThreadProps) {
  const conversation = useConversation(conversationId);
  const messages = useMessages(conversationId); // useQuery
  useMessagesRealtime(conversationId);
  const { typingUsers } = useTypingIndicator(conversationId, currentUserId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Auto-scroll só se atendente já estava no fim quando msg nova chegou
  useEffect(() => {
    if (wasAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.data?.length]);

  return (
    <div className="flex flex-col h-full bg-muted/20">
      <ChatHeader
        conversation={conversation.data}
        isSupervisorView={isSupervisorView}
        currentUserId={currentUserId}
      />
      {isSupervisorView && <SupervisorBanner />}
      <ScrollArea
        ref={scrollRef}
        className="flex-1 px-4 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          wasAtBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 50;
        }}
      >
        {messages.data?.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            isOwn={m.direction === "outbound" && m.sent_by_user_id === currentUserId}
          />
        ))}
        {typingUsers.size > 0 && <TypingIndicator users={typingUsers} />}
      </ScrollArea>
      <Composer
        conversationId={conversationId}
        disabled={isSupervisorView || conversation.data?.status === "resolved"}
      />
    </div>
  );
}
```

`<MessageBubble>` discrimina por `message.type`:

```ts
type MessageType =
  | "text" | "image" | "audio" | "video" | "document"
  | "location" | "reaction" | "note";

// Estilo:
// - inbound: align-left, bg-white
// - outbound (humano): align-right, bg-primary/10
// - outbound (IA): align-right, bg-violet-50 + badge "IA"
// - note (interna): align-center, bg-amber-50, ícone StickyNote, badge "Nota interna"
```

### 5.3 `<CRMSidePanel>`

Coluna 3 (~360px). 4 seções colapsáveis.

```ts
export interface CRMSidePanelProps {
  conversationId: string;
  currentUserRole: "viewer" | "agent" | "manager" | "admin" | "platform_admin";
}
```

```tsx
export function CRMSidePanel({ conversationId, currentUserRole }: CRMSidePanelProps) {
  const conversation = useConversation(conversationId);
  const links = useLeadLinks(conversationId);
  const contact = conversation.data?.contact;

  return (
    <aside
      role="complementary"
      aria-label="Painel CRM"
      className="flex flex-col h-full border-l bg-background overflow-y-auto"
    >
      <ContactSection contact={contact} role={currentUserRole} />
      <Separator />
      <DealSection links={links.data ?? []} contactId={contact?.id} />
      <Separator />
      <NotesSection conversationId={conversationId} />
      <Separator />
      <TimelineSection
        leadIds={(links.data ?? []).map((l) => l.lead_id)}
        conversationId={conversationId}
      />
    </aside>
  );
}
```

#### `<DealSection>` — abas se >1 lead

```tsx
export function DealSection({
  links,
  contactId,
}: {
  links: LeadLink[];
  contactId?: string;
}) {
  const [activeLeadId, setActiveLeadId] = useState(links[0]?.lead_id);
  if (links.length === 0) {
    return <EmptyDeal contactId={contactId} />;
  }
  return (
    <section className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{vocab("deals")}</h3>
      {links.length > 1 && (
        <Tabs value={activeLeadId} onValueChange={setActiveLeadId}>
          <TabsList>
            {links.map((l) => (
              <TabsTrigger key={l.lead_id} value={l.lead_id}>
                {l.lead_title}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      <DealCard leadId={activeLeadId!} editableStage />
      <Button variant="outline" size="sm">
        {vocab("openTicket")}
      </Button>
    </section>
  );
}
```

#### `<NotesSection>`

```tsx
export function NotesSection({ conversationId }: { conversationId: string }) {
  const notes = useNotes(conversationId);
  const createNote = useCreateNote(conversationId);
  const [draft, setDraft] = useState("");

  return (
    <section className="p-4 space-y-2">
      <h3 className="text-sm font-medium flex items-center gap-1">
        <StickyNote className="h-4 w-4 text-amber-600" />
        Notas internas
      </h3>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Esta nota é visível apenas pra equipe."
        className="bg-amber-50/40 border-amber-200"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          disabled={!draft.trim()}
          onClick={async () => {
            await createNote.mutateAsync({ body: draft });
            setDraft("");
          }}
        >
          Salvar nota
        </Button>
      </div>
      <ul className="space-y-2">
        {notes.data?.map((n) => <NoteItem key={n.id} note={n} />)}
      </ul>
    </section>
  );
}
```

### 5.4 Mobile responsive — 2 rotas, 100dvh

```tsx
// app/(app)/inbox/page.tsx
export default async function InboxPage() {
  return (
    <div className="h-[100dvh] grid grid-cols-1 md:grid-cols-[340px_1fr_360px]">
      <ConversationList orgId={...} />
      {/* desktop: thread inline; mobile: empty state */}
      <div className="hidden md:flex md:flex-col">
        <EmptyThread />
      </div>
      <div className="hidden xl:block">
        <EmptyPanel />
      </div>
    </div>
  );
}

// app/(app)/inbox/[conversationId]/page.tsx
export default function ConversationPage({ params }: ...) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  return (
    <div className="h-[100dvh] grid grid-cols-1 md:grid-cols-[340px_1fr_360px]">
      {!isMobile && <ConversationList selectedId={params.conversationId} />}
      <ChatThread conversationId={params.conversationId} ... />
      {isMobile ? (
        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="ghost" size="icon" className="fixed top-3 right-3">
              <Info />
            </Button>
          </DrawerTrigger>
          <DrawerContent className="h-[85dvh]">
            <CRMSidePanel ... />
          </DrawerContent>
        </Drawer>
      ) : (
        <CRMSidePanel ... />
      )}
    </div>
  );
}
```

Pontos críticos mobile:
- `h-[100dvh]` (Tailwind `dvh`) em vez de `100vh` — Safari iOS encolhe viewport com URL bar.
- `pb-[env(safe-area-inset-bottom)]` no Composer.
- `inputMode="text"`, `autoCorrect="off"` no Composer textarea pra evitar aria do iOS.
- Tap targets mínimos 44×44px.

---

## 6. Componente Kanban

### 6.1 `<KanbanBoard>`

```ts
export interface KanbanBoardProps {
  pipelineId: string;
  initialFilters?: BoardFilters;
}

interface BoardData {
  pipeline: Pipeline;
  stages: Stage[];                       // ordenadas por position
  cardsByStage: Record<string, KanbanCardData[]>;
}
```

```tsx
"use client";
export function KanbanBoard({ pipelineId, initialFilters }: KanbanBoardProps) {
  const [filters, setFilters] = useState<BoardFilters>(initialFilters ?? {});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const board = useBoard(pipelineId, filters);
  const moveCard = useMoveCard(pipelineId);

  const onDragEnd = useCallback(
    async (result: DropResult) => {
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (
        source.droppableId === destination.droppableId &&
        source.index === destination.index
      ) {
        return;
      }
      const cards = board.data!.cardsByStage[destination.droppableId] ?? [];
      const prev = cards[destination.index - 1]?.position_in_stage ?? null;
      const next = cards[destination.index]?.position_in_stage ?? null;
      const newPos = midpoint(prev, next);
      try {
        await moveCard.mutateAsync({
          leadId: draggableId,
          stageId: destination.droppableId,
          positionInStage: newPos,
        });
      } catch (err) {
        if (isConflictError(err)) {
          toast.error("Outro atendente moveu esse card. Recarregando…");
          board.refetch();
        } else {
          toast.error("Falha ao mover. Tente novamente.");
        }
      }
    },
    [board, moveCard],
  );

  if (board.isLoading) return <KanbanSkeleton />;
  if (!board.data) return null;

  return (
    <div className="flex flex-col h-full">
      <KanbanFilters value={filters} onChange={setFilters} />
      {selected.size > 0 && (
        <BulkActionBar
          count={selected.size}
          pipelineId={pipelineId}
          leadIds={Array.from(selected)}
          onClear={() => setSelected(new Set())}
        />
      )}
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex-1 flex gap-3 overflow-x-auto p-3">
          {board.data.stages.map((stage) => (
            <KanbanColumn
              key={stage.id}
              stage={stage}
              cards={board.data!.cardsByStage[stage.id] ?? []}
              selected={selected}
              onToggleSelect={(id) =>
                setSelected((s) => {
                  const n = new Set(s);
                  n.has(id) ? n.delete(id) : n.add(id);
                  return n;
                })
              }
            />
          ))}
        </div>
      </DragDropContext>
    </div>
  );
}
```

### 6.2 `<KanbanCard>`

```ts
interface KanbanCardData {
  id: string;
  title: string;
  value_cents: number | null;
  currency: "BRL";
  owner: { id: string; name: string; avatar_url?: string } | null;
  tags: { id: string; name: string; color: string }[];
  status: "open" | "won" | "lost";
  expected_close_date: string | null;
  last_activity_at: string | null;
  position_in_stage: number;
  is_overdue: boolean;
}

interface KanbanCardProps {
  card: KanbanCardData;
  index: number;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}
```

```tsx
export function KanbanCard({ card, index, selected, onToggleSelect }: KanbanCardProps) {
  const vocab = usePipelineVocabulary();
  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={cn(
            "group rounded-lg border bg-card p-3 shadow-sm",
            "hover:shadow-md transition-shadow",
            snapshot.isDragging && "ring-2 ring-primary shadow-lg rotate-1",
            selected && "ring-2 ring-primary",
          )}
          aria-label={`${vocab.deal} ${card.title}`}
        >
          <div className="flex items-start gap-2">
            <Checkbox
              checked={selected}
              onCheckedChange={() => onToggleSelect(card.id)}
              onClick={(e) => e.stopPropagation()}
              aria-label="Selecionar card"
            />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{card.title}</p>
              {card.value_cents != null && (
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(card.value_cents, card.currency)}
                </p>
              )}
            </div>
            {card.owner && (
              <Avatar className="h-6 w-6">
                <AvatarImage src={card.owner.avatar_url} />
                <AvatarFallback>{initials(card.owner.name)}</AvatarFallback>
              </Avatar>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {card.tags.slice(0, 3).map((t) => (
              <Badge key={t.id} style={{ backgroundColor: t.color }}>
                {t.name}
              </Badge>
            ))}
            {card.tags.length > 3 && (
              <Badge variant="outline">+{card.tags.length - 3}</Badge>
            )}
            {card.is_overdue && (
              <Badge variant="destructive" className="ml-auto">
                Atrasado
              </Badge>
            )}
          </div>
          {card.last_activity_at && (
            <p className="mt-2 text-[10px] text-muted-foreground">
              {formatDistanceToNow(new Date(card.last_activity_at), {
                addSuffix: true,
                locale: ptBR,
              })}
            </p>
          )}
        </div>
      )}
    </Draggable>
  );
}
```

### 6.3 Drag-drop com `@hello-pangea/dnd`

Fluxo exato `onDragEnd`:

1. Calcular `midpoint(prev, next)` localmente — `lib/utils/fractional-index.ts`:

```ts
export function midpoint(prev: number | null, next: number | null): number {
  if (prev == null && next == null) return 1000;
  if (prev == null) return next! - 1;
  if (next == null) return prev + 1;
  return (prev + next) / 2;
}
```

2. Patch otimista no cache:

```ts
// hooks/data/useMoveCard.ts
export function useMoveCard(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: MoveCardVars) =>
      api.leads.move(vars.leadId, {
        stage_id: vars.stageId,
        position_in_stage: vars.positionInStage,
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["board", pipelineId] });
      const prev = qc.getQueryData<BoardData>(["board", pipelineId]);
      qc.setQueryData<BoardData>(["board", pipelineId], (old) =>
        old ? applyMoveOptimistic(old, vars) : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["board", pipelineId], ctx.prev);
    },
    onSettled: () => {
      // não invalida — Realtime virá com a versão final
    },
  });
}
```

3. Em 409 (conflito), `onError` rollback + toast + refetch (handler no `onDragEnd`).

### 6.4 Filtros

```tsx
export function KanbanFilters({ value, onChange }: KanbanFiltersProps) {
  return (
    <div className="flex items-center gap-2 p-3 border-b">
      <OwnerSelect value={value.ownerId} onChange={(id) => onChange({ ...value, ownerId: id })} />
      <StatusMultiSelect value={value.status} onChange={(s) => onChange({ ...value, status: s })} />
      <TagMultiSelect value={value.tagIds} onChange={(t) => onChange({ ...value, tagIds: t })} />
      <Input
        placeholder="Buscar pelo título…"
        value={value.search ?? ""}
        onChange={(e) => onChange({ ...value, search: e.target.value })}
        className="w-64 ml-auto"
      />
    </div>
  );
}
```

Filtros sincronizam com URL via `useSearchParams` (Next.js):

```ts
useEffect(() => {
  const params = new URLSearchParams();
  if (filters.ownerId) params.set("owner", filters.ownerId);
  if (filters.search) params.set("q", filters.search);
  router.replace(`?${params.toString()}`, { scroll: false });
}, [filters]);
```

### 6.5 Bulk actions

```ts
type BulkAction =
  | { type: "move_stage"; stage_id: string }
  | { type: "assign_owner"; user_id: string }
  | { type: "add_tag"; tag_id: string }
  | { type: "remove_tag"; tag_id: string };

export function useBulkAction(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { leadIds: string[]; action: BulkAction }) => {
      // AT-06: limite 50
      if (vars.leadIds.length > 50) {
        throw new ApiError(422, "bulk_too_large", {
          message: "Selecione até 50 cards por vez.",
        });
      }
      return api.leads.bulk(vars);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", pipelineId] }),
  });
}
```

`<BulkActionBar>` aparece flutuante no topo quando `selected.size > 0`:

```
┌──────────────────────────────────────────────┐
│ 12 selecionados   [Mover ▾] [Atribuir ▾] ... │
│                                       [Limpar] │
└──────────────────────────────────────────────┘
```

### 6.6 Refetch vs patch in-place

**Decisão:** patch in-place. Após drop bem-sucedido, NÃO invalidamos `["board", ...]` no `onSettled` — confiamos no Realtime para confirmar (e ele virá com `(stage_id, position_in_stage)` igual ao otimista, então o merge é no-op).

UPDATE de Realtime que chega para card em `dragging` é silenciado (§4.4) — protege contra "salto" enquanto o usuário ainda segura o card.

UPDATE com a mesma `(stage_id, position_in_stage)` que já está no cache é detectado e ignorado em `mergeLead`:

```ts
function mergeLead(board: BoardData, payload: PostgresChange<LeadRow>): BoardData {
  const lead = payload.new as LeadRow;
  // detecta no-op
  const current = findCard(board, lead.id);
  if (
    current &&
    current.stage_id === lead.stage_id &&
    current.position_in_stage === lead.position_in_stage &&
    current.status === lead.status
  ) {
    return board;
  }
  return rebuildBoard(board, lead);
}
```

---

## 7. Send Message Hook

### 7.1 `useSendMessage`

```ts
// hooks/data/useSendMessage.ts
import { v4 as uuid } from "uuid";

interface SendMessageVars {
  type: MessageType;
  body?: string;
  media?: { storage_path: string; mime_type: string };
  internal?: boolean;                    // nota interna
  client_message_id?: string;
}

export function useSendMessage(conversationId: string) {
  const qc = useQueryClient();
  const currentUser = useCurrentUser();

  return useMutation({
    mutationFn: async (vars: SendMessageVars) => {
      const cmid = vars.client_message_id ?? uuid();
      return api.messages.create(conversationId, {
        ...vars,
        client_message_id: cmid,
      });
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["messages", conversationId] });
      const cmid = vars.client_message_id ?? uuid();
      const optimistic: MessageRow = {
        id: `optimistic-${cmid}`,
        client_message_id: cmid,
        conversation_id: conversationId,
        type: vars.type,
        body: vars.body ?? null,
        direction: "outbound",
        sent_by_user_id: currentUser.id,
        status: "sending",
        is_internal: vars.internal ?? false,
        created_at: new Date().toISOString(),
        media: vars.media ?? null,
      };
      qc.setQueryData<MessageRow[]>(
        ["messages", conversationId],
        (prev) => [...(prev ?? []), optimistic],
      );
      return { cmid, optimistic };
    },
    onError: (err, _vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData<MessageRow[]>(
        ["messages", conversationId],
        (prev) =>
          (prev ?? []).map((m) =>
            m.client_message_id === ctx.cmid
              ? { ...m, status: "failed" as const, error: serialize(err) }
              : m,
          ),
      );
      toast.error("Falha ao enviar. Toque na bolha pra reenviar.");
    },
    onSuccess: (server, _vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData<MessageRow[]>(
        ["messages", conversationId],
        (prev) =>
          (prev ?? []).map((m) =>
            m.client_message_id === ctx.cmid ? server : m,
          ),
      );
    },
  });
}
```

Bolha em `status='sending'` mostra ícone de relógio; em `status='failed'`, ícone de alerta vermelho com `onClick={retry}`.

### 7.2 `<Composer>`

```tsx
"use client";
export function Composer({ conversationId, disabled }: ComposerProps) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const send = useSendMessage(conversationId);
  const { emitTyping } = useTypingIndicator(conversationId, useCurrentUser().id);

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text || send.isPending) return;
    setBody("");
    // AT-07: chunking >4096 é feito server-side; cliente envia 1 mensagem
    await send.mutateAsync({
      type: internal ? "note" : "text",
      body: text,
      internal,
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        "border-t bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]",
        internal && "bg-amber-50",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <Switch
          id="internal-toggle"
          checked={internal}
          onCheckedChange={setInternal}
          disabled={disabled}
        />
        <Label htmlFor="internal-toggle" className="text-xs">
          Nota interna (não envia ao cliente)
        </Label>
      </div>
      <div className="flex items-end gap-2">
        <AttachmentButton conversationId={conversationId} disabled={disabled} />
        <Textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (!internal) emitTyping();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onSubmit();
            if (e.key === "/" && body === "") {
              e.preventDefault();
              setQuickReplyOpen(true);
            }
          }}
          rows={1}
          maxLength={8000}
          placeholder={
            internal ? "Nota interna…" : "Digite uma mensagem…"
          }
          disabled={disabled}
          className="resize-none min-h-[40px] max-h-[200px]"
        />
        <EmojiButton onPick={(e) => setBody((b) => b + e)} />
        <Button type="submit" disabled={disabled || !body.trim() || send.isPending}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
```

### 7.3 Quick replies / templates

```ts
interface QuickReplyTemplate {
  id: string;
  title: string;                         // "Saudação"
  body: string;                          // "Olá {nome}, vi que..."
  required_vars: string[];               // ["nome"]
}

function interpolate(
  body: string,
  vars: Record<string, string | undefined>,
): { ok: boolean; result: string; missing: string[] } {
  const missing: string[] = [];
  const result = body.replace(/\{(\w+)\}/g, (_, k) => {
    if (!vars[k]) {
      missing.push(k);
      return `{${k}}`;
    }
    return vars[k]!;
  });
  return { ok: missing.length === 0, result, missing };
}
```

`<QuickReplyMenu>` abre via `/`, renderiza `<Command>` (cmdk) com fuzzy search:

```tsx
<Command>
  <CommandInput placeholder="Buscar template…" />
  <CommandList>
    {templates.map((t) => (
      <CommandItem
        key={t.id}
        onSelect={() => {
          const interp = interpolate(t.body, contextVars);
          if (!interp.ok) {
            toast.error(`Variáveis pendentes: ${interp.missing.join(", ")}`);
            return;
          }
          setBody(interp.result);
          close();
        }}
      >
        {t.title}
      </CommandItem>
    ))}
  </CommandList>
</Command>
```

---

## 8. Atendimento — Status do Atendente

### 8.1 `<AttendantStatusToggle>`

```ts
type AgentStatus = "online" | "busy" | "offline";

export interface AttendantStatusToggleProps {
  // sem props — lê do hook
}
```

```tsx
export function AttendantStatusToggle() {
  const { status, setStatus, pinned, setPinned } = useAgentStatus();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2">
          <StatusDot status={status} />
          {labelFor(status)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {(["online", "busy", "offline"] as const).map((s) => (
          <DropdownMenuItem key={s} onClick={() => setStatus(s)}>
            <StatusDot status={s} /> {labelFor(s)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={pinned}
          onCheckedChange={setPinned}
        >
          Manter online (não auto-offline)
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`StatusDot`: bolinha colorida — `bg-green-500` (online), `bg-amber-500` (busy), `bg-zinc-400` (offline).

### 8.2 Heartbeat de UI (60s) + auto-offline 15min — AT-08

```ts
// hooks/presence/useHeartbeat.ts
const HEARTBEAT_MS = 60_000;

export function useHeartbeat() {
  const { status, pinned } = useAgentStatus();
  useEffect(() => {
    if (status === "offline") return;
    const tick = () => api.presence.heartbeat({ status, pinned });
    tick();
    const id = setInterval(tick, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [status, pinned]);
}

// hooks/presence/useInactivityDetector.ts
const INACTIVITY_MS = 15 * 60_000;

export function useInactivityDetector() {
  const { status, setStatus, pinned } = useAgentStatus();
  const lastActivityRef = useRef(Date.now());

  useEffect(() => {
    const bump = () => (lastActivityRef.current = Date.now());
    const events = ["mousemove", "keydown", "click", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    return () =>
      events.forEach((e) => window.removeEventListener(e, bump));
  }, []);

  useEffect(() => {
    if (pinned || status !== "online") return;
    const id = setInterval(() => {
      if (Date.now() - lastActivityRef.current > INACTIVITY_MS) {
        setStatus("offline");
        toast.info("Status alterado para offline por inatividade.");
      }
    }, 30_000);
    return () => clearInterval(id);
  }, [status, pinned, setStatus]);
}
```

Worker server-side complementar (Spec 01): se servidor não recebe heartbeat por 90s, marca atendente como `offline` (defesa contra fechar aba sem `beforeunload`).

### 8.3 Auto-assignment hook

UI side é apenas exibir "fila Sem responsável" quando `assigned_to_user_id IS NULL`. Lógica de round-robin (AT-03) é worker server-side. Frontend apenas:

```tsx
function UnassignedQueueAlert() {
  const { data } = useQuery({
    queryKey: ["unassigned-count"],
    queryFn: api.conversations.unassignedCount,
    refetchInterval: 30_000,
  });
  if (!data?.count) return null;
  return (
    <Alert variant="warning">
      <AlertTriangle />
      {data.count} conversas sem responsável.{" "}
      <Link href="/inbox?filter=unassigned">Ver fila</Link>
    </Alert>
  );
}
```

---

## 9. "Eu cuido" Flow — claim atômico (AT-02)

### 9.1 Modal de confirmação

```tsx
export function ClaimButton({ conversationId, status, assigned_to }: ClaimButtonProps) {
  const claim = useClaimConversation(conversationId);
  const [open, setOpen] = useState(false);

  if (assigned_to) return null; // só aparece se não tiver dono

  return (
    <>
      <Button onClick={() => setOpen(true)} variant="default" size="sm">
        Eu cuido
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assumir esta conversa?</DialogTitle>
            <DialogDescription>
              Você ficará responsável por responder este cliente até resolver
              ou reatribuir.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={async () => {
                await claim.mutateAsync();
                setOpen(false);
              }}
              disabled={claim.isPending}
            >
              {claim.isPending ? "Assumindo…" : "Sim, assumir"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

### 9.2 API atomic UPDATE

Server-side (resumo — Spec 01 detalha):

```sql
UPDATE conversations
SET assigned_to_user_id = $caller, updated_at = now()
WHERE id = $conv AND assigned_to_user_id IS NULL
RETURNING *;
```

Se 0 rows retornadas, API responde 409 com `{ code: "conversation_already_claimed", details: { assigned_to_user_id } }`.

### 9.3 Tratamento de 409

```ts
export function useClaimConversation(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.conversations.claim(conversationId),
    onSuccess: (server) => {
      qc.setQueryData(["conversation", conversationId], server);
      toast.success("Você assumiu esta conversa");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "conversation_already_claimed") {
        toast.error(
          `Outro atendente já assumiu esta conversa.${err.details?.assigned_to_name ? " (" + err.details.assigned_to_name + ")" : ""}`,
        );
        // refetch pra UI refletir o vencedor
        qc.invalidateQueries({ queryKey: ["conversation", conversationId] });
      } else {
        toast.error("Erro ao assumir. Tente novamente.");
      }
    },
  });
}
```

---

## 10. Supervisor Read-Only Mode (AT-04)

### 10.1 Detecção

```ts
export function useSupervisorView(conversationId: string): boolean {
  const me = useCurrentUser();
  const conv = useConversation(conversationId);
  if (!conv.data) return false;
  const isOwner = conv.data.assigned_to_user_id === me.id;
  const canSupervise = ["manager", "admin", "platform_admin"].includes(me.role);
  return canSupervise && !isOwner;
}
```

### 10.2 UI desabilita composer

`<ChatThread>` recebe `isSupervisorView`; `<SupervisorBanner>` renderiza acima do scroll:

```tsx
export function SupervisorBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-4 py-2 bg-violet-100 text-violet-900 text-sm border-b"
    >
      <Eye className="h-4 w-4" />
      <span>Modo supervisor — você está visualizando, não pode enviar mensagens.</span>
    </div>
  );
}
```

Composer recebe `disabled={isSupervisorView}` (§5.2). API server-side também valida (camada de defesa) — se um atendente tentar `POST /messages` sem ser owner, recebe 403.

### 10.3 Audit log

Ao montar `<ChatThread>` em modo supervisor, dispara endpoint de audit (fire-and-forget):

```ts
useEffect(() => {
  if (isSupervisorView) {
    api.audit.log({
      action: "conversation.observed_by_supervisor",
      resource_type: "conversation",
      resource_id: conversationId,
    });
  }
}, [isSupervisorView, conversationId]);
```

Importante: dedup server-side por `(user_id, conversation_id, hour_bucket)` evita spam de audit a cada montagem.

---

## 11. Pipeline Vocabulary Integration (P-07)

### 11.1 `usePipelineVocabulary`

```ts
// hooks/pipeline/usePipelineVocabulary.ts
export interface PipelineVocabulary {
  lead: string;       // "Cliente"
  deal: string;       // "Pedido"
  deals: string;      // "Pedidos"
  stage: string;      // "Estágio"
  won: string;        // "Pago"
  lost: string;       // "Cancelado"
  openTicket: string; // "Abrir ticket"
  // …
}

export function usePipelineVocabulary(
  pipelineId?: string,
): PipelineVocabulary {
  const ctx = useContext(PipelineContext);
  const id = pipelineId ?? ctx?.pipelineId;
  const { data } = useQuery({
    queryKey: ["pipeline-vocabulary", id],
    queryFn: () => api.pipelines.vocabulary(id!),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
  return data ?? DEFAULT_VOCAB;
}

const DEFAULT_VOCAB: PipelineVocabulary = {
  lead: "Cliente",
  deal: "Pedido",
  deals: "Pedidos",
  stage: "Estágio",
  won: "Pago",
  lost: "Cancelado",
  openTicket: "Abrir ticket",
};
```

### 11.2 Cache + invalidation

Quando `manager+` edita vocabulary em `/pipeline/[id]/settings`:

```ts
export function useUpdateVocabulary(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vocab: Partial<PipelineVocabulary>) =>
      api.pipelines.updateVocabulary(pipelineId, vocab),
    onSuccess: (server) => {
      qc.setQueryData(["pipeline-vocabulary", pipelineId], server);
      // invalida componentes que renderizaram com strings velhas
      qc.invalidateQueries({ queryKey: ["pipeline", pipelineId] });
    },
  });
}
```

Realtime: vocabulary é parte de `crm_pipelines.settings`. Subscribe em `pipelines` filter `id=eq.${pipelineId}` propaga mudança a outros admins logados.

### 11.3 Linter custom contra strings hardcoded em PT

Plugin `eslint-plugin-deskcomm` com regra `no-hardcoded-vocabulary`. Bloqueia em `.tsx` strings literais que parecem vocabulary:

```js
// eslint-plugin-deskcomm/rules/no-hardcoded-vocabulary.js
const FORBIDDEN = [
  "Cliente", "Clientes",
  "Pedido", "Pedidos",
  "Negócio", "Negócios",
  "Lead", "Leads",
  "Ticket", "Tickets",
  "Estágio", "Estágios",
  "Pago", "Cancelado", "Ganho", "Perdido",
];

module.exports = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const filename = context.getFilename();
    if (!/components\/(inbox|kanban|attendance|dashboard)/.test(filename)) {
      return {};
    }
    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (FORBIDDEN.includes(node.value)) {
          context.report({
            node,
            message:
              `String "${node.value}" parece vocabulary; use vocab.${suggest(node.value)}() ou import de DEFAULT_VOCAB.`,
          });
        }
      },
    };
  },
};
```

Whitelist via `// deskcomm-allow-vocab: <razão>`. CI roda `eslint --max-warnings 0` no diff dos PRs.

---

## 12. Notas Internas (AT-05)

### 12.1 Toggle "interno" no composer

Já mostrado em §7.2. Switch `internal` muda:
- `body` aparece com background `bg-amber-50`
- placeholder vira "Nota interna…"
- send dispara `type='note'` `internal=true`

### 12.2 Activity tipo `note`

Server-side (worker outbound) **NÃO consome** `activity.type='note'` — garantia AT-05. Cliente apenas envia metadata correta.

### 12.3 UI distintiva

`<NoteBubble>`:

```tsx
export function NoteBubble({ message }: { message: MessageRow }) {
  return (
    <div
      role="article"
      aria-label="Nota interna"
      className="mx-auto max-w-[80%] rounded-md bg-amber-50 border border-amber-200 px-3 py-2 my-2 text-sm flex items-start gap-2"
    >
      <StickyNote className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="text-[10px] text-amber-700 mb-1 flex items-center gap-1">
          <Badge variant="outline" className="text-[10px] py-0">Nota interna</Badge>
          <span>{message.author_name}</span>
          <span>·</span>
          <span>{formatRelative(message.created_at)}</span>
        </div>
        <p className="text-amber-900 whitespace-pre-wrap">{message.body}</p>
      </div>
    </div>
  );
}
```

Centralizada na thread (não align-left/right) para diferenciar visualmente de qualquer mensagem outbound humana ou IA.

---

## 13. Dashboard Lite (admin do tenant)

Rota `/dashboard/atendimento`. Grid 2×2 de cards.

### 13.1 Conversas abertas por atendente

```tsx
export function OpenConversationsCard() {
  const { data } = useQuery({
    queryKey: ["dash", "open-by-agent"],
    queryFn: api.dashboards.openByAgent,
    refetchInterval: 30_000,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Conversas abertas por atendente</CardTitle>
      </CardHeader>
      <CardContent>
        <ul>
          {data?.map((row) => (
            <li key={row.user_id} className="flex justify-between py-1">
              <span>{row.name}</span>
              <Badge>{row.count}</Badge>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
```

### 13.2 Tempo médio de primeira resposta (hoje)

```tsx
<MetricCard
  title="Tempo médio 1ª resposta (hoje)"
  value={data?.avg_seconds ? formatDuration(data.avg_seconds) : "—"}
  delta={data?.delta_pct}
  goal="< 5min"
/>
```

### 13.3 Conversas pendentes (cliente esperando >10min)

```tsx
<Card>
  <CardHeader>
    <CardTitle>Aguardando atendimento</CardTitle>
  </CardHeader>
  <CardContent>
    <p className="text-3xl font-semibold">{data?.count ?? 0}</p>
    <p className="text-xs text-muted-foreground">
      Cliente esperando há mais de 10 min
    </p>
    <Button asChild variant="link" size="sm">
      <Link href="/inbox?filter=pending&waiting_min=10">Ver fila</Link>
    </Button>
  </CardContent>
</Card>
```

### 13.4 Taxa de resolução por atendente

```tsx
<Card>
  <CardHeader><CardTitle>Resolução (hoje)</CardTitle></CardHeader>
  <CardContent>
    {data?.map((row) => (
      <div key={row.user_id} className="flex items-center gap-2 py-1">
        <Avatar className="h-5 w-5"><AvatarFallback>{initials(row.name)}</AvatarFallback></Avatar>
        <span className="flex-1 text-sm">{row.name}</span>
        <span className="text-sm tabular-nums">
          {row.resolved}/{row.total}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums w-12 text-right">
          {Math.round((row.resolved / Math.max(row.total, 1)) * 100)}%
        </span>
      </div>
    ))}
  </CardContent>
</Card>
```

`agent` vê apenas a própria linha; `manager+` vê todas (RLS aplica server-side).

---

## 14. Componentes shadcn/ui usados (lista exaustiva)

| Componente | Uso |
|---|---|
| `Avatar`, `AvatarImage`, `AvatarFallback` | ConversationItem, KanbanCard, NoteBubble, ResolutionRateCard |
| `Badge` | unread, tag, "IA", "Atrasado", "Nota interna" |
| `Button` | em todo lugar |
| `Card`, `CardHeader`, `CardTitle`, `CardContent` | Dashboard cards, KanbanCard |
| `Checkbox` | bulk select kanban |
| `Command`, `CommandInput`, `CommandList`, `CommandItem` | QuickReplyMenu |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` | ClaimButton, ReassignDialog, criar pipeline |
| `Drawer`, `DrawerContent`, `DrawerTrigger` | mobile CRMSidePanel |
| `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuCheckboxItem`, `DropdownMenuSeparator` | AttendantStatusToggle, ChatHeader "Mais", PipelineSwitcher |
| `Form`, `FormField`, `FormLabel`, `FormControl`, `FormMessage` | settings de pipeline |
| `Input` | search, filtros |
| `Label` | composer toggle, settings |
| `Popover`, `PopoverTrigger`, `PopoverContent` | EmojiPicker container, OwnerSelect filter |
| `ScrollArea` | ConversationList, ChatThread, CRMSidePanel |
| `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` | DealSection inline stage, filtros |
| `Separator` | divisores no SidePanel e em listas |
| `Sheet`, `SheetTrigger`, `SheetContent` | settings drawer pra criar pipeline em desktop |
| `Skeleton` | loading states |
| `Switch` | composer "interno", AttendantStatusToggle pinned |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | DealSection multi-lead |
| `Textarea` | Composer, NotesSection |
| `Tooltip`, `TooltipTrigger`, `TooltipContent` | StatusDot label, ícones do composer |

Custom (não shadcn):
- `<EmojiPicker>` (lazy-loaded `emoji-mart`)
- `<MessageBubble>` family
- `<KanbanCard>`, `<KanbanColumn>`, `<KanbanBoard>`
- `<ChannelStatusBanner>`
- `<TypingIndicator>`
- `<SupervisorBanner>`
- `<BulkActionBar>`

---

## 15. Design tokens

Herda Tailwind config de `01-spec-platform-base.md`. Resumo do que esta camada usa:

**Cores (tokens semânticos via shadcn):**
- `bg-background`, `bg-card`, `bg-muted` — superfícies
- `bg-primary` (envio outbound humano), `text-primary-foreground`
- `bg-violet-50` / `bg-violet-100` (IA, supervisor) — extensão custom
- `bg-amber-50` / `border-amber-200` (notas internas) — extensão custom
- `bg-yellow-100` (banner reconectando)
- `bg-green-500` / `bg-amber-500` / `bg-zinc-400` (status dots)
- `bg-destructive` (badge "Atrasado", erros de send)

**Spacing:** `gap-2/3` em flex; padding interno de cards `p-3` desktop / `p-4` mobile; ConversationItem altura ~76px; KanbanCard largura 280px desktop.

**Tipografia:**
- `text-sm` (14px) — texto padrão
- `text-xs` (12px) — metadata, timestamps
- `text-[10px]` — preview, badge counters
- `font-medium` — títulos de card, nome do contact
- `font-semibold` — títulos de seção do dashboard

**Densidade:** Inbox e Kanban são "high density UI" — alvo é caber 8–10 conversations sem scroll em laptop 13" (768px de altura útil).

---

## 16. Testes

### 16.1 Unit (Vitest + Testing Library)

Cobertura mínima:

| Componente / hook | Casos críticos |
|---|---|
| `midpoint()` | prev/next null, valores intermediários, números muito grandes/pequenos |
| `interpolate()` | variável presente, ausente (retorna `missing`), múltiplas, escapes |
| `useSendMessage` (com `MutationCache` mock) | optimistic insert, rollback em erro, dedup ao receber server response |
| `<MessageBubble>` (snapshot por tipo) | text, image, audio, document, location, note, IA |
| `<KanbanCard>` | render com 0/3/5 tags (overflow), is_overdue, sem owner |
| `<Composer>` | Cmd+Enter envia; "/" abre QuickReply; toggle internal muda placeholder |
| `<ConversationItem>` | unread badge, selected highlight, supervisor view badge |
| `useSupervisorView` | retorna false se owner; true se manager + não owner |

### 16.2 Integration

| Cenário | Verifica |
|---|---|
| Send + receive na mesma thread (mockando Realtime) | dedup por `client_message_id`, sem bolha duplicada |
| Drag-drop via `userEvent.pointer()` | `onDragEnd` chamado com source/destination corretos; `useMoveCard` invocado com `midpoint` certo |
| Claim concorrente | mock 409 → toast de erro + invalidação de cache |
| Supervisor abre conversa de outro atendente | banner aparece; composer disabled; audit é chamado |
| Quick reply com variável faltando | toast erro, body não é setado |

### 16.3 E2E (Playwright)

| Fluxo | Steps |
|---|---|
| Drag-drop persistente | login agent, abrir kanban, mover card "Pago" → "Em separação", reload, validar persistência |
| Send + Realtime cross-tab | abrir 2 abas mesma conversation, enviar de uma, validar bubble na outra em <2s |
| Claim concorrente | 2 contextos Playwright, ambos clicam "Eu cuido" simultaneamente, 1 vence, outro vê toast |
| Supervisor read-only | login manager, abrir conversa de outro agent, validar composer disabled |
| Mobile inbox | viewport iPhone 14, navegar `/chat` → tap item → `/chat/[id]`, abrir drawer painel CRM |
| Reconexão Realtime | usar Playwright `context.setOffline(true)` por 5s, validar banner; voltar online, validar recuperação sem duplicar |

---

## 17. Performance

### 17.1 Memoization

- `KanbanColumn` envolvida em `React.memo` com comparação rasa em `(stage.id, cards.length, cards[0]?.id, cards[last]?.id, selected.size)` — drop em coluna não dispara re-render das outras.
- `MessageBubble` em `React.memo` por `message.id, status, body`.
- `ConversationItem` em `React.memo` por `conversation.id, last_message_at, unread_count, selected`.
- Callbacks que descem props de muitos filhos via `useCallback`; estado de filtros lifted ao topo, não passado em cascata.

### 17.2 Virtualização

- **Conversations list:** `@tanstack/react-virtual` quando `items.length > 50`. Altura fixa 76px facilita.
- **Kanban column:** virtualização vertical quando uma coluna passa de **150 cards**. Threshold sai da literatura `react-window` (cards de altura variável exigem `VariableSizeList` ou medição). Decisão: **`@tanstack/react-virtual` com `estimateSize` 120px e `measureElement`**.
- **Timeline:** virtualização ao passar de 100 entries.

### 17.3 Code-splitting

- `<EmojiPicker>` lazy via `next/dynamic` (`ssr: false`).
- Kanban inteiro é client component em rota dedicada — sem bundling no `/inbox`.
- Settings de pipeline são rota separada.

### 17.4 Network

- TanStack Query `staleTime` defaults:
  - `["conversations", ...]` — 0s (sempre fresco; Realtime mantém)
  - `["messages", ...]` — 0s
  - `["board", ...]` — 30s
  - `["pipeline-vocabulary", ...]` — 5min
  - `["dash", ...]` — 30s
- Imagens via `next/image` com `loading="lazy"`.
- Mídias de mensagem: thumbnail no preview, lazy-load quando entra no viewport.

### 17.5 Realtime budget

≤ 4 canais por aba (PRD §3.12). Assertion runtime em desenvolvimento:

```ts
if (process.env.NODE_ENV === "development") {
  const channels = supabase.getChannels();
  if (channels.length > 4) {
    console.warn(`[realtime-budget] ${channels.length} canais ativos:`, channels.map(c => c.topic));
  }
}
```

Estratégia de consolidação: 1 canal `org-{id}-conversations` agrega INSERT/UPDATE de todas as conversations do tenant; thread atual abre `conv-{id}-messages` apenas enquanto montada; kanban abre `pipeline-{id}-leads` apenas na rota.

---

## Anexos

- `docs/prd/04-prd-pipeline-attendance.md` — sub-PRD origem
- `docs/business-rules/00-business-rules-catalog.md` — regras P-05, P-06, P-07, AT-01 a AT-08
- `docs/research/reference-synthesis.md` — §5 Frontend/Realtime, §9 Anti-patterns
- `docs/specs/01-spec-platform-base.md` — auth, audit, API conventions
- `docs/specs/02-spec-customer-360.md` — schema crm_*, fractional indexing
- `docs/specs/03-spec-whatsapp-waha.md` — conversations, messages, sessões

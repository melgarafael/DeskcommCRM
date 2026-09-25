"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";

/**
 * Conversas visíveis no Inbox e no painel flutuante. Cada provider registra
 * sua própria entrada: minimizar um painel não limpa a conversa do outro.
 * O listener de INSERT mora no AppShell
 * (ancestral), então além do contexto há um módulo-level lido no evento.
 */
const publishedIds = new Map<symbol, string>();

export function getOpenConversationId(candidate?: string | null): string | null {
  const ids = [...publishedIds.values()];
  if (candidate !== undefined) return candidate && ids.includes(candidate) ? candidate : null;
  return ids.at(-1) ?? null;
}

const Ctx = createContext<string | null>(null);

export function OpenConversationProvider({
  conversationId,
  children,
}: {
  conversationId: string | null;
  children: ReactNode;
}) {
  useEffect(() => {
    const owner = Symbol();
    if (conversationId) publishedIds.set(owner, conversationId);
    return () => {
      publishedIds.delete(owner);
    };
  }, [conversationId]);

  return <Ctx.Provider value={conversationId}>{children}</Ctx.Provider>;
}

export function useOpenConversationId(): string | null {
  return useContext(Ctx);
}

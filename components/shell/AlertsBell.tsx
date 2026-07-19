"use client";
import Link from "next/link";

import { useAgentInbox } from "@/hooks/ai/useAgentInbox";
import { Bell } from "@/lib/ui/icons";

/**
 * Sino da central de avisos (Operação Visível F1): contador de avisos abertos
 * do runtime do agente no header; clique leva a /app/ai/inbox.
 */
export function AlertsBell() {
  const { data } = useAgentInbox("open");
  const count = data?.open_count ?? 0;

  return (
    <Link
      href="/app/ai/inbox"
      aria-label={count > 0 ? `Central de avisos — ${count} em aberto` : "Central de avisos"}
      data-testid="alerts-bell"
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Bell size={18} aria-hidden />
      {count > 0 ? (
        <span
          data-testid="alerts-bell-count"
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}

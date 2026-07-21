"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/app/ai/agents", label: "Agentes" },
  { href: "/app/ai/credentials", label: "Credenciais" },
  { href: "/app/ai/knowledge/sources", label: "Conhecimento" },
  { href: "/app/ai/usage", label: "Uso" },
  { href: "/app/ai/inbox", label: "Inbox" },
];

const HUB_PATHS = new Set(TABS.map((t) => t.href));

/**
 * Abas da área de IA. Renderiza só nos hubs (lista de agents, credenciais,
 * conhecimento, uso, inbox) — telas de edição ([id]) ficam limpas.
 */
export function AiSectionTabs() {
  const pathname = usePathname();
  if (!HUB_PATHS.has(pathname)) return null;

  return (
    <nav aria-label="Seções de IA" className="border-b bg-background px-6">
      <div className="flex gap-1 overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
                isActive
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

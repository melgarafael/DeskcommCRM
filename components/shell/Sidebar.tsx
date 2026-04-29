"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { Kanban, Users, UsersThree, Gear, CaretDoubleLeft, CaretDoubleRight, Inbox } from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";

interface NavItem {
  href: string;
  label: string;
  icon: PhosphorIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/app/inbox", label: "Inbox", icon: Inbox },
  { href: "/app/kanban", label: "Kanban", icon: Kanban },
  { href: "/app/contacts", label: "Contatos", icon: Users },
  { href: "/app/team", label: "Equipe", icon: UsersThree },
  { href: "/app/settings", label: "Configurações", icon: Gear },
];

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-card transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex items-center border-b px-4 h-14", collapsed ? "justify-center" : "justify-start")}>
        <span className={cn("font-semibold tracking-tight", collapsed && "sr-only")}>DeskcommCRM</span>
        {collapsed && <span aria-hidden className="text-lg font-bold text-primary">D</span>}
      </div>
      <nav className="flex-1 space-y-1 p-2" aria-label="Navegação principal">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                collapsed && "justify-center px-2",
              )}
            >
              <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-2">
        <button
          type="button"
          onClick={() => startTransition(() => toggleSidebar(collapsed))}
          disabled={isPending}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            collapsed && "justify-center px-2",
          )}
          aria-label={collapsed ? "Expandir sidebar" : "Recolher sidebar"}
        >
          {collapsed ? <CaretDoubleRight size={14} aria-hidden /> : <CaretDoubleLeft size={14} aria-hidden />}
          {!collapsed && <span>Recolher</span>}
        </button>
      </div>
    </aside>
  );
}

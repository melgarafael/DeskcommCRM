"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Gauge,
  ChatsCircle,
  Buildings,
  ClipboardText,
  Scales,
  Warning,
  ChartBar,
  Users,
  ShieldCheck,
  ArrowRight,
} from "@/lib/ui/icons";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: PhosphorIcon;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin/dashboard", label: "Dashboard", icon: Gauge },
  { href: "/admin/inbox", label: "Inbox", icon: ChatsCircle },
  { href: "/admin/tenants", label: "Tenants", icon: Buildings },
  { href: "/admin/audit", label: "Audit", icon: ClipboardText },
  { href: "/admin/lgpd", label: "LGPD", icon: Scales },
  { href: "/admin/incidents", label: "Incidents", icon: Warning },
  { href: "/admin/usage", label: "Usage", icon: ChartBar },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/platform-admins", label: "Platform Admins", icon: ShieldCheck },
];

interface AdminSidebarProps {
  userEmail: string;
}

export function AdminSidebar({ userEmail }: AdminSidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center border-b px-4">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            DeskcommCRM
          </span>
          <span className="text-sm font-semibold tracking-tight">Admin Plataforma</span>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label="Navegação plataforma">
        {NAV_ITEMS.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className="space-y-2 border-t p-3">
        <Link
          href="/app"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <ArrowRight size={14} aria-hidden />
          <span>Voltar pra app</span>
        </Link>
        <p className="truncate px-2 text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
      </div>
    </aside>
  );
}

"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { House } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { NAV_DESTINATIONS, canSee, GRUPO_NO_RODAPE, NAV_GROUPS } from "@/lib/navigation/registry";

/**
 * Navegação inferior mobile — padrão de app nativo, 100% projeção do mesmo
 * registro que alimenta a Sidebar (`lib/navigation/registry.ts`), nunca uma
 * segunda lista de itens (mesma doutrina do arquivo: uma fonte só).
 *
 * Diferente da Sidebar (mostra TODO item `sidebar:true` do papel), a barra só
 * cabe ~5 ícones — então é uma curadoria fixa dos destinos de uso diário, na
 * mesma ordem de objetivo que `NAV_GROUPS` já declara (atendimento primeiro).
 * Um item que o papel atual não pode ver (`canSee` nega) simplesmente some da
 * barra em vez de quebrar — mesma regra da Sidebar.
 */
const BOTTOM_NAV_HREFS = ["/app/inbox", "/app/kanban", "/app/contacts"] as const;

export function BottomNav() {
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const role = activeOrg?.role ?? null;

  const primary = BOTTOM_NAV_HREFS.map((href) =>
    NAV_DESTINATIONS.find((d) => d.href === href),
  ).filter(
    (d): d is (typeof NAV_DESTINATIONS)[number] =>
      d !== undefined && canSee(d, user.is_platform_admin, role),
  );

  const settingsHub = NAV_GROUPS.find((g) => g.id === GRUPO_NO_RODAPE)?.hub;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t bg-card md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Navegação principal"
    >
      <Link
        href="/app/inbox"
        title="Início"
        aria-current={pathname === "/app/inbox" ? "page" : undefined}
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
          pathname === "/app/inbox" ? "text-accent-foreground" : "text-muted-foreground",
        )}
      >
        <House size={22} weight={pathname === "/app/inbox" ? "fill" : "regular"} aria-hidden />
        <span className="sr-only">Início</span>
      </Link>
      {primary.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={item.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
              isActive ? "text-accent-foreground" : "text-muted-foreground",
            )}
          >
            <Icon size={22} weight={isActive ? "fill" : "regular"} aria-hidden />
            <span className="max-w-full truncate px-1">{item.label}</span>
          </Link>
        );
      })}
      {settingsHub && (
        <Link
          href={settingsHub.href}
          title={settingsHub.label}
          aria-current={pathname.startsWith(settingsHub.href) ? "page" : undefined}
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
            pathname.startsWith(settingsHub.href) ? "text-accent-foreground" : "text-muted-foreground",
          )}
        >
          <span aria-hidden className="text-lg leading-none">
            ⚙
          </span>
          <span className="max-w-full truncate px-1">{settingsHub.label}</span>
        </Link>
      )}
    </nav>
  );
}

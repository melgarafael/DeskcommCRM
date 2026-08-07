"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { ArrowRight, CaretDoubleLeft, CaretDoubleRight, Gear } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { branding } from "@/lib/branding";
import { GRUPO_NO_RODAPE, NAV_GROUPS, sidebarGroups } from "@/lib/navigation/registry";

/**
 * Navegação principal, agrupada por objetivo.
 *
 * Não decide nada: `sidebarGroups()` (lib/navigation/registry.ts) resolve quais
 * grupos e destinos este papel vê, e este componente desenha. Antes, a lista de
 * itens e sete `usePermission()` viviam aqui — e divergiam do hub de
 * Configurações e das abas de IA, que mantinham suas próprias listas.
 */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const { user, activeOrg } = useAuth();
  const todos = sidebarGroups(user.is_platform_admin, activeOrg?.role ?? null);
  // Configurações sai da área que rola e vai para o rodapé fixo: medido em
  // 1280x768, ele caía fora da dobra mesmo em telas de 1080px.
  const grupos = todos.filter((g) => g.group.id !== GRUPO_NO_RODAPE);
  const rodape = NAV_GROUPS.find((g) => g.id === GRUPO_NO_RODAPE)?.hub;

  const brand = branding();

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-30 flex flex-col border-r bg-card transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex items-center border-b px-4 h-14", collapsed ? "justify-center" : "justify-start")}>
        {brand.logoUrl && !collapsed ? (
          // <img> em vez de next/image de propósito: a URL vem do .env de quem hospeda,
          // e next/image exige allowlist de domínios fechada em build — a imagem
          // pré-buildada rejeitaria o domínio do self-hoster. Altura fixa e largura
          // livre porque a arte enviada tem proporção desconhecida; forçar as duas
          // distorceria o logo de quem configurou.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brand.logoUrl}
            alt={brand.name}
            className="h-9 w-auto max-w-[12rem] object-contain"
          />
        ) : (
          <span className={cn("font-semibold tracking-tight", collapsed && "sr-only")}>
            {brand.name}
          </span>
        )}
        {collapsed && (
          <span aria-hidden className="text-lg font-bold text-primary">
            {brand.initial}
          </span>
        )}
      </div>
      <nav className="flex-1 space-y-3 overflow-y-auto p-2" aria-label="Navegação principal">
        {grupos.map(({ group, items }) => {
          const tituloId = `nav-grupo-${group.id}`;
          return (
            <div key={group.id} className="space-y-1">
              {/* Colapsado, o sidebar tem 64px: seis rótulos ali seriam ilegíveis.
                  Vira um filete separador, que preserva o agrupamento sem texto. */}
              {collapsed ? (
                <div aria-hidden className="mx-2 border-t first:hidden" />
              ) : (
                <h2
                  id={tituloId}
                  className="px-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60"
                >
                  {group.label}
                </h2>
              )}
              <ul aria-labelledby={collapsed ? undefined : tituloId} aria-label={collapsed ? group.label : undefined} className="space-y-1">
                {items.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={collapsed ? item.label : undefined}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "relative flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          collapsed && "justify-center px-2",
                        )}
                      >
                        <Icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                        {item.healthDot && (
                          <ConnectionHealthDot
                            className={cn(collapsed ? "absolute right-1.5 top-1.5" : "ml-auto")}
                          />
                        )}
                      </Link>
                    </li>
                  );
                })}
                {group.hub && (
                  <li>
                    <Link
                      href={group.hub.href}
                      title={collapsed ? group.hub.label : undefined}
                      aria-current={pathname === group.hub.href ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                        pathname === group.hub.href
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                        collapsed && "justify-center px-2",
                      )}
                    >
                      <ArrowRight size={18} aria-hidden />
                      {!collapsed && <span className="truncate">{group.hub.label}</span>}
                    </Link>
                  </li>
                )}
              </ul>
            </div>
          );
        })}
      </nav>
      <div className="border-t p-2">
        {rodape && (
          <Link
            href={rodape.href}
            title={collapsed ? rodape.label : undefined}
            aria-current={pathname.startsWith(rodape.href) ? "page" : undefined}
            className={cn(
              "mb-1 flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
              pathname.startsWith(rodape.href)
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
          >
            <Gear size={18} aria-hidden />
            {!collapsed && <span className="truncate">{rodape.label}</span>}
          </Link>
        )}
        <VersionFooter collapsed={collapsed} />
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

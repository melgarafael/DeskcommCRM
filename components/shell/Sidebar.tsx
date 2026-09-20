"use client";

import Link from "next/link";
import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { gsap } from "gsap";
import { usePathname } from "next/navigation";
import { useState, useTransition, useEffect, useRef } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { VersionFooter } from "./VersionFooter";
import { CommandPalette } from "./CommandPalette";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { searchable } from "@/lib/navigation/registry";
import { DEFAULT_APP_NAME } from "@/lib/branding";

import { ArtisanIcon, type ArtisanSymbol } from "@/components/brand/ArtisanIcon";

const daily: { href: string; symbol: ArtisanSymbol }[] = [
  { href: "/app/inbox", symbol: "conversation" },
  { href: "/app/kanban", symbol: "pipeline" },
  { href: "/app/ai/agents", symbol: "agent" },
  { href: "/app/contacts", symbol: "people" },
  { href: "/app/agenda", symbol: "calendar" },
];

export function SidebarContent({
  collapsed,
  showCollapseControl = true,
  onNavigate,
}: {
  collapsed: boolean;
  showCollapseControl?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const brand = useMarcaDaInstalacao();
  const [pending, startTransition] = useTransition();
  const [explore, setExplore] = useState(false);
  const destinations = searchable(
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  );
  const name = activeOrg?.marca?.nome ?? brand.name;
  const logo = activeOrg?.marca?.logoUrl || brand.logoUrl;
  const productBrand = !logo && (name === DEFAULT_APP_NAME || name === "escreve.ai");
  const linkClass = (active: boolean) =>
    cn("workspace-nav-item", active && "is-active", collapsed && "justify-center px-0");
  return (
    <>
      <Link
        href="/app"
        onClick={onNavigate}
        aria-label={productBrand ? "escreve.ai — início" : `${name} — início`}
        className={cn(
          "flex h-20 shrink-0 items-center gap-2 px-6",
          collapsed && "justify-center px-2",
        )}
      >
        {productBrand ? (
          collapsed ? (
            <SimboloDoProduto nome="escreve.ai" className="h-9 w-9" />
          ) : (
            <LogotipoDoProduto nome="escreve.ai" className="h-10 w-full" />
          )
        ) : logo && !collapsed ? (
          <div className="rounded-lg dark:bg-white dark:p-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logo} alt={name} className="h-7 max-w-40 object-contain" />
          </div>
        ) : (
          <span className="text-[22px] font-semibold tracking-[-0.06em]">
            {collapsed ? [...name][0] : name}
          </span>
        )}
      </Link>
      <nav
        aria-label={t("Navegação principal")}
        className="flex-1 space-y-1 overflow-y-auto px-3 py-3"
      >
        <Link
          href="/app"
          onClick={onNavigate}
          title={collapsed ? t("Escreve aí") : undefined}
          aria-label={collapsed ? t("Escreve aí") : undefined}
          aria-current={pathname === "/app" ? "page" : undefined}
          className={linkClass(pathname === "/app")}
        >
          <ArtisanIcon symbol="spark" className="h-5 w-5 shrink-0" />
          {!collapsed && <span>{t("Escreve aí")}</span>}
        </Link>
        {!collapsed && (
          <p className="px-3 pt-7 pb-3 text-[11px] font-medium tracking-wide text-muted-foreground">
            {t("SEU ESPAÇO")}
          </p>
        )}
        {daily.map(({ href, symbol }) => {
          const item = destinations.find((d) => d.href === href);
          if (!item) return null;
          const active = pathname === href || pathname.startsWith(href + "/");
          const label = href === "/app/ai/agents" ? "Agentes de IA" : item.label;
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              title={collapsed ? t(label) : undefined}
              aria-label={collapsed ? t(label) : undefined}
              aria-current={active ? "page" : undefined}
              className={linkClass(active)}
            >
              <ArtisanIcon symbol={symbol} className="h-5 w-5 shrink-0" />
              {!collapsed && <span>{t(label)}</span>}
            </Link>
          );
        })}
        <div className="pt-5">
          <button
            type="button"
            onClick={() => setExplore(true)}
            title={collapsed ? t("Todas as ferramentas") : undefined}
            aria-label={collapsed ? t("Todas as ferramentas") : undefined}
            className={linkClass(false)}
          >
            <ArtisanIcon symbol="tools" className="h-5 w-5 shrink-0" />
            {!collapsed && <span>{t("Todas as ferramentas")}</span>}
          </button>
        </div>
      </nav>
      <div className="space-y-1 px-3 pb-4">
        {destinations.some((d) => d.group === "organizacao") && (
          <Link
            href="/app/settings"
            onClick={onNavigate}
            title={collapsed ? t("Configurações") : undefined}
            aria-label={collapsed ? t("Configurações") : undefined}
            className={linkClass(pathname.startsWith("/app/settings"))}
          >
            <ArtisanIcon symbol="settings" className="h-5 w-5 shrink-0" />
            {!collapsed && <span>{t("Configurações")}</span>}
          </Link>
        )}
        <VersionFooter collapsed={collapsed} onNavigate={onNavigate} />
        {showCollapseControl && (
          <button
            type="button"
            disabled={pending}
            onClick={() => startTransition(() => toggleSidebar(collapsed))}
            aria-label={t(collapsed ? "Expandir sidebar" : "Recolher sidebar")}
            className={linkClass(false)}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} aria-hidden />
            ) : (
              <>
                <PanelLeftClose size={18} aria-hidden />
                <span className="text-xs">{t("Recolher")}</span>
              </>
            )}
          </button>
        )}
      </div>
      <CommandPalette open={explore} onOpenChange={setExplore} onNavigate={onNavigate} />
    </>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const element = useRef<HTMLElement>(null);
  const previous = useRef(collapsed);
  useEffect(() => {
    if (previous.current === collapsed) return;
    previous.current = collapsed;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        element.current,
        { width: collapsed ? 228 : 76 },
        { width: collapsed ? 76 : 228, duration: 0.22, ease: "power2.out", clearProps: "width" },
      );
    });
    return () => media.revert();
  }, [collapsed]);
  return (
    <aside
      ref={element}
      data-workspace-sidebar
      className={cn(
        "workspace-sidebar sticky top-0 z-30 flex h-dvh shrink-0 flex-col",
        collapsed ? "w-[76px]" : "w-[228px]",
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}

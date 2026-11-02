"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { useT } from "@/hooks/i18n/useT";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import { destinosDoAdmin } from "@/lib/admin/navegacao";

/**
 * Menu do administrador da instalação.
 *
 * A LISTA não mora mais aqui: saiu para `lib/admin/navegacao.ts` quando a busca
 * (⌘K) do painel virou seu segundo consumidor. Duas cópias divergem no primeiro
 * item novo que alguém esquece de duplicar — e a busca passaria a levar a telas
 * que o menu não mostra.
 *
 * Ela continua fora de `lib/navigation/registry.ts` de propósito: aquele
 * registro descreve a navegação do TENANT (`app/app/**`) e o teste de
 * completude que o vigia varre só aquela raiz. O administrador de plataforma
 * tem navegação própria. Quem vigia a completude DESTA lista é
 * `tests/unit/admin-navegacao-completude.test.ts`.
 */

interface AdminSidebarProps {
  userEmail: string;
  /** Módulos ligados na instalação: decidem as entradas com `modulo`. Padrão: nenhum. */
  modulosLigados?: readonly ModuloOpcional[];
  /** "mobile" = conteúdo desta MESMA navegação dentro do drawer que `AdminShell`
   * abre abaixo de `lg` — mesmo padrão de `components/shell/Sidebar.tsx`. */
  variant?: "desktop" | "mobile";
}

export function AdminSidebar({ userEmail, variant = "desktop", modulosLigados = [] }: AdminSidebarProps) {
  const t = useT();
  const isMobile = variant === "mobile";
  const pathname = usePathname();
  // Por PROP do servidor, e nunca `branding()`: aquela função lê fontes
  // diferentes nos dois lados da fronteira (`window.__PUBLIC_ENV__` no
  // navegador, `process.env` no servidor), e desde que o layout raiz passou a
  // injetar a marca do BANCO as duas divergem — o nome renderizado no SSR não
  // batia com o hidratado, que é hydration mismatch. Ver `lib/branding/contexto.tsx`.
  const marca = useMarcaDaInstalacao();
  const destinos = destinosDoAdmin(modulosLigados);

  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-card",
        isMobile ? "h-full w-full" : "hidden w-60 shrink-0 lg:flex",
      )}
    >
      <div className="flex h-14 items-center gap-3 border-b px-4">
        {/* O nome já está escrito ao lado — o símbolo é reforço, não legenda. */}
        {marcaEhADoProduto(marca) && (
          <SimboloDoProduto nome={marca.name} decorativo className="h-8 w-8" />
        )}
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            {marca.name}
          </span>
          <span className="text-sm font-semibold tracking-tight">{t("Admin Plataforma")}</span>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label={t("Navegação plataforma")}>
        {destinos.map((item) => {
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
              <span className="truncate">{t(item.label)}</span>
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
          <span>{t("Voltar pra app")}</span>
        </Link>
        <p className="truncate px-2 text-xs text-muted-foreground" title={userEmail}>
          {userEmail}
        </p>
      </div>
    </aside>
  );
}

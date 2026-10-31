"use client";
import Link from "next/link";
import { useTransition } from "react";

import { useAuth, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { idiomaVisivelPorCodigo } from "@/lib/i18n/registro";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";
import { AlertsBell } from "@/components/shell/AlertsBell";
import { AvisoDePropostaEmDestaque } from "@/components/shell/AvisoDePropostaEmDestaque";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { ShieldCheck, SignOut } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

function iniciais(nome: string | null, email: string): string {
  if (nome && nome.trim()) {
    return nome.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

/**
 * O RODAPÉ DA BARRA LATERAL (redesign kvgroup, seção 4.3): a pessoa logada,
 * com o sino da Central de avisos ao lado. O menu dela recebe o que morava na
 * barra superior — idioma, tema, modo administrador, sair — e a versão
 * instalada, que deixa de ficar fixa na tela.
 *
 * O mesmo conteúdo do `UserMenu` da barra do celular; os dois nunca estão
 * montados ao mesmo tempo (`AppShell`), então atalhos e sons não duplicam.
 */
export function RodapeDoUsuario({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const user = useUser();
  const { signOut } = useAuth();
  const idioma = idiomaVisivelPorCodigo(useIdioma());
  const [saindo, startTransition] = useTransition();
  const nome = user.full_name ?? user.email;

  return (
    <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${t("Menu do usuário")}: ${iniciais(user.full_name, user.email)}`}
            data-testid="menu-do-usuario-lateral"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2.5 rounded-[7px] px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--kv-hover)]",
              "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              collapsed && "flex-none justify-center",
            )}
          >
            <span className="relative shrink-0">
              <Avatar className="h-8 w-8">
                {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
                <AvatarFallback className="bg-[var(--kv-surface-2)] text-xs font-medium">
                  {iniciais(user.full_name, user.email)}
                </AvatarFallback>
              </Avatar>
              <span
                aria-hidden
                className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--kv-sidebar)] bg-[var(--kv-online)]"
              />
            </span>
            {!collapsed && (
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium text-text">{nome}</span>
                <span className="truncate text-[11px] text-[var(--kv-text-faint)]">
                  {t("Online")} · {idioma.rotuloCurto}
                </span>
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-[240px]">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{nome}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="text-xs text-muted-foreground">{t("Idioma e tema")}</span>
            <span className="flex items-center gap-1">
              <SeletorDeIdioma />
              <ThemeToggle />
            </span>
          </div>
          {user.is_platform_admin && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/admin" data-testid="porta-modo-administrador" onClick={onNavigate}>
                  <ShieldCheck size={16} className="mr-2" aria-hidden />
                  <span className="flex flex-col">
                    <span>{t("Modo administrador")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("Configurar este servidor")}
                    </span>
                  </span>
                </Link>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <div className="px-1">
            <VersionFooter collapsed={false} onNavigate={onNavigate} />
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={saindo}
            onClick={() => startTransition(async () => { await signOut(); })}
          >
            <SignOut size={16} className="mr-2" aria-hidden />
            {t("Sair")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AvisoDePropostaEmDestaque />
      <AlertsBell />
    </div>
  );
}

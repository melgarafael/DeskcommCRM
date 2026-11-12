"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { signOut } from "@/app/actions/auth/signOut";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { ArrowLeft, Buildings, CalendarBlank, CaretDoubleLeft, CaretDoubleRight, FileText, Gear, Megaphone, PaperPlaneTilt, Path, TreeStructure, House, List, ListChecks, SignOut, UserCircle, UsersThree } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { Sininho } from "./Sininho";

/**
 * A casca da área da agência (docs/agencia/SPEC-equipe.md › Telas).
 *
 * Menu lateral a partir de `md`; no celular, barra de abas fixa no rodapé — a
 * equipe usa a área tanto no computador quanto no celular (decisão D14 do mapa).
 * Quais entradas aparecem é decisão do SERVIDOR (`entradas`), lida das
 * permissões: o componente não conhece a regra, só desenha o que recebeu.
 */
export type IconeDaEntrada = "inicio" | "tarefas" | "calendario" | "clientes" | "trilhas" | "mapas" | "publicacoes" | "envios" | "contratos" | "equipe" | "configuracoes" | "perfil";

export interface EntradaDaCasca {
  href: string;
  rotulo: string;
  icone: IconeDaEntrada;
}

const ICONES: Record<IconeDaEntrada, PhosphorIcon> = {
  inicio: House,
  tarefas: ListChecks,
  calendario: CalendarBlank,
  trilhas: Path,
  mapas: TreeStructure,
  publicacoes: Megaphone,
  envios: PaperPlaneTilt,
  contratos: FileText,
  clientes: Buildings,
  equipe: UsersThree,
  configuracoes: Gear,
  perfil: UserCircle,
};

interface Props {
  entradas: readonly EntradaDaCasca[];
  nomeDoUsuario: string;
  /** O dono vê a volta para o painel administrador; a equipe não sabe que ele existe. */
  ehDono: boolean;
  /** Sem linha de membro (o dono antes de cadastrar o WhatsApp) não há sininho. */
  membroId: string | null;
  children: ReactNode;
}

function ativa(pathname: string, href: string): boolean {
  if (href === "/agencia") return pathname === "/agencia";
  return pathname === href || pathname.startsWith(href + "/");
}

const CHAVE_MENU_RECOLHIDO = "agencia:menu-recolhido";

export function CascaDaAgencia({ entradas, nomeDoUsuario, ehDono, membroId, children }: Props) {
  const pathname = usePathname();
  const marca = useMarcaDaInstalacao();
  const [saindo, startTransition] = useTransition();

  // Começa expandido (evita mismatch de hidratação) e só aplica a
  // preferência salva depois de montar no cliente — pode haver um flash
  // inicial expandido para quem tinha escolhido recolher.
  const [recolhido, setRecolhido] = useState(false);

  useEffect(() => {
    try {
      const salvo = window.localStorage.getItem(CHAVE_MENU_RECOLHIDO);
      if (salvo === "1") setRecolhido(true);
    } catch {
      // localStorage indisponível (ex.: navegação privada) — mantém expandido.
    }
  }, []);

  const alternarRecolhido = () => {
    setRecolhido((atual) => {
      const novo = !atual;
      try {
        window.localStorage.setItem(CHAVE_MENU_RECOLHIDO, novo ? "1" : "0");
      } catch {
        // localStorage indisponível — a escolha só vale para esta sessão.
      }
      return novo;
    });
  };

  const sair = () => startTransition(async () => { await signOut(); });

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r bg-card transition-[width] duration-150 md:flex",
          recolhido ? "w-16" : "w-60",
        )}
      >
        <div className={cn("flex h-14 flex-col justify-center border-b", recolhido ? "px-2" : "px-4")}>
          {!recolhido && <span className="text-xs uppercase tracking-wider text-muted-foreground">{marca.name}</span>}
          <span className="text-sm font-semibold tracking-tight">{recolhido ? marca.name.slice(0, 1) : "Agência"}</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label="Navegação da agência">
          {entradas.map((e) => {
            const Icone = ICONES[e.icone];
            const atual = ativa(pathname, e.href);
            return (
              <Link
                key={e.href}
                href={e.href}
                aria-current={atual ? "page" : undefined}
                title={recolhido ? e.rotulo : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  recolhido && "justify-center",
                  atual
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icone size={18} weight={atual ? "fill" : "regular"} aria-hidden />
                {!recolhido && <span className="truncate">{e.rotulo}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1 border-t p-3">
          {ehDono && (
            <Link
              href="/admin"
              title={recolhido ? "Voltar ao painel administrador" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                recolhido && "justify-center",
              )}
            >
              <ArrowLeft size={14} aria-hidden />
              {!recolhido && <span>Voltar ao painel administrador</span>}
            </Link>
          )}
          <button
            type="button"
            onClick={sair}
            disabled={saindo}
            title={recolhido ? "Sair" : undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-60",
              recolhido && "justify-center",
            )}
          >
            <SignOut size={14} aria-hidden />
            {!recolhido && <span>Sair</span>}
          </button>
          {!recolhido && (
            <p className="truncate px-2 text-xs text-muted-foreground" title={nomeDoUsuario}>
              {nomeDoUsuario}
            </p>
          )}
          <button
            type="button"
            onClick={alternarRecolhido}
            aria-label={recolhido ? "Expandir menu" : "Recolher menu"}
            title={recolhido ? "Expandir menu" : "Recolher menu"}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              recolhido && "justify-center",
            )}
          >
            {recolhido ? <CaretDoubleRight size={14} aria-hidden /> : <CaretDoubleLeft size={14} aria-hidden />}
            {!recolhido && <span>Recolher menu</span>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center justify-between gap-2 border-b bg-background px-4 md:justify-end">
          <span className="text-sm font-semibold tracking-tight md:hidden">Agência</span>
          <div className="flex items-center gap-1">
            {membroId && <Sininho membroId={membroId} />}
            {ehDono && (
              <Link
                href="/admin"
                aria-label="Voltar ao painel administrador"
                className="rounded-md p-2 text-muted-foreground hover:bg-accent/50 md:hidden"
              >
                <ArrowLeft size={18} aria-hidden />
              </Link>
            )}
            <button
              type="button"
              onClick={sair}
              disabled={saindo}
              aria-label="Sair"
              className="rounded-md p-2 text-muted-foreground hover:bg-accent/50 disabled:opacity-60 md:hidden"
            >
              <SignOut size={18} aria-hidden />
            </button>
          </div>
        </header>

        {/* `pb-20` no celular: a barra de abas é fixa e cobriria o fim da página. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 pb-20 sm:p-6 sm:pb-20 md:pb-6">
          {children}
        </main>

        <nav
          aria-label="Navegação da agência"
          className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {/* Cabem 4 abas: com mais entradas, as 3 primeiras ficam e o resto vai para "Mais". */}
          {(entradas.length > 4 ? entradas.slice(0, 3) : entradas).map((e) => {
            const Icone = ICONES[e.icone];
            const atual = ativa(pathname, e.href);
            return (
              <Link
                key={e.href}
                href={e.href}
                aria-current={atual ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]",
                  atual ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icone size={22} weight={atual ? "fill" : "regular"} aria-hidden />
                <span className="truncate">{e.rotulo}</span>
              </Link>
            );
          })}
          {entradas.length > 4 && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]",
                    entradas.slice(3).some((e) => ativa(pathname, e.href)) ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <List size={22} aria-hidden />
                  <span>Mais</span>
                </button>
              </PopoverTrigger>
              <PopoverContent side="top" align="end" className="w-56 p-1">
                {entradas.slice(3).map((e) => {
                  const Icone = ICONES[e.icone];
                  return (
                    <Link key={e.href} href={e.href} className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:bg-accent/50">
                      <Icone size={18} aria-hidden />
                      {e.rotulo}
                    </Link>
                  );
                })}
              </PopoverContent>
            </Popover>
          )}
        </nav>
      </div>
    </div>
  );
}

"use client";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { BottomNav } from "@/components/shell/BottomNav";
import { TopBar } from "@/components/shell/TopBar";
import { cn } from "@/lib/utils";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Sidebar é coisa de desktop/tablet — abaixo de `md` ela nem monta
          (`hidden md:flex`), a barra inferior (`BottomNav`, `md:hidden`) toma
          o lugar dela. Ver docs/design-system/screen-flow/07-responsive-strategy.md. */}
      <div className="hidden md:flex">
        <Sidebar collapsed={sidebarCollapsed} />
      </div>
      {/*
        `min-w-0` é o que permite a coluna de conteúdo ENCOLHER. Um flex item
        nasce com `min-width: auto`, ou seja, nunca fica menor que o conteúdo —
        então qualquer bloco largo (uma fila de abas, uma tabela) empurrava a
        PÁGINA INTEIRA para o lado em vez de rolar dentro da própria caixa, e o
        conteúdo sumia sem nada indicando que existia.

        Medido em 390x844 no detalhe do agente, que tem seis abas: a página
        estourava 476px na horizontal; com esta classe, 212px — o que sobra é o
        cabeçalho, presente também em telas que não têm abas (a lista de agentes
        estoura 236px). Isolado ancestral por ancestral: é este o que decide.
      */}
      <div
        className={cn(
          "flex min-h-screen min-w-0 flex-1 flex-col transition-[margin] duration-200",
          // Margem da sidebar só entra a partir de `md` (ela nem existe antes disso).
          sidebarCollapsed ? "md:ml-16" : "md:ml-60",
        )}
      >
        <TopBar />
        {/* `pb-16` em mobile abre espaço pra BottomNav não cobrir o fim do
            conteúdo (a barra é `fixed`, não empurra o layout como a sidebar). */}
        <main className="flex-1 overflow-auto p-6 pb-20 md:pb-6">{children}</main>
      </div>
      <BottomNav />
    </div>
  );
}

"use client";
import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Fecha o drawer sozinho ao navegar — sem isto, escolher um item do menu no
  // celular trocava de tela com o próprio menu ainda aberto por cima. Ajuste
  // de estado DURANTE o render (não em `useEffect`) é o padrão recomendado
  // pelo React para "resetar estado quando algo mudou" — evita o commit extra
  // que um efeito causaria.
  const pathname = usePathname();
  const [ultimoPathname, setUltimoPathname] = useState(pathname);
  if (pathname !== ultimoPathname) {
    setUltimoPathname(pathname);
    setMobileNavOpen(false);
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <Sidebar collapsed={sidebarCollapsed} />
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0 lg:hidden">
          <SheetTitle className="sr-only">Menu de navegação</SheetTitle>
          <Sidebar collapsed={false} variant="mobile" />
        </SheetContent>
      </Sheet>
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

        A margem que reserva espaço pra sidebar só vale de `lg` pra cima — abaixo
        disso a sidebar fixa nem está no DOM (ver `Sidebar`), e a navegação vira
        o drawer acima; sem o prefixo `lg:` o conteúdo nascia empurrado 240px pra
        dentro no celular, com a sidebar que ninguém via.
      */}
      <div className={cn("flex min-h-screen min-w-0 flex-1 flex-col transition-[margin] duration-200", sidebarCollapsed ? "lg:ml-16" : "lg:ml-60")}>
        <TopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
        {/* `overflow-x-hidden`: rede de segurança, não a correção em si — se
            algum filho ainda estourar a largura (uma linha de botões sem
            `flex-wrap`, por exemplo), o certo é a PÁGINA nunca rolar de lado;
            quem precisa de scroll horizontal é o componente específico
            (tabela, kanban), contido nele mesmo. Antes, `overflow-auto`
            deixava esse estouro virar "a tela inteira rola pro lado" sem
            nenhum aviso — foi assim que a lista de Funis passou despercebida
            até alguém ver na tela real. */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

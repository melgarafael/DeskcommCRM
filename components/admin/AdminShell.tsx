"use client";
import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PlatformModeBanner } from "./PlatformModeBanner";
import { AdminSidebar } from "./AdminSidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { List } from "@/lib/ui/icons";

interface AdminShellProps {
  userEmail: string;
  children: ReactNode;
}

/**
 * Shell for /admin/*. Renders the cross-tenant banner (sticky top), platform
 * sidebar, and main content area. Client component (não mais Server) desde
 * que ganhou o drawer de navegação mobile — precisa do estado de
 * aberto/fechado, no mesmo padrão de `app/app/_components/AppShell.tsx`;
 * `children` continua chegando como Server Component normalmente (React
 * permite RSC como `children` de um Client Component sem forçar o subtree
 * inteiro pro cliente).
 *
 * O `TooltipProvider` mora aqui, e não em cada componente, porque o Radix exige
 * um Provider ANCESTRAL de todo `Tooltip`: sem ele o componente lança
 * "`Tooltip` must be used within `TooltipProvider`" no cliente, e o React
 * derruba a árvore inteira — a tela vira a página de erro do Next, não um
 * tooltip quebrado. O dono não recebe pista nenhuma: vê "Algo deu errado" e um
 * ID opaco (`app/error.tsx`), e no servidor não há rastro, porque o erro é do
 * cliente.
 *
 * QUEM É ATINGIDO, medido em vez de suposto: o único consumidor do Tooltip do
 * Radix sem Provider próprio é o `TenantBadge`. Ele é montado em 4 telas —
 * /admin/inbox, /admin/inbox/[conversationId], /admin/lgpd e
 * /admin/lgpd/requests/[id]. Os outros três importadores de
 * `components/ui/tooltip` (CredentialCard, MessageBubble, PlatformAdminsTable)
 * embrulham o seu, por isso nunca quebraram.
 *
 * O que este Provider NÃO conserta, apesar de parecer: /admin/usage e
 * /app/ai/usage. Os gráficos de lá (`UsageCharts`, `UsageChart`) importam um
 * `Tooltip` de nome igual e origem diferente — o do **recharts**, que não usa
 * Provider nenhum. Verificado abrindo /admin/usage com o defeito presente: a
 * tela carrega normalmente. Fica escrito porque o nome colide e o próximo
 * leitor vai procurar um Provider faltando ali e não vai encontrar.
 *
 * A quebra é CONDICIONAL A DADO: os mounts de `TenantBadge` estão atrás de
 * guarda de organização resolvida, então uma instalação sem conversas (ou sem
 * solicitação LGPD) abre as 4 telas normalmente mesmo com o defeito. Quem for
 * reproduzir precisa de pelo menos uma linha com tenant; ver a tela abrir num
 * banco vazio não significa que o defeito não existe.
 *
 * Um Provider na casca cobre as quatro telas de uma vez e faz tela nova nascer
 * funcionando, em vez de repetir o erro a cada tela adicionada — é o padrão
 * recomendado pelo Radix (Provider perto da raiz, compartilhando o delay).
 */
export function AdminShell({ userEmail, children }: AdminShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Mesmo padrão de `app/app/_components/AppShell.tsx`: ajuste de estado
  // durante o render, não em `useEffect` (ver comentário lá).
  const pathname = usePathname();
  const [ultimoPathname, setUltimoPathname] = useState(pathname);
  if (pathname !== ultimoPathname) {
    setUltimoPathname(pathname);
    setMobileNavOpen(false);
  }

  return (
    <TooltipProvider>
      <div className="flex min-h-screen w-full flex-col bg-background">
        <PlatformModeBanner />
        <div className="flex flex-1">
          <AdminSidebar userEmail={userEmail} />
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0 lg:hidden">
              <SheetTitle className="sr-only">Menu de navegação</SheetTitle>
              <AdminSidebar userEmail={userEmail} variant="mobile" />
            </SheetContent>
          </Sheet>
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Sem TopBar própria no admin (era só sidebar + main): esta barra
                existe só pra carregar o hambúrguer abaixo de `lg`, onde a
                sidebar fixa não está mais no DOM. */}
            <header className="flex h-12 items-center gap-2 border-b bg-background px-3 lg:hidden">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => setMobileNavOpen(true)}
                aria-label="Abrir menu de navegação"
              >
                <List size={20} aria-hidden />
              </Button>
              <span className="text-sm font-semibold tracking-tight">Admin Plataforma</span>
            </header>
            {/* `overflow-x-hidden` como rede de segurança — mesmo motivo do
                `AppShell` (ver comentário lá): se algo estourar a largura, a
                PÁGINA não rola de lado; quem precisa de scroll horizontal é
                o componente específico, contido nele mesmo. */}
            <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">{children}</main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

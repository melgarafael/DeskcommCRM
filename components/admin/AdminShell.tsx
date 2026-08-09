import type { ReactNode } from "react";
import { PlatformModeBanner } from "./PlatformModeBanner";
import { AdminSidebar } from "./AdminSidebar";
import { AdminMobileBanner } from "./AdminMobileBanner";
import { TooltipProvider } from "@/components/ui/tooltip";

interface AdminShellProps {
  userEmail: string;
  children: ReactNode;
}

/**
 * Server component shell for /admin/*. Renders the cross-tenant banner
 * (sticky top), platform sidebar, and main content area.
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
  return (
    <TooltipProvider>
      <div className="flex min-h-screen w-full flex-col bg-background">
        <PlatformModeBanner />
        <AdminMobileBanner />
        <div className="flex flex-1">
          {/* Área cross-tenant: doc de responsividade degrada intencionalmente
              em mobile (leitura só, ver AdminMobileBanner) — sem sidebar de
              navegação completa num celular. */}
          <div className="hidden md:flex">
            <AdminSidebar userEmail={userEmail} />
          </div>
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}

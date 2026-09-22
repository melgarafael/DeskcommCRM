"use client";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
import { AssistenteFlutuante } from "@/components/assistente/AssistenteFlutuante";
import { useInboundMessageAlerts } from "@/hooks/notifications/useInboundMessageAlerts";
import { useCrmAlerts } from "@/hooks/notifications/useCrmAlerts";
import { useNotifyOpenFromServiceWorker } from "@/lib/notifications/notify_open";

interface AppShellProps {
  sidebarCollapsed: boolean;
  children: ReactNode;
}

export function AppShell({ sidebarCollapsed, children }: AppShellProps) {
  useInboundMessageAlerts();
  useCrmAlerts();
  useNotifyOpenFromServiceWorker();
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/*
        Casca travada no viewport: `h-screen overflow-hidden` em vez de
        `min-h-screen`. Antes a casca crescia com o conteúdo e a rolagem era do
        body — o TopBar (`sticky`) ficava para cima e sumia da tela nas páginas
        longas. Agora só o `main` rola; TopBar e Sidebar ficam sempre visíveis.
      */}
      <div className="hidden md:block print:hidden">
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
      {/*
        Sem `md:ml-*`: a barra voltou a ocupar lugar na linha (ver o comentário
        em `Sidebar.tsx`), então o que sobra para esta coluna é exatamente o que
        ela não usou. A margem existia para compensar uma barra `fixed`, e era a
        SEGUNDA medida da mesma coisa — a que discordava e deixava a barra por
        cima da lista.
      */}
      {/*
        `min-h-0` nos dois níveis é o que deixa o `overflow` do `main`
        engatar: item de flex nasce com `min-height: auto` e nunca encolhe
        abaixo do conteúdo — sem isso a coluna estourava o viewport de novo
        e a rolagem voltava para o body (o defeito original por outro caminho).
      */}
      <div className="flex h-screen min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto p-6">{children}</main>
      </div>
      {/* Assistente de ajuda: só na área logada (/app/*), canto inferior
          direito. Reage ao mouse, pula no clique e abre o chat de ajuda. */}
      <AssistenteFlutuante />
    </div>
  );
}

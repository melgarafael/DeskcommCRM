"use client";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { TopBar } from "@/components/shell/TopBar";
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
    /*
      `h-screen` + `overflow-hidden`, e nao `min-h-screen`.

      `min-h-screen` e um PISO: a caixa podia crescer alem da janela, e crescia.
      Medido: injetando 2000px de conteudo nesta arvore, a pagina ia a 2424px
      num viewport de 928 — quem rolava era o DOCUMENTO, nao o `<main>`. A barra
      lateral e `h-screen` (altura da janela, travada), entao ela terminava aos
      928px e sobravam 1496px do fundo escuro do shell expostos abaixo dela.

      Com a altura TRAVADA aqui, a janela vira o limite e a rolagem tem de
      acontecer dentro de `<main>` — que e o desenho que a barra lateral fixa
      sempre pressupos.
    */
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <div className="hidden md:block">
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar />
        {/*
          `min-h-0` e o conserto propriamente dito, e ele e o GEMEO VERTICAL do
          `min-w-0` da coluna acima — que ja esta comentado ali por ter causado o
          mesmo defeito na horizontal.

          Um flex item nasce com `min-height: auto`, ou seja, NUNCA fica menor que
          o proprio conteudo. Por isso o `overflow-auto` daqui nunca entrava em
          acao: em vez de rolar por dentro, o `<main>` crescia, empurrava a coluna
          e a pagina inteira ia junto. `min-h-0` autoriza o encolhimento, e ai a
          barra de rolagem aparece onde ela sempre deveria ter aparecido.
        */}
        <main className="min-h-0 flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}

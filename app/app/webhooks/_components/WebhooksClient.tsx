"use client";
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { SourcesTab } from "./SourcesTab";
import { ActivityTab } from "./ActivityTab";
import { CapturasTab } from "./CapturasTab";
import { useT } from "@/hooks/i18n/useT";

/**
 * As abas que um link pode abrir direto (`/app/webhooks?aba=leads`). As regras
 * QUANDO/SE/ENTÃO saíram daqui para Automações › Regras (`/app/automacoes/regras`);
 * a página redireciona o link antigo `?aba=automacoes`.
 */
const ABAS = { receber: "sources", leads: "capturas", atividade: "activity" } as const;
export type AbaDosWebhooks = keyof typeof ABAS;

export function WebhooksClient({ abaInicial }: { abaInicial?: AbaDosWebhooks }) {
  const t = useT();
  // Radix Tabs gera ids via useId; com SSR streamado (Next 15) os ids divergem
  // entre server e client e o React acusa hydration mismatch. Nenhuma outra
  // página do app SSRa Tabs no primeiro paint (todas montam pós-fetch) —
  // seguimos o mesmo padrão: skeleton no SSR, Tabs após mount.
  const mounted = React.useSyncExternalStore(
    React.useCallback(() => () => {}, []),
    () => true,
    () => false,
  );

  if (!mounted) {
    // Mesma altura do TabsList (h-9) e largura MEDIDA da tablist — zero layout
    // shift. 432px era a medida com QUATRO abas (`getBoundingClientRect` em
    // 1440px, aba "Leads recebidos" incluída); eram 306px com três, e um
    // skeleton estreito demais faz a página saltar no primeiro paint.
    // Ao acrescentar ou renomear aba, MEDIR de novo — este número não se
    // estima a olho.
    return (
      <div className="flex-1">
        <Skeleton className="h-9 w-[432px]" />
      </div>
    );
  }

  return (
    <Tabs defaultValue={abaInicial ? ABAS[abaInicial] : "sources"} className="flex-1">
      <TabsList>
        <TabsTrigger value="sources">{t("Receber dados")}</TabsTrigger>
        <TabsTrigger value="capturas">{t("Leads recebidos")}</TabsTrigger>
        <TabsTrigger value="activity">{t("Atividade")}</TabsTrigger>
      </TabsList>
      <TabsContent value="sources"><SourcesTab /></TabsContent>
      <TabsContent value="capturas"><CapturasTab /></TabsContent>
      <TabsContent value="activity"><ActivityTab /></TabsContent>
    </Tabs>
  );
}

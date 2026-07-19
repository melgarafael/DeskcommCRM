"use client";
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { SourcesTab } from "./SourcesTab";
import { RulesTab } from "./RulesTab";
import { ActivityTab } from "./ActivityTab";

export function WebhooksClient() {
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
    // Mesma altura do TabsList (h-9) e largura medida da tablist — zero layout shift.
    return (
      <div className="flex-1">
        <Skeleton className="h-9 w-[306px]" />
      </div>
    );
  }

  return (
    <Tabs defaultValue="sources" className="flex-1">
      <TabsList>
        <TabsTrigger value="sources">Receber dados</TabsTrigger>
        <TabsTrigger value="rules">Automações</TabsTrigger>
        <TabsTrigger value="activity">Atividade</TabsTrigger>
      </TabsList>
      <TabsContent value="sources"><SourcesTab /></TabsContent>
      <TabsContent value="rules"><RulesTab /></TabsContent>
      <TabsContent value="activity"><ActivityTab /></TabsContent>
    </Tabs>
  );
}

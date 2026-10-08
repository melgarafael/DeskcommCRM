"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // `max-w-full overflow-x-auto` porque uma fila de abas cresce com o
      // produto e nunca encolhe: no detalhe do agente são SEIS, e em 390px de
      // largura a fila mede 814px — a página inteira passava a rolar na
      // horizontal, que é o pior jeito de uma tela quebrar (o conteúdo some
      // para o lado e nada indica que existe). Medido antes/depois com
      // `documentElement.scrollWidth - clientWidth`.
      //
      // Aqui e não na tela do agente de propósito: TODA `TabsList` do app tem a
      // mesma fragilidade, e consertar só onde eu esbarrei deixaria as irmãs
      // quebradas com um álibi de "já foi tratado".
      "inline-flex h-9 max-w-full items-center justify-center overflow-x-auto rounded-lg bg-muted p-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // `transition-[background-color,color,box-shadow]` em vez de
      // `transition-all`: o que muda ao ativar a aba é exatamente isto —
      // `data-[state=active]` troca fundo, cor do texto e sombra. `all` é
      // anti-pattern declarado em `docs/design-system/07-motion-language.md`,
      // e numa fila de abas ele ainda animava `width`/`padding` a cada troca.
      // Sombra e borda contam como um par pela própria exceção da lei.
      // `min-h-11 lg:min-h-0` — 44px de altura onde o dedo aciona.
      //
      // `px-3 py-1` em volta de `text-sm` dá **28px**, e a aba é o controle
      // mais repetido do produto: medido em 360px, 6 delas em Conexões, 2 em
      // Equipe, 2 em Atividades e 2 em Tarefas — todas na mesma altura curta.
      // Como a régua vale para TODA `TabsList`, o conserto aqui alcança as
      // quatro telas de uma vez, e as que já resolveram à mão (a fila do
      // Inbox) seguem com o delas, porque `cn` deixa o chamador vencer.
      //
      // `lg:` é o mesmo corte que `components/ui/button.tsx` usa para separar
      // "quem aciona é dedo" de "quem aciona é cursor".
      "inline-flex min-h-11 items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap ring-offset-background transition-[background-color,color,box-shadow] duration-fast focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm lg:min-h-0",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };

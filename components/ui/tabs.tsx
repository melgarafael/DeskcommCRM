"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

/**
 * Tab Bar — Visitors (DESIGN.md): sem preenchimento de fundo, texto Ash no
 * inativo, Carbon no ativo com underline lavanda de 2px. Mantido o
 * `max-w-full overflow-x-auto`: fila de abas cresce com o produto e a página
 * nunca pode rolar na horizontal (ver comentário original abaixo).
 */
const Tabs = TabsPrimitive.Root

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
      "inline-flex h-10 max-w-full items-center justify-start gap-1 overflow-x-auto border-b border-border bg-transparent p-0 text-text-subtle",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium tracking-[-0.02em] ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:border-accent data-[state=active]:text-text",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }

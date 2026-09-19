"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        // A LARGURA MÁXIMA MORA AQUI, na classe base — não em quem usa o tooltip.
        //
        // O Radix desenha o balão com `minWidth: max-content` (react-popper) e nada
        // o limita: 267 caracteres viraram UMA linha de ~1467 px, com o fim do texto
        // fora da tela em 1280, 1366 e 1440 (#1215). Declarar `max-w` só no ponto que
        // mostrou o defeito conserta aquele texto LITERAL, que alguém consegue contar
        // no código. O tooltip da bolha do inbox mostra `message.error_message`, que
        // vem do provedor: não tem tamanho conhecido nem teto no banco (`text`), e
        // nenhuma varredura de código pode medi-lo. Na base, o teto vale para todo
        // tooltip, inclusive os que nascem de dado — e `break-words` é o par
        // obrigatório disso: sem ele, um erro de provedor sem espaço (URL, hash) é
        // cortado pelo `overflow-hidden` em vez de quebrar a linha.
        "z-50 max-w-xs overflow-hidden break-words rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-tooltip-content-transform-origin)",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }

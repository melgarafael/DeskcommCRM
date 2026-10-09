"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

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
        "ds-painel z-50 max-w-xs origin-(--radix-tooltip-content-transform-origin) overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs break-words text-primary-foreground",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

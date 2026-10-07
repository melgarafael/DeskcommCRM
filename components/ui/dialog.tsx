"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // `ds-cortina` no lugar de `animate-in`/`fade-in-0`: aquelas classes vêm
      // do plugin `tailwindcss-animate`, que nunca foi instalado neste repo, e
      // classe inexistente no Tailwind não gera CSS nem erro. A régua está em
      // `app/globals.css`.
      "ds-cortina fixed inset-0 z-50 bg-black/80",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const t = useT();
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // `ds-modal` no lugar das OITO classes de animação que estavam aqui
          // (`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-left-1/2`,
          // `slide-in-from-top-[48%]` e as irmãs de saída). Todas vinham do
          // plugin `tailwindcss-animate`, que nunca foi instalado neste repo:
          // elas não geravam CSS nem erro, e os ~27 diálogos do produto abriam
          // de um quadro para o outro com o build verde.
          //
          // Saiu também o `duration-200`: era duração de TRANSIÇÃO, e aqui não
          // havia transição nenhuma para durar.
          //
          // ⚠️ `translate-x-[-50%] translate-y-[-50%]` FICAM. É a centralização,
          // e ela não pode depender da animação rodar. Os keyframes de
          // `ds-modal` animam a mesma propriedade `translate` e terminam no
          // mesmo `-50% -50%`, então o modal nunca sai do centro — o porquê
          // inteiro está no bloco do modal em `app/globals.css`.
          "ds-modal fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border bg-background p-6 shadow-lg sm:rounded-lg",
          className,
        )}
        {...props}
      >
        {children}
        {/*
          44px de alvo sem mover o ícone um pixel: `p-3.5` dá uma caixa de 44px
          em volta do ícone de 16px, e `-m-3.5` puxa a caixa de volta para que a
          borda do X continue a 16px do canto. Piso de toque do princípio 4 de
          `docs/design-system/screen-flow/07-responsive-strategy.md`, sem
          redesenhar os ~27 diálogos. `lg:m-0 lg:p-0` devolve o desktop idêntico.
        */}
        <DialogPrimitive.Close className="absolute top-4 right-4 -m-3.5 rounded-sm p-3.5 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground lg:m-0 lg:p-0">
          <X className="h-4 w-4" />
          <span className="sr-only">{t("Fechar")}</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg leading-none font-semibold tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};

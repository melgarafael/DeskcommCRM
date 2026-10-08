"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    className={cn(
      // `ds-cortina` no lugar de `animate-in`/`fade-in-0`: aquelas classes vêm
      // do plugin `tailwindcss-animate`, que NUNCA foi instalado neste repo, e
      // classe inexistente no Tailwind não gera CSS nem erro — a cortina
      // aparecia e desaparecia seca. A régua está em `app/globals.css`.
      "ds-cortina fixed inset-0 z-50 bg-black/80",
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

/**
 * ─── Por que não há mais nenhuma classe de animação aqui ────────────────────
 *
 * As que havia — `animate-in`, `animate-out`, `slide-in-from-left` e as outras
 * seis irmãs — vêm do plugin `tailwindcss-animate`, que nunca foi instalado
 * neste repositório. Classe que o Tailwind não conhece não gera CSS e não gera
 * erro, então **as seis gavetas em produção abriam de um quadro para o outro**
 * com o build verde. O diagnóstico já estava escrito no comentário de
 * `.agenda-coluna-horarios`, em `app/globals.css`.
 *
 * Quem anima agora é a classe `ds-gaveta`, com o lado vindo de `data-lado`. A
 * régua inteira (por que `animation` e não `transition`, por que `ease-out-slow`
 * e não `ease-spring`, por que um par de keyframes serve os quatro lados) está
 * naquele arquivo, junto do resto do movimento — e não espalhada em variante.
 *
 * Saíram também `transition ease-in-out` (inútil: quem anima é `animation`) e
 * `duration-300`/`duration-500`. Os dois números estavam **fora da tabela de
 * durações** que `docs/design-system/07-motion-language.md` fecha em
 * 120/200/320/420ms — e 500ms numa gaveta é o que a lei chama de "parece
 * travado".
 */
const sheetVariants = cva("ds-gaveta fixed z-50 gap-4 bg-background p-6 shadow-lg", {
  variants: {
    side: {
      top: "inset-x-0 top-0 border-b",
      bottom: "inset-x-0 bottom-0 border-t",
      left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
      right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
    },
  },
  defaultVariants: {
    side: "right",
  },
});

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = "right", className, children, ...props }, ref) => {
  const t = useT();
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        /*
          `data-lado` é o que diz ao CSS de onde a gaveta vem. Atributo, e não
          quatro pares de keyframes: o lado só troca um token
          (`--ds-gaveta-de`), então a animação é escrita uma vez.

          Não dá para reusar o `data-side` do Radix aqui — o `Dialog.Content`,
          que é a primitiva por baixo do Sheet, não emite nenhum: `data-side` é
          coisa de popper (menu, dica, seletor), e o Sheet não é popper.
        */
        data-lado={side}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {/*
          44px DE ALVO SEM MOVER O ÍCONE UM PIXEL.

          Este é o botão de fechar de TODA gaveta do produto, e no celular ele
          era um alvo de 16px encostado na borda da tela — onde o dedo tem menos
          precisão. O piso é 44px (Apple HIG), adotado pelo princípio 4 de
          `docs/design-system/screen-flow/07-responsive-strategy.md`.

          O truque é `p-3.5` com `-m-3.5` por cima: 14px de preenchimento em
          volta de um ícone de 16px dá uma caixa de 44px, e os -14px de margem
          puxam a caixa de volta, então a borda do ÍCONE continua a 16px do
          canto, exatamente onde estava. Crescer a caixa sem compensar moveria o
          X uns 14px para dentro em todas as gavetas — conserto de alvo de toque
          não precisa mexer no desenho.

          `lg:m-0 lg:p-0` devolve o desktop idêntico ao que era.
        */}
        <SheetPrimitive.Close className="absolute top-4 right-4 -m-3.5 rounded-sm p-3.5 opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-secondary lg:m-0 lg:p-0">
          <X className="h-4 w-4" />
          <span className="sr-only">{t("Fechar")}</span>
        </SheetPrimitive.Close>
        {children}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};

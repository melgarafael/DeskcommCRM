import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Button — Sage design system.
 * Variants:
 *   - primary (default): accent fill, branded CTA
 *   - secondary: surface-elevated com border, ação neutra
 *   - ghost: transparent, hover suave (toolbar/inline)
 *   - destructive: error fill (delete/cancel destrutivo)
 *   - outline: alias de secondary com background transparente (compat shadcn)
 *   - link: text-only com underline
 *   - default: alias de primary (compat shadcn)
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-sm font-medium",
    // `transform` SAIU da lista, e `translate` não entrou no lugar.
    //
    // O recuo do toque é `active:translate-y-px`, lá embaixo. No Tailwind 4 essa
    // classe compila para a propriedade INDIVIDUAL `translate`, não para
    // `transform` — então `transform` nesta lista era uma propriedade que nunca
    // muda, pedindo transição para nada.
    //
    // E `translate` fica fora de propósito: o recuo do `:active` é o único
    // retorno INSTANTÂNEO da interface — é ele que faz o botão parecer apertado
    // em vez de clicado. A lei pede 80ms, que nem existe na tabela de durações
    // dela própria; transicionar em `duration-fast` (120ms) deixaria a descida
    // E a subida arrastadas, que é o oposto do que o recuo comunica.
    "transition-[background-color,border-color,color,box-shadow]",
    "duration-fast ease-out",
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "active:translate-y-px",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-foreground hover:bg-accent-hover shadow-xs",
        default: "bg-accent text-accent-foreground hover:bg-accent-hover shadow-xs",
        secondary:
          "bg-surface-elevated text-text border border-border hover:border-accent hover:text-accent",
        outline:
          "bg-transparent text-text border border-border hover:border-accent hover:text-accent",
        ghost: "bg-transparent text-text hover:bg-accent-soft hover:text-accent",
        destructive: "bg-error text-white hover:brightness-95 shadow-xs",
        link: "bg-transparent text-accent underline underline-offset-4 decoration-1 hover:decoration-2 h-auto p-0",
      },
      // Alturas de toque: abaixo de `lg` (mesmo corte que o resto da casca
      // usa pra decidir "é celular/tablet, é mouse") toda variante bate os
      // 44px recomendados pra alvo de toque; de `lg:` pra cima, onde quem
      // aciona é cursor, volta pro tamanho compacto original — mudar isso
      // globalmente pro app inteiro em telas grandes infla a densidade sem
      // necessidade nenhuma. `lg` já nascia com 44px e não precisou mudar.
      size: {
        sm: "h-11 px-3 text-xs lg:h-8",
        default: "h-11 px-4 text-sm lg:h-9",
        md: "h-11 px-4 text-sm lg:h-9",
        lg: "h-11 px-6 text-sm",
        icon: "h-11 w-11 lg:h-9 lg:w-9",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

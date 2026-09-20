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
 *   - destructive: error tingido (delete/cancel destrutivo)
 *   - outline: alias de secondary com background transparente (compat shadcn)
 *   - link: text-only com underline
 *   - default: alias de primary (compat shadcn)
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-md font-medium",
    "transition-[background-color,border-color,color,box-shadow,transform]",
    "duration-fast ease-out",
    // Anel COLADO, e não anel com respiro. O `ring-offset-2` desenhava 2px da
    // cor do fundo entre o botão e o anel, e o conjunto ocupava 4px fora da
    // caixa — em toolbar apertada e em botão dentro de tabela isso encosta no
    // vizinho. `ring-3` sem offset ocupa 3px e não some: o anel é desenhado
    // por FORA do botão, sobre o fundo neutro da página, então 40% do
    // Sage 500 tem contraste mesmo no botão que já é preenchido de accent.
    // Ring é box-shadow: não entra no box model, não desloca nada.
    "focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-accent-500/40",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "active:translate-y-px",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-foreground hover:bg-accent-hover shadow-xs",
        default:
          "bg-accent text-accent-foreground hover:bg-accent-hover shadow-xs",
        // O hover destas três parou de virar accent. Tingir texto e borda de
        // verde a cada passada de mouse fazia a tela inteira piscar de accent
        // em telas com muitos controles (Kanban, Inbox, tabela de contatos) e
        // gastava a cor da marca no lugar errado — ela é para a ação primária.
        // O degrau neutro é `--color-border`, que NÃO é escolha estética: em
        // claro (#f5f3ee → #e7e3da) e em escuro (#272620 → #33312a) ele é
        // exatamente o próximo degrau de superfície acima de `surface-elevated`.
        secondary:
          "bg-surface-elevated text-text border border-border hover:bg-border hover:border-border-strong",
        outline:
          "bg-transparent text-text border border-border hover:bg-surface-elevated hover:border-border-strong",
        ghost:
          "bg-transparent text-text hover:bg-surface-tile aria-expanded:bg-surface-tile",
        // Destrutivo TINGIDO, não bloco vermelho. Os dois tokens já existiam e
        // já são o que o Badge `error` usa — é o vermelho terroso do Sage, e
        // não o `text-white` sobre fill, que era a única cor de alto impacto
        // da interface aparecendo em botão de excluir dentro de menu.
        destructive:
          "bg-error-bg text-error-fg hover:bg-error/20",
        link:
          "bg-transparent text-accent underline underline-offset-4 decoration-1 hover:decoration-2 h-auto p-0",
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
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };

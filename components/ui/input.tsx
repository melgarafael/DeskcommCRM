import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // `bg-bg` e `h-10` ficam como estavam de propósito: mexer no fundo
          // ou na altura do campo muda a aparência de TODO formulário do app,
          // e esta passada é de acabamento, não de redesenho.
          "flex h-10 w-full rounded-md border border-border bg-bg px-4 py-2",
          "text-sm text-text placeholder:text-text-muted",
          "transition-[border-color,box-shadow] duration-fast ease-out",
          "hover:border-border-strong",
          // `ring-accent-soft` era opaco no tema claro (#e4ebe0): o anel tapava
          // o que estivesse atrás em vez de velar. Alfa do Sage 500 vela nos dois.
          "focus-visible:outline-hidden focus-visible:border-accent-500 focus-visible:ring-3 focus-visible:ring-accent-500/30",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text",
          "disabled:cursor-not-allowed disabled:opacity-55",
          // Inválido ganha anel EM REPOUSO. Antes o erro era 1px de borda, que
          // some em tela cheia de campo; o anel é visível sem precisar do foco.
          "aria-[invalid=true]:border-error aria-[invalid=true]:ring-3 aria-[invalid=true]:ring-error/20",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };

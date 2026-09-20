import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // Espelha `input.tsx` — raio, anel de foco e anel de inválido. Altura,
        // fundo e respiro internos ficam como estavam.
        "flex min-h-[80px] w-full rounded-md border border-border bg-bg px-4 py-3",
        "text-sm leading-relaxed text-text placeholder:text-text-muted",
        "transition-[border-color,box-shadow] duration-fast ease-out",
        "hover:border-border-strong",
        "focus-visible:outline-hidden focus-visible:border-accent-500 focus-visible:ring-3 focus-visible:ring-accent-500/30",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "aria-[invalid=true]:border-error aria-[invalid=true]:ring-3 aria-[invalid=true]:ring-error/20",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };

import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-sm border border-border bg-bg px-4 py-3",
          // `text-base md:text-sm` — pelo mesmo motivo do `components/ui/input.tsx`:
          // o Safari do iPhone dá zoom na página quando o campo recebe foco com
          // fonte menor que 16px, e `text-sm` são 14. A régua inteira está no
          // comentário daquele arquivo.
          "text-base leading-relaxed text-text placeholder:text-text-muted md:text-sm",
          "transition-[border-color,box-shadow] duration-fast ease-out",
          "hover:border-border-strong",
          "focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-hidden",
          "disabled:cursor-not-allowed disabled:opacity-55",
          "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error-bg",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };

import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-sm border border-border bg-bg px-4 py-2",
          "text-sm text-text placeholder:text-text-muted",
          "transition-[border-color,box-shadow] duration-fast ease-out",
          "hover:border-border-strong",
          "focus-visible:outline-hidden focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-soft",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text",
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
Input.displayName = "Input";

export { Input };

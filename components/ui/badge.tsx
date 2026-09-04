import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Badge — Sage design system.
 * Variants: default (accent soft), neutral, success, warning, error, info.
 * Compat aliases: secondary -> neutral, destructive -> error, outline -> neutral.
 */
const badgeVariants = cva(
  [
    "inline-flex items-center gap-1 rounded-full border px-3 py-0.5",
    "text-xs font-medium leading-5",
    "transition-colors duration-fast ease-out",
    "focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-accent-soft text-accent",
        neutral:
          "border-border bg-surface-elevated text-text-muted",
        success:
          "border-transparent bg-success-bg text-success-fg",
        warning:
          "border-transparent bg-warning-bg text-warning-fg",
        error:
          "border-transparent bg-error-bg text-error-fg",
        info:
          "border-transparent bg-info-bg text-info-fg",
        // shadcn aliases
        secondary:
          "border-border bg-surface-elevated text-text-muted",
        destructive:
          "border-transparent bg-error-bg text-error-fg",
        outline:
          "border-border bg-transparent text-text",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };

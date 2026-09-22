"use client";

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

/**
 * Stepper numérico canônico (− valor +): alvos de 44px no mobile, input
 * editável, mínimo configurável. Substitui os +/− ad-hoc por página.
 */
export function NexusQuantityStepper({
  value,
  min = 1,
  onChange,
  label,
  className,
}: {
  value: number;
  min?: number;
  onChange: (next: number) => void;
  label?: string;
  className?: string;
}) {
  const t = useT();
  const rotulo = label ?? t("Quantidade");
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 w-11 shrink-0 px-0 lg:h-9 lg:w-9"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label={t("Diminuir quantidade")}
      >
        <Minus size={16} aria-hidden />
      </Button>
      <Input
        type="number"
        min={min}
        className="h-11 text-center lg:h-9"
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
        aria-label={rotulo}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 w-11 shrink-0 px-0 lg:h-9 lg:w-9"
        onClick={() => onChange(value + 1)}
        aria-label={t("Aumentar quantidade")}
      >
        <Plus size={16} aria-hidden />
      </Button>
    </div>
  );
}

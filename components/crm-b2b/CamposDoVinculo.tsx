"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

export interface Vinculo {
  job_title: string;
  is_decision_maker: boolean;
}

export const VINCULO_VAZIO: Vinculo = { job_title: "", is_decision_maker: false };

/** Cargo e decisor: o que o vínculo pessoa ↔ empresa guarda (issue #3198). */
export function CamposDoVinculo({
  valor,
  onChange,
}: {
  valor: Vinculo;
  onChange: (v: Vinculo) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <div className="grid gap-1.5">
        <Label htmlFor="vinculo-cargo">{t("Cargo")}</Label>
        <Input
          id="vinculo-cargo"
          value={valor.job_title}
          maxLength={200}
          onChange={(e) => onChange({ ...valor, job_title: e.target.value })}
        />
      </div>
      <div className="flex items-center gap-2 pb-2">
        <Switch
          id="vinculo-decisor"
          checked={valor.is_decision_maker}
          onCheckedChange={(v) => onChange({ ...valor, is_decision_maker: v })}
        />
        <Label htmlFor="vinculo-decisor">{t("Decisor")}</Label>
      </div>
    </div>
  );
}

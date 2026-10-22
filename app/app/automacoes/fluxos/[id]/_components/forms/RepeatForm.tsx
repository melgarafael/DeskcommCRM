"use client";

import { useT } from "@/hooks/i18n/useT";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { repeatConfigSchema } from "@/lib/followup/graph-schema";

import type { ConfigOf } from "./shared";

export function RepeatForm({
  config,
  onChange,
}: {
  config: ConfigOf<"repeat">;
  onChange: (c: ConfigOf<"repeat">) => void;
}) {
  const t = useT();
  const [maxCount, setMaxCount] = useState(String(config.max_count));
  const [error, setError] = useState<string | null>(null);

  const commit = (raw: string) => {
    setMaxCount(raw);
    const parsed = repeatConfigSchema.safeParse({ max_count: Number(raw) });
    if (!parsed.success) {
      setError("Informe um número de 1 a 20.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="repeat-max">{t("No máximo quantas voltas")}</Label>
      <Input
        id="repeat-max"
        type="number"
        min={1}
        max={20}
        value={maxCount}
        onChange={(e) => commit(e.target.value)}
      />
      <p className="text-xs text-text-muted">
        {t("A última resposta vira o número de voltas (ex.: 4 filhos). O teto evita um loop sem fim.")}
      </p>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

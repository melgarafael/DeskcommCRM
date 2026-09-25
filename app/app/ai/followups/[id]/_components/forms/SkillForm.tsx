"use client";

import { useState } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { skillConfigSchema } from "@/lib/followup/graph-schema";
import { useSkills } from "@/hooks/ai/useSkills";
import { useT } from "@/hooks/i18n/useT";

import type { ConfigOf } from "./shared";

/**
 * Puxa uma skill instalada em paralelo ao passo do fluxo (nó `skill`). O
 * seletor lê as skills instaladas da organização; trata carregando/vazio/erro
 * em vez de mostrar um campo vazio sem explicação.
 */
export function SkillForm({
  config,
  onChange,
}: {
  config: ConfigOf<"skill">;
  onChange: (c: ConfigOf<"skill">) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(config.skill_name);
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, isError } = useSkills();

  const commit = (nome: string) => {
    setValue(nome);
    const parsed = skillConfigSchema.safeParse({ skill_name: nome });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="skill-name">{t("Skill a puxar neste passo")}</Label>
        {isLoading ? (
          <p className="text-xs text-text-muted">{t("Carregando suas skills…")}</p>
        ) : isError || !data?.installed?.length ? (
          <p className="text-xs text-text-muted">
            {t("Você ainda não tem skills instaladas. Instale em IA → Skills.")}
          </p>
        ) : (
          <Select value={value} onValueChange={commit}>
            <SelectTrigger id="skill-name">
              <SelectValue placeholder={t("Escolha uma skill")} />
            </SelectTrigger>
            <SelectContent>
              {data.installed.map((s) => (
                <SelectItem key={s.name} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

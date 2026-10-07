"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { editLeadTagConfigSchema } from "@/lib/followup/graph-schema";

import type { ConfigOf } from "./shared";

/**
 * O nó `edit_lead_tag` (#2065) — as tags que a caixa grava no lead.
 *
 * O texto digitado fica NO CAMPO (vírgula no fim não some enquanto a pessoa
 * escreve) e o config só recebe o que passou no `editLeadTagConfigSchema` — os
 * MESMOS limites da ação `add_tag` (até 10 tags de até 60 caracteres). O merge
 * é idempotente e vem de lá: tag que o lead já tem não duplica, e nada é
 * apagado.
 */
export function EditLeadTagForm({
  config,
  onChange,
}: {
  config: ConfigOf<"edit_lead_tag">;
  onChange: (c: ConfigOf<"edit_lead_tag">) => void;
}) {
  const t = useT();
  const [texto, setTexto] = useState(() => config.tags.join(", "));
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (bruto: string) => {
    setTexto(bruto);
    const tags = bruto
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const parsed = editLeadTagConfigSchema.safeParse({ tags });
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    if (parsed.data.tags.join("\u0000") !== config.tags.join("\u0000")) onChange(parsed.data);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="edit-lead-tag">{t("Tags para gravar no lead")}</Label>
      <Input
        id="edit-lead-tag"
        value={texto}
        placeholder={t("ex.: vip, orcamento-aberto")}
        onChange={(e) => gravar(e.target.value)}
        aria-invalid={erro !== null}
      />
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
      <p className="text-xs text-text-muted">
        {t("Separe por vírgula. Tags que o lead já tem são mantidas e nada é apagado.")}
      </p>
    </div>
  );
}

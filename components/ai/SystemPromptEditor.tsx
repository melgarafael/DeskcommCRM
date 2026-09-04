"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { SYSTEM_PROMPT_PLACEHOLDERS } from "@/lib/ai/guardrails-schema";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

export function SystemPromptEditor({ value, onChange, disabled }: Props) {
  const t = useT();
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  function insertPlaceholder(token: string) {
    const el = ref.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    // Restaura cursor após inserção (tick depois)
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
      <div className="space-y-2">
        <Label htmlFor="system_prompt">{t("System prompt")}</Label>
        <Textarea
          id="system_prompt"
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          rows={18}
          className="font-mono text-sm"
          placeholder={t("Você é um assistente da loja. Responda com clareza e cordialidade…")}
        />
        <p className="text-xs text-muted-foreground">
          {t("Mínimo 20 caracteres, máximo 10.000. Use placeholders para injetar contexto dinâmico.")}
        </p>
      </div>

      <aside className="space-y-2 rounded-md border bg-muted/30 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("Placeholders")}
        </p>
        <ul className="space-y-1.5">
          {SYSTEM_PROMPT_PLACEHOLDERS.map((p) => (
            <li key={p.token} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <code className="rounded-md bg-background px-1.5 py-0.5 text-[11px]">{p.token}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => insertPlaceholder(p.token)}
                  disabled={disabled}
                >
                  {t("Inserir")}
                </Button>
              </div>
              <span className="text-[11px] text-muted-foreground">{t(p.description)}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

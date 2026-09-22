"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { guardrailItemSchema, type GuardrailItem, type GuardrailKind } from "@/lib/ai/guardrails-schema";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  value: GuardrailItem[];
  onChange: (next: GuardrailItem[]) => void;
  disabled?: boolean;
}

const KIND_LABELS: Record<GuardrailKind, string> = {
  regex_output_block: "Regex output block",
  rag_must_hit: "RAG must hit",
  regex_input_block: "Regex input block",
  window_check: "Janela horária",
  contact_flag: "Contact flag",
};

function defaultForKind(kind: GuardrailKind, t: (texto: string) => string = (texto) => texto): GuardrailItem {
  switch (kind) {
    case "regex_output_block":
      return {
        kind: "regex_output_block",
        pattern: "",
        flags: "i",
        reason: t("Bloquear conteúdo sensível na resposta"),
      };
    case "rag_must_hit":
      return { kind: "rag_must_hit", min_citations: 1, reason: t("Exigir citação da base") };
    case "regex_input_block":
      return {
        kind: "regex_input_block",
        pattern: "",
        flags: "i",
        reason: t("Bloquear input com termo proibido"),
      };
    case "window_check":
      return {
        kind: "window_check",
        start_hour: 7,
        end_hour: 22,
        timezone: "America/Sao_Paulo",
        reason: t("Janela operacional 7h-22h"),
      };
    case "contact_flag":
      return {
        kind: "contact_flag",
        field: "force_human",
        expected: false,
        reason: t("Skip se contato pediu humano"),
      };
  }
}

export function GuardrailsEditor({ value, onChange, disabled }: Props) {
  const t = useT();
  const [pendingKind, setPendingKind] = React.useState<GuardrailKind>("regex_output_block");

  function update(idx: number, patch: Partial<GuardrailItem>) {
    const next = value.map((it, i) => (i === idx ? ({ ...it, ...patch } as GuardrailItem) : it));
    onChange(next);
  }

  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  function add() {
    onChange([...value, defaultForKind(pendingKind, t)]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label className="text-xs">{t("Tipo do novo guardrail")}</Label>
          <Select
            value={pendingKind}
            onValueChange={(v) => setPendingKind(v as GuardrailKind)}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_LABELS) as GuardrailKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {t(KIND_LABELS[k])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" onClick={add} disabled={disabled}>
          {t("Adicionar guardrail")}
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("Nenhum guardrail definido. O agent responde sem restrições adicionais.")}
        </p>
      ) : (
        <ul className="space-y-3">
          {value.map((item, idx) => {
            const parsed = guardrailItemSchema.safeParse(item);
            const invalid = !parsed.success;
            return (
              <li
                key={idx}
                className={`rounded-2xl border p-3 ${invalid ? "border-destructive/60" : ""}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t(KIND_LABELS[item.kind])}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(idx)}
                    disabled={disabled}
                  >
                    {t("Remover")}
                  </Button>
                </div>
                <GuardrailFields item={item} onPatch={(p) => update(idx, p)} disabled={disabled} />
                {invalid && (
                  <p className="mt-2 text-xs text-destructive">
                    {t("Campos inválidos. Ajuste antes de salvar.")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GuardrailFields({
  item,
  onPatch,
  disabled,
}: {
  item: GuardrailItem;
  onPatch: (p: Partial<GuardrailItem>) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const reasonField = (
    <div className="space-y-1">
      <Label className="text-xs">{t("Motivo")}</Label>
      <Input
        value={item.reason}
        onChange={(e) => onPatch({ reason: e.target.value } as Partial<GuardrailItem>)}
        disabled={disabled}
      />
    </div>
  );

  if (item.kind === "regex_output_block" || item.kind === "regex_input_block") {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">Pattern (regex)</Label>
          <Input
            value={item.pattern}
            onChange={(e) => onPatch({ pattern: e.target.value } as Partial<GuardrailItem>)}
            disabled={disabled}
            className="font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Flags</Label>
          <Input
            value={item.flags ?? "i"}
            onChange={(e) => onPatch({ flags: e.target.value } as Partial<GuardrailItem>)}
            disabled={disabled}
            className="font-mono"
          />
        </div>
        <div className="md:col-span-3">{reasonField}</div>
      </div>
    );
  }

  if (item.kind === "rag_must_hit") {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-xs">{t("Citações mínimas")}</Label>
          <Input
            type="number"
            min={1}
            max={10}
            value={item.min_citations}
            onChange={(e) =>
              onPatch({
                min_citations: Number(e.target.value) || 1,
              } as Partial<GuardrailItem>)
            }
            disabled={disabled}
          />
        </div>
        <div className="md:col-span-2">{reasonField}</div>
      </div>
    );
  }

  if (item.kind === "window_check") {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">{t("Hora início (0-23)")}</Label>
          <Input
            type="number"
            min={0}
            max={23}
            value={item.start_hour}
            onChange={(e) =>
              onPatch({ start_hour: Number(e.target.value) } as Partial<GuardrailItem>)
            }
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("Hora fim (0-23)")}</Label>
          <Input
            type="number"
            min={0}
            max={23}
            value={item.end_hour}
            onChange={(e) =>
              onPatch({ end_hour: Number(e.target.value) } as Partial<GuardrailItem>)
            }
            disabled={disabled}
          />
        </div>
        <div className="space-y-1 md:col-span-2">
          <Label className="text-xs">Timezone</Label>
          <Input
            value={item.timezone ?? "America/Sao_Paulo"}
            onChange={(e) => onPatch({ timezone: e.target.value } as Partial<GuardrailItem>)}
            disabled={disabled}
          />
        </div>
        <div className="md:col-span-4">{reasonField}</div>
      </div>
    );
  }

  // contact_flag
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <div className="space-y-1">
        <Label className="text-xs">{t("Campo")}</Label>
        <Select
          value={item.field}
          onValueChange={(v) =>
            onPatch({ field: v as "force_human" | "is_blocked" | "is_vip" } as Partial<GuardrailItem>)
          }
          disabled={disabled}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="force_human">force_human</SelectItem>
            <SelectItem value="is_blocked">is_blocked</SelectItem>
            <SelectItem value="is_vip">is_vip</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 pt-6">
        <Switch
          checked={item.expected}
          onCheckedChange={(v) => onPatch({ expected: v } as Partial<GuardrailItem>)}
          disabled={disabled}
        />
        <Label className="text-xs">
          {t("Valor esperado")}: {item.expected ? "true" : "false"}
        </Label>
      </div>
      <div className="md:col-span-3">{reasonField}</div>
    </div>
  );
}

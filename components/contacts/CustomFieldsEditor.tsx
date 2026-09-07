"use client";
/**
 * CustomFieldsEditor — lê `crm_pipelines.settings.fields[]` e renderiza o
 * input certo por tipo. Usado pelo dossiê e pelo painel do inbox, via
 * `LeadFieldsForm`.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";

export type CustomFieldType =
  | "text"
  | "textarea"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "boolean"
  | "email"
  | "phone"
  | "url";

export interface CustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}

interface Props {
  fields: CustomFieldDef[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  mode: "lead" | "contact";
  disabled?: boolean;
  className?: string;
}

export function CustomFieldsEditor({ fields, value, onChange, disabled, className }: Props) {
  const t = useT();
  function set(key: string, v: unknown) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className={cn("grid grid-cols-1 gap-4 md:grid-cols-2", className)}>
      {fields.map((f) => {
        const v = value[f.key];
        const id = `cf-${f.key}`;

        const labelEl = (
          <Label htmlFor={id}>
            {f.label}
            {f.required && <span className="ml-1 text-error-fg">*</span>}
          </Label>
        );

        switch (f.type) {
          case "textarea":
            return (
              <div key={f.key} className="space-y-2 md:col-span-2">
                {labelEl}
                <Textarea
                  id={id}
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "number":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="number"
                  value={typeof v === "number" ? v : ""}
                  onChange={(e) =>
                    set(f.key, e.target.value === "" ? null : Number(e.target.value))
                  }
                  disabled={disabled}
                />
              </div>
            );
          case "date":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="date"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "select":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Select
                  value={typeof v === "string" ? v : ""}
                  onValueChange={(val) => set(f.key, val)}
                  disabled={disabled}
                >
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={t("Selecione…")} />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options?.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          case "multiselect": {
            const current = Array.isArray(v) ? (v as string[]) : [];
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <div className="flex flex-col gap-1">
                  {f.options?.map((o) => {
                    const checked = current.includes(o.value);
                    return (
                      <label key={o.value} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...current, o.value]
                              : current.filter((x) => x !== o.value);
                            set(f.key, next);
                          }}
                          disabled={disabled}
                        />
                        {o.label}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          }
          case "boolean":
            return (
              <div key={f.key} className="flex items-center justify-between gap-4 md:col-span-2">
                {labelEl}
                <Switch
                  id={id}
                  checked={Boolean(v)}
                  onCheckedChange={(c) => set(f.key, c)}
                  disabled={disabled}
                />
              </div>
            );
          case "email":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="email"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "phone":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="tel"
                  placeholder="+5511999998888"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
                <p className="text-xs text-muted-foreground">{t("Formato E.164")}</p>
              </div>
            );
          case "url":
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="url"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
          case "text":
          default:
            return (
              <div key={f.key} className="space-y-2">
                {labelEl}
                <Input
                  id={id}
                  type="text"
                  value={typeof v === "string" ? v : ""}
                  onChange={(e) => set(f.key, e.target.value)}
                  disabled={disabled}
                />
              </div>
            );
        }
      })}
    </div>
  );
}

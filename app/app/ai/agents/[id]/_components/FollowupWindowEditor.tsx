"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";

export interface FollowupWindowValue {
  start: string;
  end: string;
  weekdays: number[];
}

interface Props {
  value: FollowupWindowValue | null;
  onChange: (value: FollowupWindowValue | null) => void;
  disabled?: boolean;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const DEFAULT_WINDOW: FollowupWindowValue = {
  start: "09:00",
  end: "18:00",
  weekdays: [1, 2, 3, 4, 5],
};

/**
 * Editor da faixa PROATIVA. Ele reutiliza o vocabulário já traduzido do editor
 * de horário do inbound, mas grava em `followup.send_window`: as duas escolhas
 * são deliberadamente independentes.
 */
export function FollowupWindowEditor({ value, onChange, disabled }: Props) {
  const t = useT();
  const invalidRange = value !== null && value.end <= value.start;

  function patch(p: Partial<FollowupWindowValue>) {
    if (value === null) return;
    onChange({ ...value, ...p });
  }

  function toggleWeekday(day: number) {
    if (value === null) return;
    const active = value.weekdays.includes(day);
    // O schema exige ao menos um dia. Impedir a remoção do último evita que a
    // pessoa só descubra o erro depois de clicar em Salvar.
    if (active && value.weekdays.length === 1) return;
    const weekdays = active
      ? value.weekdays.filter((item) => item !== day)
      : [...value.weekdays, day].sort((a, b) => a - b);
    patch({ weekdays });
  }

  function weekdayLabel(day: number): string {
    // Literais de propósito: o gate de espanhol enxerga cada chave usada.
    switch (day) {
      case 0:
        return t("Dom");
      case 1:
        return t("Seg");
      case 2:
        return t("Ter");
      case 3:
        return t("Qua");
      case 4:
        return t("Qui");
      case 5:
        return t("Sex");
      case 6:
        return t("Sáb");
      default:
        return "";
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <Switch
          id="followup_window_enabled"
          checked={value !== null}
          onCheckedChange={(enabled) => onChange(enabled ? DEFAULT_WINDOW : null)}
          disabled={disabled}
        />
        <Label htmlFor="followup_window_enabled">
          {t("Só enviar follow-up nestes horários")}
        </Label>
      </div>

      {value !== null ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="followup_window_start">{t("Início")}</Label>
              <Input
                id="followup_window_start"
                type="time"
                value={value.start}
                onChange={(event) => patch({ start: event.target.value })}
                disabled={disabled}
                aria-invalid={invalidRange}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="followup_window_end">{t("Fim")}</Label>
              <Input
                id="followup_window_end"
                type="time"
                value={value.end}
                onChange={(event) => patch({ end: event.target.value })}
                disabled={disabled}
                aria-invalid={invalidRange}
              />
            </div>
          </div>
          {invalidRange ? (
            <p className="text-xs text-destructive">{t("Campo inválido.")}</p>
          ) : null}

          <div>
            <Label className="mb-1 block">{t("Dias")}</Label>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((day) => {
                const active = value.weekdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleWeekday(day)}
                    disabled={disabled}
                    // #3923 — `min-h-11` abaixo de `lg`: com `px-2 py-1 text-xs`
                    // o alvo ficava em 26px de altura (12px de texto + 8px de
                    // padding + 2px de borda), e no celular o dedo erra o dia —
                    // 44px é o piso de toque da casa (ADR-0006, mesmo padrão de
                    // `components/ui/button.tsx`). No desktop o chip volta ao
                    // tamanho compacto, onde quem aciona é o mouse.
                    className={`min-h-11 rounded-md border px-2 py-1 text-xs lg:min-h-0 ${
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/60 text-muted-foreground"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {weekdayLabel(day)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

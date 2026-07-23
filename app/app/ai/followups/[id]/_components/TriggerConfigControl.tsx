"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useUpdateTriggerConfig } from "@/hooks/followup/useFollowupFlow";

/**
 * Controle de `trigger_config` do pointer (Task 8.5) — o operador NÃO
 * técnico só consegue armar o gatilho `silence` (threshold_minutes) hoje via
 * API crua. Só oferece os 2 kinds com motor de enrollment real: `manual`
 * (POST manual) e `silence` (silence-sweep). `stage_change`/`conversation_end`
 * existem no schema (roadmap) mas não têm producer — nem aparecem aqui, e o
 * publish (route.ts) os rejeita se chegarem por outra via (ex.: API crua).
 */
type TriggerKind = "manual" | "silence";

interface TriggerFormState {
  kind: TriggerKind;
  thresholdMinutes: number;
  segments: string;
  cancelOnReply: boolean;
}

const DEFAULT_THRESHOLD_MINUTES = 60;
const MIN_THRESHOLD_MINUTES = 5;

const KIND_LABEL: Record<TriggerKind, string> = {
  manual: "Manual",
  silence: "Silêncio",
};

function parseTriggerConfig(raw: Record<string, unknown>): TriggerFormState {
  const kind: TriggerKind = raw.kind === "silence" ? "silence" : "manual";
  const params = (raw.params as { threshold_minutes?: number; segments?: string[] } | undefined) ?? {};
  return {
    kind,
    thresholdMinutes:
      kind === "silence" && typeof params.threshold_minutes === "number"
        ? params.threshold_minutes
        : DEFAULT_THRESHOLD_MINUTES,
    segments: kind === "silence" && Array.isArray(params.segments) ? params.segments.join(", ") : "",
    cancelOnReply: raw.cancel_on_reply === true,
  };
}

function toTriggerConfig(form: TriggerFormState): Record<string, unknown> {
  const cancelOnReply = form.cancelOnReply ? { cancel_on_reply: true } : {};
  if (form.kind === "manual") return { kind: "manual", ...cancelOnReply };

  const segments = form.segments
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    kind: "silence",
    params: { threshold_minutes: form.thresholdMinutes, ...(segments.length > 0 ? { segments } : {}) },
    ...cancelOnReply,
  };
}

function summaryLabel(cfg: Record<string, unknown>): string {
  if (cfg.kind === "silence") {
    const minutes = (cfg.params as { threshold_minutes?: number } | undefined)?.threshold_minutes;
    return `Gatilho: Silêncio${typeof minutes === "number" ? ` (${minutes} min)` : ""}`;
  }
  if (cfg.kind === "manual" || cfg.kind === undefined) return "Gatilho: Manual";
  // stage_change/conversation_end de dados antigos (API crua) — sem UI própria,
  // mas mostrado com transparência em vez de mentir "Manual".
  return `Gatilho: ${String(cfg.kind)} (indisponível)`;
}

interface Props {
  flowId: string;
  triggerConfig: Record<string, unknown>;
}

export function TriggerConfigControl({ flowId, triggerConfig }: Props) {
  const update = useUpdateTriggerConfig(flowId);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<TriggerFormState>(() => parseTriggerConfig(triggerConfig));
  const [form, setForm] = useState<TriggerFormState>(saved);

  // Re-sincroniza com o valor persistido quando o popover está FECHADO — nunca
  // no meio de uma edição em andamento (mesma doutrina do `savedGraph` do canvas).
  useEffect(() => {
    if (open) return;
    const next = parseTriggerConfig(triggerConfig);
    setSaved(next);
    setForm(next);
  }, [triggerConfig, open]);

  const thresholdInvalid =
    form.kind === "silence" && (!Number.isFinite(form.thresholdMinutes) || form.thresholdMinutes < MIN_THRESHOLD_MINUTES);
  const dirty =
    form.kind !== saved.kind ||
    form.cancelOnReply !== saved.cancelOnReply ||
    (form.kind === "silence" && (form.thresholdMinutes !== saved.thresholdMinutes || form.segments !== saved.segments));

  const onSave = () => {
    if (thresholdInvalid) return;
    update.mutate(toTriggerConfig(form), {
      onSuccess: () => {
        setSaved(form);
        setOpen(false);
      },
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" data-testid="trigger-config-button">
          {summaryLabel(triggerConfig)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end" data-testid="trigger-config-panel">
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="trigger-kind">Tipo de gatilho</Label>
            <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v as TriggerKind }))}>
              <SelectTrigger id="trigger-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">{KIND_LABEL.manual}</SelectItem>
                <SelectItem value="silence">{KIND_LABEL.silence}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.kind === "silence" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="trigger-threshold">Minutos de silêncio</Label>
                <Input
                  id="trigger-threshold"
                  type="number"
                  min={MIN_THRESHOLD_MINUTES}
                  value={form.thresholdMinutes}
                  onChange={(e) => setForm((f) => ({ ...f, thresholdMinutes: Number(e.target.value) }))}
                  aria-invalid={thresholdInvalid}
                />
                {thresholdInvalid && (
                  <p className="text-xs text-error-fg">Mínimo de {MIN_THRESHOLD_MINUTES} minutos.</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="trigger-segments">Segmentos (tags, opcional)</Label>
                <Input
                  id="trigger-segments"
                  placeholder="ex: vip, carrinho-abandonado"
                  value={form.segments}
                  onChange={(e) => setForm((f) => ({ ...f, segments: e.target.value }))}
                />
              </div>
            </>
          )}

          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="trigger-cancel-on-reply">Cancelar se o lead responder</Label>
            <Switch
              id="trigger-cancel-on-reply"
              checked={form.cancelOnReply}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, cancelOnReply: checked }))}
            />
          </div>

          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={!dirty || thresholdInvalid || update.isPending}
            onClick={onSave}
            data-testid="trigger-config-save"
          >
            {update.isPending ? "Salvando…" : "Salvar gatilho"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

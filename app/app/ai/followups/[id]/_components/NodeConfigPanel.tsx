"use client";

import { useState } from "react";

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
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash } from "@/lib/ui/icons";
import {
  waitConfigSchema,
  conditionConfigSchema,
  aiClassifyConfigSchema,
  actionConfigSchema,
  endConfigSchema,
  type FlowNode,
} from "@/lib/followup/graph-schema";
import type { RFNode, RFNodeData } from "@/lib/followup/graph-mappers";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

type ConfigOf<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>["config"];

interface Props {
  node: RFNode;
  onChange: (patch: Partial<RFNodeData>) => void;
}

/**
 * Zod-driven config form, one variant per node type. Each field commits to
 * the live React Flow node (`onChange`) only when the candidate config
 * passes its schema — otherwise the field shows an inline error and the
 * canvas keeps the last valid config (never a half-written value upstream).
 */
export function NodeConfigPanel({ node, onChange }: Props) {
  const type = node.type as FlowNode["type"];
  const visual = NODE_VISUALS[type];
  const Icon = visual.icon;
  const [label, setLabel] = useState(node.data.label);
  const [labelError, setLabelError] = useState<string | null>(null);

  const commitLabel = (value: string) => {
    setLabel(value);
    if (value.trim().length < 1 || value.length > 60) {
      setLabelError("Rótulo precisa ter 1 a 60 caracteres.");
      return;
    }
    setLabelError(null);
    onChange({ label: value });
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto" data-testid="node-config-panel">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${visual.chipClassName}`}>
            <Icon size={14} aria-hidden />
          </span>
          {visual.paletteLabel}
        </h2>
        <p className="text-sm text-text-muted">
          Alterações aplicam no rascunho ao digitar — salve na barra de publicação.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="node-label">Rótulo</Label>
        <Input
          id="node-label"
          value={label}
          maxLength={60}
          onChange={(e) => commitLabel(e.target.value)}
        />
        {labelError && <p className="text-xs text-error-fg">{labelError}</p>}
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        {type === "trigger" && (
          <p className="text-sm text-text-muted">
            Início do fluxo — sem configuração adicional. O disparo (manual, mudança de
            etapa, silêncio ou fim de conversa) é definido nas configurações do fluxo.
          </p>
        )}
        {type === "wait" && (
          <WaitForm config={node.data.config as ConfigOf<"wait">} onChange={(config) => onChange({ config })} />
        )}
        {type === "condition" && (
          <ConditionForm
            config={node.data.config as ConfigOf<"condition">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "ai_classify" && (
          <ClassifyForm
            config={node.data.config as ConfigOf<"ai_classify">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "action" && (
          <ActionForm config={node.data.config as ConfigOf<"action">} onChange={(config) => onChange({ config })} />
        )}
        {type === "end" && (
          <EndForm config={node.data.config as ConfigOf<"end">} onChange={(config) => onChange({ config })} />
        )}
      </div>
    </div>
  );
}

// ─── wait ────────────────────────────────────────────────────────────────

function msToMin(ms: number): number {
  return Math.round(ms / 60_000);
}
function minToMs(min: number): number {
  return Math.round(min * 60_000);
}

function WaitForm({
  config,
  onChange,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
}) {
  const [mode, setMode] = useState<"fixed" | "smart">(config.mode);
  const [durationMin, setDurationMin] = useState(
    config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
  );
  const [minMin, setMinMin] = useState(config.mode === "smart" ? msToMin(config.min_ms) : 5);
  const [maxMin, setMaxMin] = useState(config.mode === "smart" ? msToMin(config.max_ms) : 60);
  const [guidance, setGuidance] = useState(config.mode === "smart" ? (config.guidance ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: "fixed" | "smart";
    durationMin: number;
    minMin: number;
    maxMin: number;
    guidance: string;
  }) => {
    const candidate =
      next.mode === "fixed"
        ? { mode: "fixed" as const, duration_ms: minToMs(next.durationMin) }
        : {
            mode: "smart" as const,
            min_ms: minToMs(next.minMin),
            max_ms: minToMs(next.maxMin),
            ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
          };
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="wait-mode">Modo</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "fixed" | "smart";
            setMode(next);
            commit({ mode: next, durationMin, minMin, maxMin, guidance });
          }}
        >
          <SelectTrigger id="wait-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">Fixo</SelectItem>
            <SelectItem value="smart">Adaptativo (min–max)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "fixed" ? (
        <div className="space-y-2">
          <Label htmlFor="wait-duration">Duração (minutos)</Label>
          <Input
            id="wait-duration"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDurationMin(v);
              commit({ mode, durationMin: v, minMin, maxMin, guidance });
            }}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">Mínimo (min)</Label>
              <Input
                id="wait-min"
                type="number"
                min={5}
                value={minMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinMin(v);
                  commit({ mode, durationMin, minMin: v, maxMin, guidance });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">Máximo (min)</Label>
              <Input
                id="wait-max"
                type="number"
                min={5}
                value={maxMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxMin(v);
                  commit({ mode, durationMin, minMin, maxMin: v, guidance });
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">Orientação (opcional)</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => {
                setGuidance(e.target.value);
                commit({ mode, durationMin, minMin, maxMin, guidance: e.target.value });
              }}
            />
          </div>
        </>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── condition ───────────────────────────────────────────────────────────

const CONDITION_FIELDS = ["lead_stage", "tag", "steps_taken", "last_outcome"] as const;
const CONDITION_OPS = ["eq", "neq", "gte", "lte", "contains"] as const;

function ConditionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"condition">;
  onChange: (c: ConfigOf<"condition">) => void;
}) {
  const [combinator, setCombinator] = useState(config.combinator);
  const [checks, setChecks] = useState(config.checks);
  const [error, setError] = useState<string | null>(null);

  const commit = (nextCombinator: "and" | "or", nextChecks: typeof checks) => {
    const parsed = conditionConfigSchema.safeParse({ combinator: nextCombinator, checks: nextChecks });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="cond-combinator">Combinador</Label>
        <Select
          value={combinator}
          onValueChange={(v) => {
            const next = v as "and" | "or";
            setCombinator(next);
            commit(next, checks);
          }}
        >
          <SelectTrigger id="cond-combinator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">E (todas)</SelectItem>
            <SelectItem value="or">OU (qualquer uma)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        {checks.map((check, idx) => (
          <div key={idx} className="space-y-2 rounded-sm border border-border p-2" data-testid={`condition-check-${idx}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">Condição {idx + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remover condição"
                disabled={checks.length <= 1}
                onClick={() => {
                  const next = checks.filter((_, i) => i !== idx);
                  setChecks(next);
                  commit(combinator, next);
                }}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
            <Select
              value={check.field}
              onValueChange={(v) => {
                const next = checks.map((c, i) => (i === idx ? { ...c, field: v as (typeof CONDITION_FIELDS)[number] } : c));
                setChecks(next);
                commit(combinator, next);
              }}
            >
              <SelectTrigger aria-label="Campo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_FIELDS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={check.op}
              onValueChange={(v) => {
                const next = checks.map((c, i) => (i === idx ? { ...c, op: v as (typeof CONDITION_OPS)[number] } : c));
                setChecks(next);
                commit(combinator, next);
              }}
            >
              <SelectTrigger aria-label="Operador">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {op}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Valor"
              placeholder="Valor"
              value={String(check.value)}
              onChange={(e) => {
                const next = checks.map((c, i) => (i === idx ? { ...c, value: e.target.value } : c));
                setChecks(next);
                commit(combinator, next);
              }}
            />
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={checks.length >= 10}
        onClick={() => {
          const next = [...checks, { field: "steps_taken" as const, op: "gte" as const, value: 0 }];
          setChecks(next);
          commit(combinator, next);
        }}
      >
        <Plus size={14} aria-hidden className="mr-1" /> Condição
      </Button>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── ai_classify ─────────────────────────────────────────────────────────

function ClassifyForm({
  config,
  onChange,
}: {
  config: ConfigOf<"ai_classify">;
  onChange: (c: ConfigOf<"ai_classify">) => void;
}) {
  const [classesText, setClassesText] = useState(config.classes.join(", "));
  const [graceMin, setGraceMin] = useState(msToMin(config.grace_timeout_ms));
  const [target, setTarget] = useState(config.target);
  const [hint, setHint] = useState(config.hint ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: { classesText: string; graceMin: number; target: "last_reply" | "summary"; hint: string }) => {
    const classes = next.classesText
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const candidate = {
      classes,
      grace_timeout_ms: minToMs(next.graceMin),
      target: next.target,
      ...(next.hint.trim() ? { hint: next.hint } : {}),
    };
    const parsed = aiClassifyConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="classify-classes">Classes (separadas por vírgula)</Label>
        <Input
          id="classify-classes"
          value={classesText}
          onChange={(e) => {
            setClassesText(e.target.value);
            commit({ classesText: e.target.value, graceMin, target, hint });
          }}
          placeholder="hot, cold, no_reply"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-grace">Grace (minutos, mín. 15)</Label>
        <Input
          id="classify-grace"
          type="number"
          min={15}
          value={graceMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            setGraceMin(v);
            commit({ classesText, graceMin: v, target, hint });
          }}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-target">Alvo</Label>
        <Select
          value={target}
          onValueChange={(v) => {
            const next = v as "last_reply" | "summary";
            setTarget(next);
            commit({ classesText, graceMin, target: next, hint });
          }}
        >
          <SelectTrigger id="classify-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="last_reply">Última resposta</SelectItem>
            <SelectItem value="summary">Resumo</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-hint">Instrução (opcional)</Label>
        <Textarea
          id="classify-hint"
          maxLength={500}
          value={hint}
          onChange={(e) => {
            setHint(e.target.value);
            commit({ classesText, graceMin, target, hint: e.target.value });
          }}
        />
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── action ──────────────────────────────────────────────────────────────

function ActionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"action">;
  onChange: (c: ConfigOf<"action">) => void;
}) {
  const [mode, setMode] = useState(config.mode);
  const [promptHint, setPromptHint] = useState(config.mode === "ai_message" ? config.prompt_hint : "");
  const [fallbackTemplateId, setFallbackTemplateId] = useState(
    config.mode === "ai_message" ? (config.fallback_template_id ?? "") : "",
  );
  const [templateId, setTemplateId] = useState(config.mode === "template" ? config.template_id : "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: "ai_message" | "template";
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
  }) => {
    const candidate =
      next.mode === "ai_message"
        ? {
            mode: "ai_message" as const,
            prompt_hint: next.promptHint,
            ...(next.fallbackTemplateId.trim() ? { fallback_template_id: next.fallbackTemplateId } : {}),
          }
        : { mode: "template" as const, template_id: next.templateId };
    const parsed = actionConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="action-mode">Modo</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "ai_message" | "template";
            setMode(next);
            commit({ mode: next, promptHint, fallbackTemplateId, templateId });
          }}
        >
          <SelectTrigger id="action-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ai_message">Mensagem gerada por IA</SelectItem>
            <SelectItem value="template">Template fixo</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "ai_message" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-prompt-hint">Instrução para a IA</Label>
            <Textarea
              id="action-prompt-hint"
              maxLength={1000}
              value={promptHint}
              onChange={(e) => {
                setPromptHint(e.target.value);
                commit({ mode, promptHint: e.target.value, fallbackTemplateId, templateId });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-fallback">Template de fallback (UUID, opcional)</Label>
            <Input
              id="action-fallback"
              value={fallbackTemplateId}
              onChange={(e) => {
                setFallbackTemplateId(e.target.value);
                commit({ mode, promptHint, fallbackTemplateId: e.target.value, templateId });
              }}
            />
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="action-template-id">Template (UUID)</Label>
          <Input
            id="action-template-id"
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              commit({ mode, promptHint, fallbackTemplateId, templateId: e.target.value });
            }}
          />
        </div>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── end ─────────────────────────────────────────────────────────────────

function EndForm({ config, onChange }: { config: ConfigOf<"end">; onChange: (c: ConfigOf<"end">) => void }) {
  const [outcome, setOutcome] = useState(config.outcome);
  const [note, setNote] = useState(config.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: { outcome: "converted" | "exhausted" | "custom"; note: string }) => {
    const candidate = { outcome: next.outcome, ...(next.note.trim() ? { note: next.note } : {}) };
    const parsed = endConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="end-outcome">Resultado</Label>
        <Select
          value={outcome}
          onValueChange={(v) => {
            const next = v as "converted" | "exhausted" | "custom";
            setOutcome(next);
            commit({ outcome: next, note });
          }}
        >
          <SelectTrigger id="end-outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="converted">Convertido</SelectItem>
            <SelectItem value="exhausted">Esgotado</SelectItem>
            <SelectItem value="custom">Personalizado</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="end-note">Nota (opcional)</Label>
        <Textarea
          id="end-note"
          maxLength={200}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            commit({ outcome, note: e.target.value });
          }}
        />
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

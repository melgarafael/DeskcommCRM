"use client";
/**
 * VersionDiff — diff side-by-side de duas versions (S-13.12).
 *
 * Implementação intencionalmente simples (sem `react-diff-viewer`):
 *   - Tools: pills added/removed.
 *   - Provider/model/limits: lista de mudanças key→A/B.
 *   - System prompt: diff naive linha-a-linha (LCS via dynamic programming
 *     pequeno) com marcadores `+`/`-`/` `.
 */
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

interface Props {
  versionA: AgentVersionRow; // mais antiga / base
  versionB: AgentVersionRow; // mais nova / candidata
}

type DiffLine = { kind: "ctx" | "add" | "del"; text: string };

function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const m = A.length;
  const n = B.length;
  // LCS DP — capped to keep us safe on huge prompts (rare here).
  const CAP = 600;
  if (m > CAP || n > CAP) {
    return [
      { kind: "del", text: a },
      { kind: "add", text: b },
    ];
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = n - 1; j >= 0; j--) {
      row[j] = A[i] === B[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ kind: "ctx", text: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: A[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: B[j]! });
      j++;
    }
  }
  while (i < m) out.push({ kind: "del", text: A[i++]! });
  while (j < n) out.push({ kind: "add", text: B[j++]! });
  return out;
}

function diffArr(prev: string[], next: string[]) {
  const added = next.filter((x) => !prev.includes(x));
  const removed = prev.filter((x) => !next.includes(x));
  return { added, removed };
}

interface FieldChange {
  key: string;
  label: string;
  a: unknown;
  b: unknown;
}

function buildFieldChanges(a: AgentVersionRow, b: AgentVersionRow): FieldChange[] {
  const fields: Array<[keyof AgentVersionRow, string]> = [
    ["provider", "Provider"],
    ["model", "Model"],
    ["channel_session_id", "Canal"],
    ["max_steps", "max_steps"],
    ["token_budget", "token_budget"],
    ["cost_budget_cents", "cost_budget_cents"],
    ["history_message_window", "history_message_window"],
    ["history_token_window", "history_token_window"],
    ["handoff_tool_enabled", "handoff_tool_enabled"],
  ];
  return fields
    .filter(([k]) => a[k] !== b[k])
    .map(([k, label]) => ({ key: k as string, label, a: a[k], b: b[k] }));
}

export function VersionDiff({ versionA, versionB }: Props) {
  const tools = diffArr(versionA.tool_ids ?? [], versionB.tool_ids ?? []);
  const handoffKw = diffArr(versionA.handoff_keywords ?? [], versionB.handoff_keywords ?? []);
  const followupFlows = diffArr(
    versionA.followup?.flow_pointer_ids ?? [],
    versionB.followup?.flow_pointer_ids ?? [],
  );
  const followupEnabledChanged =
    (versionA.followup?.enabled ?? false) !== (versionB.followup?.enabled ?? false);
  const fields = buildFieldChanges(versionA, versionB);
  const lines = diffLines(versionA.system_prompt ?? "", versionB.system_prompt ?? "");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant="outline">v{versionA.version_number}</Badge>
        <span className="text-muted-foreground">→</span>
        <Badge variant="outline">v{versionB.version_number}</Badge>
      </div>

      <Section title="Configuração">
        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">Sem mudanças.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1">Campo</th>
                <th className="py-1">v{versionA.version_number}</th>
                <th className="py-1">v{versionB.version_number}</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.key} className="border-t border-border/40">
                  <td className="py-1 font-mono">{f.label}</td>
                  <td className="py-1 font-mono text-destructive">{String(f.a)}</td>
                  <td className="py-1 font-mono text-emerald-600">{String(f.b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Tools">
        <Pills label="Adicionadas" tone="add" items={tools.added} />
        <Pills label="Removidas" tone="del" items={tools.removed} />
        {tools.added.length === 0 && tools.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">Sem mudanças.</p>
        ) : null}
      </Section>

      <Section title="Handoff keywords">
        <Pills label="Adicionadas" tone="add" items={handoffKw.added} />
        <Pills label="Removidas" tone="del" items={handoffKw.removed} />
        {handoffKw.added.length === 0 && handoffKw.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">Sem mudanças.</p>
        ) : null}
      </Section>

      <Section title="Follow-up">
        {followupEnabledChanged ? (
          <p className="text-xs">
            Habilitado:{" "}
            <span className="font-mono text-destructive">
              {String(versionA.followup?.enabled ?? false)}
            </span>{" "}
            →{" "}
            <span className="font-mono text-emerald-600">
              {String(versionB.followup?.enabled ?? false)}
            </span>
          </p>
        ) : null}
        <Pills label="Fluxos adicionados" tone="add" items={followupFlows.added} />
        <Pills label="Fluxos removidos" tone="del" items={followupFlows.removed} />
        {!followupEnabledChanged &&
        followupFlows.added.length === 0 &&
        followupFlows.removed.length === 0 ? (
          <p className="text-xs text-muted-foreground">Sem mudanças.</p>
        ) : null}
      </Section>

      <Section title="System prompt">
        <pre className="max-h-96 overflow-auto rounded-md border border-border/60 bg-muted/30 p-2 font-mono text-xs leading-relaxed">
          {lines.map((l, idx) => {
            const cls =
              l.kind === "add"
                ? "block bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : l.kind === "del"
                  ? "block bg-destructive/10 text-destructive"
                  : "block";
            const prefix = l.kind === "add" ? "+ " : l.kind === "del" ? "- " : "  ";
            return (
              <span key={idx} className={cls}>
                {prefix}
                {l.text || " "}
              </span>
            );
          })}
        </pre>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Pills({
  label,
  tone,
  items,
}: {
  label: string;
  tone: "add" | "del";
  items: string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {items.map((id) => (
        <Badge
          key={id}
          variant="outline"
          className={
            tone === "add"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          }
        >
          {tone === "add" ? "+ " : "− "}
          {id}
        </Badge>
      ))}
    </div>
  );
}

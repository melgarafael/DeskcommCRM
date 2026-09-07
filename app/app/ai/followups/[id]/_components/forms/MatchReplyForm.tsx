"use client";

import { useT } from "@/hooks/i18n/useT";

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
import { matchReplyConfigSchema, type IfExists, type MatchReplyBranch, type ReplySaveTo } from "@/lib/followup/graph-schema";
import { ESPERA_PELA_RESPOSTA, SE_INFORMACAO_JA_EXISTIR } from "@/lib/followup/vocabulario";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { Plus, Trash } from "@/lib/ui/icons";
import { usePipelines } from "@/hooks/webhooks/useWebhookSources";

import { msToMin, minToMs, type ConfigOf } from "./shared";

function novoId(usados: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidato = `br_${n}`;
    if (!usados.has(candidato)) return candidato;
  }
}

export function MatchReplyForm({
  config,
  onChange,
}: {
  config: ConfigOf<"match_reply">;
  onChange: (c: ConfigOf<"match_reply">) => void;
}) {
  const t = useT();
  const [branches, setBranches] = useState(config.branches);
  const [graceMin, setGraceMin] = useState(msToMin(config.grace_timeout_ms));
  const [saveTo, setSaveTo] = useState<ReplySaveTo | undefined>(config.save_to);
  const [ifExists, setIfExists] = useState<IfExists>(config.if_exists ?? "overwrite");
  const [error, setError] = useState<string | null>(null);
  const pipelines = usePipelines();
  const campos = (pipelines.data?.data ?? []).flatMap((p) => camposDoFunil(p.settings));
  const camposUnicos = [...new Map(campos.map((c) => [c.key, c])).values()];

  const commit = (next: {
    branches: MatchReplyBranch[];
    graceMin: number;
    saveTo?: ReplySaveTo;
    ifExists: IfExists;
  }) => {
    const candidate = {
      branches: next.branches,
      grace_timeout_ms: minToMs(next.graceMin),
      ...(next.saveTo ? { save_to: next.saveTo, if_exists: next.ifExists } : {}),
    };
    const parsed = matchReplyConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const atualizar = (index: number, patch: Partial<MatchReplyBranch>) => {
    const next = branches.map((b, i) => (i === index ? { ...b, ...patch } : b));
    setBranches(next);
    commit({ branches: next, graceMin, saveTo, ifExists });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>{t("Regras de texto")}</Label>
        {branches.map((branch, index) => (
          <div key={branch.id} className="space-y-2 rounded-md border border-border p-2">
            <Input
              aria-label={`Rótulo da regra ${index + 1}`}
              value={branch.label}
              onChange={(e) => atualizar(index, { label: e.target.value })}
              placeholder={t("Rótulo")}
            />
            <div className="flex gap-2">
              <Select
                value={branch.op}
                onValueChange={(v) => atualizar(index, { op: v as MatchReplyBranch["op"] })}
              >
                <SelectTrigger aria-label={`Comparação da regra ${index + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">{t("Contém")}</SelectItem>
                  <SelectItem value="eq">{t("É igual a")}</SelectItem>
                </SelectContent>
              </Select>
              <Input
                aria-label={`Texto da regra ${index + 1}`}
                value={branch.pattern}
                onChange={(e) => atualizar(index, { pattern: e.target.value })}
                placeholder="texto a casar"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remover regra ${index + 1}`}
                disabled={branches.length <= 1}
                onClick={() => {
                  const next = branches.filter((_, i) => i !== index);
                  setBranches(next);
                  commit({ branches: next, graceMin, saveTo, ifExists });
                }}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
          </div>
        ))}
        {branches.length < 8 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const usados = new Set(branches.map((b) => b.id));
              const next = [
                ...branches,
                { id: novoId(usados), label: "Nova regra", op: "contains" as const, pattern: "ok" },
              ];
              setBranches(next);
              commit({ branches: next, graceMin, saveTo, ifExists });
            }}
          >
            <Plus size={14} aria-hidden className="mr-1" /> Adicionar regra
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="match-reply-grace">{ESPERA_PELA_RESPOSTA.rotulo}</Label>
        <Input
          id="match-reply-grace"
          type="number"
          min={ESPERA_PELA_RESPOSTA.minimoMinutos}
          value={graceMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            setGraceMin(v);
            commit({ branches, graceMin: v, saveTo, ifExists });
          }}
        />
        <p className="text-xs text-text-muted">{ESPERA_PELA_RESPOSTA.ajuda}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="match-reply-save">{t("Gravar a resposta em")}</Label>
        <Select
          value={
            saveTo?.kind === "contact_name"
              ? "__contact_name__"
              : saveTo?.kind === "lead_custom"
                ? camposUnicos.some((c) => c.key === saveTo.key)
                  ? saveTo.key
                  : "__livre__"
                : "__none__"
          }
          onValueChange={(v) => {
            let next: ReplySaveTo | undefined;
            if (v === "__none__") next = undefined;
            else if (v === "__contact_name__") next = { kind: "contact_name" };
            else if (v === "__livre__") next = { kind: "lead_custom", key: "campo_{{volta}}" };
            else next = { kind: "lead_custom", key: v };
            setSaveTo(next);
            commit({ branches, graceMin, saveTo: next, ifExists });
          }}
        >
          <SelectTrigger id="match-reply-save">
            <SelectValue placeholder={t("Não gravar")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("Não gravar")}</SelectItem>
            <SelectItem value="__contact_name__">{t("Nome do contato")}</SelectItem>
            {camposUnicos.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {c.label} ({c.key})
              </SelectItem>
            ))}
            <SelectItem value="__livre__">{t("Chave livre (use")} {t("{{volta}}")} {t("no laço)")}</SelectItem>
          </SelectContent>
        </Select>
        {saveTo?.kind === "lead_custom" && !camposUnicos.some((c) => c.key === saveTo.key) && (
          <Input
            aria-label={t("Chave do campo personalizado")}
            value={saveTo.key}
            onChange={(e) => {
              const next: ReplySaveTo = { kind: "lead_custom", key: e.target.value };
              setSaveTo(next);
              commit({ branches, graceMin, saveTo: next, ifExists });
            }}
          />
        )}
        {saveTo && (
          <div className="space-y-2">
            <Label htmlFor="match-reply-if-exists">{SE_INFORMACAO_JA_EXISTIR.rotulo}</Label>
            <Select
              value={ifExists}
              onValueChange={(v) => {
                const next = v as IfExists;
                setIfExists(next);
                commit({ branches, graceMin, saveTo, ifExists: next });
              }}
            >
              <SelectTrigger id="match-reply-if-exists">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">{SE_INFORMACAO_JA_EXISTIR.skip}</SelectItem>
                <SelectItem value="overwrite">{SE_INFORMACAO_JA_EXISTIR.overwrite}</SelectItem>
                <SelectItem value="confirm">{SE_INFORMACAO_JA_EXISTIR.confirm}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">{SE_INFORMACAO_JA_EXISTIR.ajuda}</p>
          </div>
        )}
        <p className="text-xs text-text-muted">
          {t("Crie os campos em Configurações → Funis. A resposta só grava quando o contato responde (não no timeout).")}
        </p>
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

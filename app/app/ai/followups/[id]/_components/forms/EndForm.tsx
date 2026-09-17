"use client";

import { useState } from "react";

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
import { useFollowupFlows } from "@/hooks/followup/useFollowupFlows";
import { endConfigSchema } from "@/lib/followup/graph-schema";
import { RESULTADOS_DO_FIM, opcoes, type ResultadoDoFim } from "@/lib/followup/vocabulario";
import { useT } from "@/hooks/i18n/useT";

import type { ConfigOf } from "./shared";

type TipoDeFinalizacao = "nada" | "ia" | "skill" | "proximo_fluxo";

/**
 * Rótulos LOCAIS de propósito: `ao_finalizar` é união de literais (discriminante
 * estrutural), não um enum de wire — o invariante de vocabulário não o cobra, e
 * três palavras usadas só aqui não justificam engordar o dicionário.
 */
const ACOES_AO_FINALIZAR: ReadonlyArray<{ valor: TipoDeFinalizacao; rotulo: string }> = [
  { valor: "nada", rotulo: "Nada (só encerra)" },
  { valor: "ia", rotulo: "Devolver à IA" },
  { valor: "skill", rotulo: "Chamar uma skill" },
  { valor: "proximo_fluxo", rotulo: "Iniciar outro fluxo de atendimento" },
];

export function EndForm({
  config,
  onChange,
}: {
  config: ConfigOf<"end">;
  onChange: (c: ConfigOf<"end">) => void;
}) {
  const t = useT();
  const [outcome, setOutcome] = useState(config.outcome);
  const [note, setNote] = useState(config.note ?? "");
  const [finishTipo, setFinishTipo] = useState<TipoDeFinalizacao>(config.ao_finalizar?.tipo ?? "nada");
  const [finishPrompt, setFinishPrompt] = useState(
    config.ao_finalizar?.tipo === "ia" ? (config.ao_finalizar.prompt ?? "") : "",
  );
  const [finishSkill, setFinishSkill] = useState(
    config.ao_finalizar?.tipo === "skill" ? config.ao_finalizar.skill_name : "",
  );
  const [finishFluxo, setFinishFluxo] = useState(
    config.ao_finalizar?.tipo === "proximo_fluxo" ? config.ao_finalizar.fluxo : "",
  );
  const [error, setError] = useState<string | null>(null);
  // Fluxos de atendimento elegíveis para encadear. `react-query` cacheia pela
  // chave da superfície, então abrir vários nós Fim não refaz a busca.
  const fluxos = useFollowupFlows({ surface: "atendimento" });

  const commit = (next: {
    outcome: ResultadoDoFim;
    note: string;
    finishTipo: TipoDeFinalizacao;
    finishPrompt: string;
    finishSkill: string;
    finishFluxo: string;
  }) => {
    const aoFinalizar =
      next.finishTipo === "nada"
        ? undefined
        : next.finishTipo === "ia"
          ? { tipo: "ia" as const, ...(next.finishPrompt.trim() ? { prompt: next.finishPrompt } : {}) }
          : next.finishTipo === "proximo_fluxo"
            ? { tipo: "proximo_fluxo" as const, fluxo: next.finishFluxo }
            : { tipo: "skill" as const, skill_name: next.finishSkill };
    const candidate = {
      outcome: next.outcome,
      ...(next.note.trim() ? { note: next.note } : {}),
      ...(aoFinalizar ? { ao_finalizar: aoFinalizar } : {}),
    };
    const parsed = endConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const state = { outcome, note, finishTipo, finishPrompt, finishSkill, finishFluxo };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="end-outcome">{t("Resultado")}</Label>
        <Select
          value={outcome}
          onValueChange={(v) => {
            const next = v as ResultadoDoFim;
            setOutcome(next);
            commit({ ...state, outcome: next });
          }}
        >
          <SelectTrigger id="end-outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(RESULTADOS_DO_FIM).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="end-note">{t("Nota (opcional)")}</Label>
        <Textarea
          id="end-note"
          maxLength={200}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            commit({ ...state, note: e.target.value });
          }}
        />
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <Label htmlFor="end-finish">{t("Ao concluir, o que fazer")}</Label>
        <Select
          value={finishTipo}
          onValueChange={(v) => {
            const next = v as TipoDeFinalizacao;
            setFinishTipo(next);
            commit({ ...state, finishTipo: next });
          }}
        >
          <SelectTrigger id="end-finish">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACOES_AO_FINALIZAR.map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {t(rotulo)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-text-muted">
          {t("Vale para o fluxo de atendimento: o que acontece quando o cliente completa as perguntas.")}
        </p>

        {finishTipo === "ia" && (
          <div className="space-y-2">
            <Label htmlFor="end-finish-prompt">{t("Orientação para a IA (opcional)")}</Label>
            <Textarea
              id="end-finish-prompt"
              maxLength={1000}
              value={finishPrompt}
              onChange={(e) => {
                setFinishPrompt(e.target.value);
                commit({ ...state, finishPrompt: e.target.value });
              }}
            />
          </div>
        )}

        {finishTipo === "skill" && (
          <div className="space-y-2">
            <Label htmlFor="end-finish-skill">{t("Nome da skill")}</Label>
            <Input
              id="end-finish-skill"
              maxLength={80}
              value={finishSkill}
              onChange={(e) => {
                setFinishSkill(e.target.value);
                commit({ ...state, finishSkill: e.target.value });
              }}
            />
            <p className="text-xs text-text-muted">
              {t("Ex.: fechamento-pagamento, catalogo-apresentacao.")}
            </p>
          </div>
        )}

        {finishTipo === "proximo_fluxo" && (
          <div className="space-y-2">
            <Label htmlFor="end-finish-fluxo">{t("Próximo fluxo")}</Label>
            <Select
              value={finishFluxo || "__none__"}
              onValueChange={(v) => {
                const next = v === "__none__" ? "" : v;
                setFinishFluxo(next);
                commit({ ...state, finishFluxo: next });
              }}
            >
              <SelectTrigger id="end-finish-fluxo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("Escolha um fluxo")}</SelectItem>
                {(fluxos.data ?? [])
                  .filter((f) => f.status === "active")
                  .map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              {t(
                "Quando este fluxo terminar, o próximo começa sozinho — o que o cliente já respondeu segue valendo.",
              )}
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

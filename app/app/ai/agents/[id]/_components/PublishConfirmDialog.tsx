"use client";
import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/hooks/i18n/useT";

import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AgentVersionRow;
  published: AgentVersionRow | null;
  onConfirm: () => void;
  isPending: boolean;
}

function diffArr(prev: string[], next: string[]) {
  const added = next.filter((x) => !prev.includes(x));
  const removed = prev.filter((x) => !next.includes(x));
  return { added, removed };
}

/**
 * `openai` → "OpenAI (GPT)".
 *
 * A caixa mostrava o id cru (`Provider: openai`) — inglês de manual, e um nome
 * que o dono da clínica não reconhece. O rótulo é o MESMO da lista que ele já
 * viu na tela de Credenciais; quem não estiver nessa lista (id semeado por
 * migration antiga, provedor renomeado) cai no próprio id, que é melhor do que
 * sumir com a informação.
 */
function rotuloDoProvedor(id: string): string {
  return PROVEDORES.find((p) => p.id === id)?.rotulo ?? id;
}

export function PublishConfirmDialog({
  open,
  onOpenChange,
  draft,
  published,
  onConfirm,
  isPending,
}: Props) {
  const t = useT();
  const toolsDiff = diffArr(published?.tool_ids ?? [], draft.tool_ids);
  const promptDeltaChars =
    draft.system_prompt.length - (published?.system_prompt.length ?? 0);
  const modelChanged = !published || draft.model !== published.model;
  const providerChanged = !published || draft.provider !== published.provider;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("Publicar v")}
            {draft.version_number}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {published ? (
              <>
                {t("Esta versão se tornará a ativa no atendimento. A versão atual (")}
                {`v${published.version_number}`}
                {t(") continua guardada no histórico, mas deixa de atender.")}
              </>
            ) : (
              t("Esta versão se tornará a ativa no atendimento. É a primeira publicação deste agente.")
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2 rounded-md border border-border/60 p-3 text-xs">
          {providerChanged ? (
            <p>
              <strong>{t("Empresa:")}</strong>{" "}
              {published
                ? `${rotuloDoProvedor(published.provider)} → ${rotuloDoProvedor(draft.provider)}`
                : rotuloDoProvedor(draft.provider)}
            </p>
          ) : null}
          {modelChanged ? (
            <p>
              <strong>{t("Modelo:")}</strong>{" "}
              {published ? `${published.model} → ${draft.model}` : draft.model}
            </p>
          ) : null}
          {toolsDiff.added.length > 0 ? (
            <p>
              <strong>{t("Tools adicionadas:")}</strong> {toolsDiff.added.join(", ")}
            </p>
          ) : null}
          {toolsDiff.removed.length > 0 ? (
            <p>
              <strong>{t("Tools removidas:")}</strong> {toolsDiff.removed.join(", ")}
            </p>
          ) : null}
          <p>
            <strong>{t("Prompt:")}</strong>{" "}
            {promptDeltaChars > 0
              ? `${promptDeltaChars} ${t("caracteres a mais")}`
              : promptDeltaChars < 0
                ? `${Math.abs(promptDeltaChars)} ${t("caracteres a menos")}`
                : t("sem alteração")}
          </p>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t("Cancelar")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isPending}>
            {isPending ? t("Publicando…") : `${t("Publicar v")}${draft.version_number}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

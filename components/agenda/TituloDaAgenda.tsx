"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

export function TituloDaAgenda({ tituloInicial, podeEditar }: { tituloInicial: string | null; podeEditar: boolean }) {
  const t = useT(); const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const id = React.useId();
  return <form className="space-y-2 rounded-md border border-border p-3" onSubmit={(e) => { e.preventDefault(); const title = String(new FormData(e.currentTarget).get("title") ?? ""); setBusy(true); setMessage(""); void apiClient.patch("/api/v1/settings/agenda-apresentacao", { title }).then(() => { router.refresh(); setMessage(t("Título da agenda salvo.")); }).catch(showApiError).finally(() => setBusy(false)); }}>
    <label htmlFor={id} className="block font-medium">{t("Título da área da agenda")}</label>
    <input key={tituloInicial ?? "default"} id={id} name="title" defaultValue={tituloInicial ?? ""} maxLength={80} placeholder={t("Agendamentos")} disabled={!podeEditar || busy} className="w-full rounded-md border border-border bg-surface-elevated p-2 text-sm"/>
    <p className="text-sm text-text-muted">{t("Opcional. Deixe vazio para usar Agendamentos. Os serviços mantêm seus próprios nomes.")}</p>
    {podeEditar && <Button type="submit" disabled={busy}>{busy ? t("Salvando…") : t("Salvar título")}</Button>}
    {message && <p role="status">{message}</p>}
  </form>;
}

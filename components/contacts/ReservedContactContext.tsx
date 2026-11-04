"use client";
import { useState } from "react";
import { apiClient } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
type Row = { id: string; payload: Record<string, unknown>; captured_at: string };
export function ReservedContactContext({ contactId }: { contactId: string }) {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError(false);
    try {
      const r = await apiClient.get<{ data: Row[] }>(
        `/api/v1/contacts/${contactId}/reserved-context`,
      );
      setRows(r.data);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-4 rounded border p-4">
      <h2>{t("Histórico reservado do cadastro")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Dados preservados sem vínculo comprovado com uma negociação. Visível somente à gestão; não é contexto automático da IA.",
        )}
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void load()}>
        {t("Consultar histórico reservado")}
      </Button>
      {error && <p role="alert">{t("Não foi possível carregar o histórico.")}</p>}
      {rows?.length === 0 && <p>{t("Nenhum dado reservado.")}</p>}
      {rows?.map((r) => (
        <details key={r.id}>
          <summary>{new Date(r.captured_at).toLocaleString()}</summary>
          <pre className="text-sm break-words whitespace-pre-wrap">
            {JSON.stringify(r.payload, null, 2)}
          </pre>
        </details>
      ))}
    </section>
  );
}

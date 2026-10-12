"use client";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { apiClient } from "@/lib/api/client";
import { instanteDe } from "@/lib/agenda/fuso";
import type { AgendamentoListado } from "@/lib/agenda/consulta";
import { DetalheDoCompromisso } from "./DetalheDoCompromisso";

const PUBLICATION: Record<string, string> = { not_configured: "Somente no CRM", pending: "Publicação pendente", synced: "Publicado no Google", failed: "Falha de publicação", conflict: "Conflito com o Google", removed: "Remoção confirmada no Google" };
const field = "rounded-md border border-border bg-surface-elevated p-2 text-sm";
function instanteCivil(value: string, zone: string) {
  const [date = "", time = "00:00"] = value.split("T"); const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = date.split("-").map(Number); const [hour = 0, minute = 0] = time.split(":").map(Number);
  return instanteDe({ ano: year, mes: month, dia: day, hora: hour, minuto: minute }, zone);
}

/** Cada pessoa mantém sua reserva; a turma é agrupada pela ocorrência persistida. */
export function ReservasColetivas({ today, zone, canWrite }: { today: string; zone: string; canWrite: boolean }) {
  const t = useT(); const locale = useTagDeIdioma(); const qc = useQueryClient(); const { activeOrg } = useAuth();
  const [day, setDay] = React.useState(today); const [opened, setOpened] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null); const [busy, setBusy] = React.useState(false);
  const [detailId, setDetailId] = React.useState<string | null>(null);
  const de = instanteCivil(day, zone).toISOString(), ate = new Date(instanteCivil(day, zone).getTime() + 7 * 86400000).toISOString();
  const query = useQuery({ queryKey: ["agenda", "coletivas", activeOrg?.orgId, de, ate], enabled: opened && !!activeOrg,
    queryFn: async () => (await apiClient.get<{ data: AgendamentoListado[] }>(`/api/v1/agenda/agendamentos?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}&limite=500&collective_only=true`)).data });
  const groups = new Map<string, AgendamentoListado[]>();
  for (const row of query.data ?? []) if (row.servico && row.servico.booking_mode !== "individual") {
    const members = groups.get(row.servico.occurrence_id) ?? []; members.push(row); groups.set(row.servico.occurrence_id, members);
  }
  async function execute(action: () => Promise<unknown>) { setBusy(true); try { await action(); setEditing(null); await query.refetch(); void qc.invalidateQueries({ queryKey: ["agenda"] }); } catch (e) { showApiError(e); } finally { setBusy(false); } }
  return <details className="shrink-0 rounded-md border border-border p-3" open={opened} onToggle={(e) => setOpened(e.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">{t("Turmas e reservas coletivas")}</summary>
    {opened && <div className="max-h-80 space-y-3 overflow-y-auto pt-3"><label className="block space-y-1">{t("Semana a partir de")} <input className={field} type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)}/></label>
      <p className="text-xs text-text-muted">{t("Cada pessoa tem sua reserva. Remarcar ou cancelar aqui afeta somente a pessoa escolhida.")}</p>
      {query.isError && <div role="alert"><p>{t("Não foi possível ler as reservas coletivas.")}</p><Button variant="outline" onClick={() => void query.refetch()}>{t("Tentar novamente")}</Button></div>}
      {query.isLoading && <p>{t("Carregando…")}</p>}
      {(query.data?.length ?? 0) >= 500 && <p role="status">{t("A consulta atingiu 500 reservas. Os totais abaixo incluem somente esta consulta.")}</p>}
      {query.isSuccess && groups.size === 0 && <p>{t("Nenhuma reserva coletiva neste período.")}</p>}
      {[...groups.entries()].map(([id, rows]) => { const first = rows[0]; if (!first) return null; return <section className="space-y-2 rounded-md border p-3" key={id}>
        <h3 className="font-medium">{first.tipo?.nome ?? first.titulo} · {new Date(first.iniciaEm).toLocaleString(locale, { timeZone: first.fuso })}</h3>
        <p className="text-sm">{rows.filter((r) => r.situacao === "pending" || r.situacao === "confirmed").length} {t("pessoas nesta consulta")} · {t("Regra guardada na reserva:")} {first.servico!.capacity_limit == null ? t("Sem limite automático") : first.servico!.capacity_limit}</p>
        <ul>{rows.map((r) => <li className="space-y-2 border-t py-2" key={r.id}>
          <div className="flex flex-wrap items-center justify-between gap-2"><span>{r.servico!.participant_name ?? r.contatoNome} · {t(r.situacao === "pending" ? "Reservado, aguardando confirmação" : r.situacao === "confirmed" ? "Confirmada" : "Encerrada")} · {t(PUBLICATION[r.servico!.google_publication] ?? "Publicação pendente")}</span>
            <Button variant="outline" size="sm" onClick={() => setDetailId(r.id)}>{t("Ver reserva e publicação")}</Button>
            {canWrite && <Button variant="outline" size="sm" onClick={() => setEditing(editing === r.id ? null : r.id)}>{t("Gerenciar esta reserva")}</Button>}</div>
          {editing === r.id && canWrite && <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const values = new FormData(e.currentTarget); void execute(() => apiClient.patch("/api/v1/agenda/agendamentos", { id: r.id, revision: r.revision, starts_at: instanteCivil(String(values.get("starts_at")), r.fuso).toISOString() })); }}>
            <label className="block space-y-1">{t("Novo horário")}<input className={field} name="starts_at" required type="datetime-local"/></label><span className="text-xs">{r.fuso}</span><Button type="submit" disabled={busy}>{t("Remarcar esta pessoa")}</Button>
            {r.situacao === "pending" && <Button type="button" variant="outline" disabled={busy} onClick={() => void execute(() => apiClient.patch("/api/v1/agenda/agendamentos", { id: r.id, revision: r.revision, status: "confirmed" }))}>{t("Confirmar pela equipe")}</Button>}
            <label className="block space-y-1">{t("Motivo do cancelamento")}<input className={field} name="reason" minLength={3}/></label><Button type="button" variant="outline" disabled={busy} onClick={(e) => { const form = e.currentTarget.closest("form"); const reason = String(new FormData(form!).get("reason") ?? "").trim(); if (reason.length < 3) { showApiError(new Error(t("Informe o motivo do cancelamento."))); return; } void execute(() => apiClient.delete("/api/v1/agenda/agendamentos", { id: r.id, revision: r.revision, reason })); }}>{t("Cancelar esta pessoa")}</Button>
          </form>}
        </li>)}</ul>
      </section>; })}
    </div>}
    <DetalheDoCompromisso id={detailId} podeEditar={canWrite} onClose={() => { setDetailId(null); void query.refetch(); }}/>
  </details>;
}

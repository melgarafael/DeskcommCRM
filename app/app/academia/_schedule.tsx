"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { randomId } from "@/lib/random-id";
import { catalogKinds, type CatalogKind, type CatalogRecord } from "@/lib/academia/catalogs";
import { weekdays, formatClassEnd, type ScheduleRecord } from "@/lib/academia/schedule";

type Catalogs = Record<CatalogKind, CatalogRecord[]>;
const links = [
  { kind: "modalities", field: "modality_id", label: "Modalidade" },
  { kind: "audiences", field: "audience_id", label: "Público" },
  { kind: "teachers", field: "teacher_id", label: "Professor" },
  { kind: "spaces", field: "space_id", label: "Ambiente" },
] as const;
const selectClass = "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";

async function allPages<T>(url: string, signal: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const response = await fetch(url + (cursor ? `?cursor=${cursor}` : ""), { cache: "no-store", signal });
    if (!response.ok) throw new Error("load_failed");
    const page: { data: T[]; meta: { cursor: string | null; has_more: boolean } } = await response.json();
    rows.push(...page.data);
    cursor = page.meta.has_more ? page.meta.cursor : null;
  } while (cursor);
  return rows;
}

export function AcademiaSchedule({ canEdit }: { canEdit: boolean }) {
  const t = useT();
  const locale = useTagDeIdioma();
  const [data, setData] = useState<{ rows: ScheduleRecord[]; catalogs: Catalogs } | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [day, setDay] = useState(0);
  const [showInactive, setShowInactive] = useState(false);
  const [editor, setEditor] = useState<{ key: string; row?: ScheduleRecord } | null>(null);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [rows, ...catalogs] = await Promise.all([
          allPages<ScheduleRecord>("/api/v1/academia/schedule", controller.signal),
          ...catalogKinds.map(kind => allPages<CatalogRecord>(`/api/v1/academia/catalogs/${kind}`, controller.signal)),
        ]);
        if (!controller.signal.aborted) {
          setData({ rows, catalogs: Object.fromEntries(catalogKinds.map((kind, i) => [kind, catalogs[i]])) as Catalogs });
          setError(false);
        }
      } catch { if (!controller.signal.aborted) setError(true); }
    })();
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);
  const missing = data ? links.filter(link => !data.catalogs[link.kind].some(row => row.active)) : [];
  const rows = (data?.rows ?? []).filter(row => (showInactive || row.active) && (!day || row.weekday === day))
    .sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time) || a.id.localeCompare(b.id));
  return <section aria-label={t("Grade semanal")} className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">{t("Grade semanal")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Organize as aulas por dia. Aulas no mesmo horário são permitidas.")}</p></div>
      {canEdit && <Button disabled={!data || error || missing.length > 0} onClick={() => setEditor({ key: randomId() })}>{t("Nova aula")}</Button>}
    </div>
    <p className="rounded-lg bg-muted p-3 text-sm">{t("Esta é a grade semanal de referência. Cancelamentos por data, feriados e consultas pela IA serão tratados nas próximas etapas.")}</p>
    {!canEdit && <p className="text-sm text-muted-foreground">{t("Administradores e gestores podem editar a grade.")}</p>}
    {missing.length > 0 && <p role="status" className="rounded-lg border p-4">{t("Antes de criar aulas, adicione cadastros ativos em Cadastros")}: {missing.map(link => t(link.label)).join(", ")}.</p>}
    {error && <div role="alert" className="rounded-lg border p-4"><p>{t("Não foi possível atualizar a grade. Os dados exibidos podem estar desatualizados.")}</p><Button className="mt-3" variant="outline" onClick={reload}>{t("Tentar novamente")}</Button></div>}
    {!data && !error && <p role="status">{t("Carregando grade…")}</p>}
    <div className="flex flex-wrap items-center gap-4">
      <div className="space-y-2"><Label htmlFor="schedule-filter">{t("Dia da semana")}</Label><select id="schedule-filter" className={selectClass} value={day} onChange={e => setDay(Number(e.target.value))}><option value={0}>{t("Todos os dias")}</option>{weekdays.map(d => <option key={d.value} value={d.value}>{t(d.label)}</option>)}</select></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />{t("Mostrar aulas inativas")}</label>
      <Button variant="outline" onClick={reload}>{t("Atualizar grade")}</Button>
    </div>
    {data && !error && rows.length === 0 && <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">{t("Nenhuma aula para exibir. Cadastre uma aula ou ajuste os filtros.")}</p>}
    {weekdays.filter(d => rows.some(row => row.weekday === d.value)).map(d => <div key={d.value} className="space-y-3">
      <h3 className="font-semibold">{t(d.label)}</h3>
      <div className="grid gap-3 md:grid-cols-2">{rows.filter(row => row.weekday === d.value).map(row => {
        const name = data?.catalogs.modalities.find(item => item.id === row.modality_id)?.name ?? t("Modalidade indisponível");
        return <article key={row.id} className="min-w-0 rounded-xl border bg-card p-5">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-mono text-sm">{row.start_time} – {formatClassEnd(row.start_time, row.duration_minutes, t("+1 dia"))}</p><h4 className="mt-2 break-words font-semibold">{name}</h4></div><span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs">{t(row.active ? "Ativa" : "Inativa")}</span></div>
          <dl className="mt-3 space-y-1 text-sm">{links.slice(1).map(link => {
            const record = data?.catalogs[link.kind].find(item => item.id === row[link.field]);
            return <div key={link.field} className="break-words"><dt className="inline text-muted-foreground">{t(link.label)}: </dt><dd className="inline">{record?.name ?? t("Indisponível")}{record && !record.active && ` (${t("Cadastro inativo")})`}{link.kind === "audiences" && record?.age_pending && ` · ${t("Faixa etária provisória")}`}</dd></div>;
          })}</dl>
          {data?.catalogs.modalities.find(item => item.id === row.modality_id)?.active === false && <p className="mt-2 text-sm text-muted-foreground">{t("Modalidade inativa. Revise os vínculos desta aula.")}</p>}
          {row.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{row.notes}</p>}
          <p className="mt-3 text-xs text-muted-foreground">{t("Última alteração")}: {new Date(row.updated_at).toLocaleString(locale)}</p>
          {canEdit && <Button className="mt-4" variant="outline" disabled={error} aria-label={`${t("Editar aula")}: ${name}, ${t(d.label)}, ${row.start_time}`} onClick={() => setEditor({ key: row.id, row })}>{t("Editar aula")}</Button>}
        </article>;
      })}</div>
    </div>)}
    {editor && data && <ScheduleEditor key={editor.key} row={editor.row} creationKey={editor.key} catalogs={data.catalogs} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); reload(); }} />}
  </section>;
}

function ScheduleEditor({ row, creationKey, catalogs, onClose, onSaved }: { row?: ScheduleRecord; creationKey: string; catalogs: Catalogs; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      ...Object.fromEntries(links.map(link => [link.field, form.get(link.field)])),
      weekday: Number(form.get("weekday")), start_time: form.get("start_time"),
      duration_minutes: Number(form.get("duration_minutes")), notes: form.get("notes"), active: form.get("active") === "on",
    };
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/v1/academia/schedule", { method: row ? "PATCH" : "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": creationKey }, body: JSON.stringify({ values, ...(row ? { id: row.id, revision: row.revision } : {}) }) });
      const result = await response.json();
      if (!response.ok) { setError(t(result.error?.message ?? "Não foi possível salvar a aula.")); return; }
      toast.success(t("Aula salva.")); onSaved();
    } catch { setError(t("Não foi possível confirmar a gravação. Tente salvar novamente para conferir, sem duplicar a aula.")); }
    finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{t(row ? "Editar aula" : "Nova aula")}</DialogTitle><DialogDescription>{t("Defina os vínculos e o horário semanal. Professor e ambiente são informações separadas.")}</DialogDescription></DialogHeader>
    <form className="space-y-5" onSubmit={event => void save(event)}>
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">{links.map(link => <div key={link.field} className="min-w-0 space-y-2"><Label htmlFor={`schedule-${link.field}`}>{t(link.label)}</Label><select required id={`schedule-${link.field}`} name={link.field} defaultValue={row?.[link.field] ?? ""} className={selectClass}><option value="" disabled>{t("Selecione")}</option>{catalogs[link.kind].filter(item => item.active || item.id === row?.[link.field]).map(item => <option key={item.id} value={item.id}>{item.name}{!item.active ? ` (${t("Inativo")})` : ""}</option>)}</select></div>)}</div>
        <div className="space-y-2"><Label htmlFor="schedule-day">{t("Dia da semana")}</Label><select id="schedule-day" name="weekday" required defaultValue={row?.weekday ?? ""} className={selectClass}><option value="" disabled>{t("Selecione")}</option>{weekdays.map(d => <option key={d.value} value={d.value}>{t(d.label)}</option>)}</select></div>
        <div className="grid grid-cols-2 gap-4"><div className="min-w-0 space-y-2"><Label htmlFor="schedule-start">{t("Início")}</Label><Input id="schedule-start" name="start_time" type="time" required step={60} defaultValue={row?.start_time ?? ""} /></div><div className="min-w-0 space-y-2"><Label htmlFor="schedule-duration">{t("Duração (minutos)")}</Label><Input id="schedule-duration" name="duration_minutes" type="number" required min={1} max={1440} step={1} defaultValue={row?.duration_minutes ?? ""} /></div></div>
        <div className="space-y-2"><Label htmlFor="schedule-notes">{t("Observações")}</Label><Textarea id="schedule-notes" name="notes" maxLength={2000} defaultValue={row?.notes ?? ""} /></div>
        <label className="flex items-center gap-2 text-sm"><input name="active" type="checkbox" defaultChecked={row?.active ?? true} />{t("Aula ativa")}</label>
        <p className="text-sm text-muted-foreground">{t("Desativar retira a aula da grade ativa e preserva o registro. A edição altera a referência semanal inteira.")}</p>
      </fieldset>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancelar")}</Button><Button type="submit" disabled={saving}>{t(saving ? "Salvando…" : "Salvar aula")}</Button></div>
    </form>
  </DialogContent></Dialog>;
}

"use client";
import { randomId } from "@/lib/random-id";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { catalogKinds, catalogLabels, type CatalogKind, type CatalogRecord } from "@/lib/academia/catalogs";
type Page = { data: CatalogRecord[]; meta: { has_more: boolean; cursor: string | null } };
function useCatalogPages(kind: CatalogKind) {
 const [data, setData] = useState<Page[]>([]);
 const [error, setError] = useState(false);
 const [busy, setBusy] = useState(true);
 const [cursor, setCursor] = useState<string | null>(null);
 const [revision, setRevision] = useState(0);
 const mutate = useCallback(() => { setCursor(null); setRevision(n => n + 1); }, []);
 useEffect(() => {
  const controller = new AbortController();
  setBusy(true); setError(false);
  void (async () => {
   try {
    const response = await fetch(`/api/v1/academia/catalogs/${kind}` + (cursor ? `?cursor=${cursor}` : ""), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("load_failed");
    const page: Page = await response.json();
    if (!controller.signal.aborted) setData(pages => cursor ? [...pages, page] : [page]);
   } catch { if (!controller.signal.aborted) setError(true); }
   finally { if (!controller.signal.aborted) setBusy(false); }
  })();
  return () => controller.abort();
 }, [kind, cursor, revision]);
 useEffect(() => { window.addEventListener("focus", mutate); return () => window.removeEventListener("focus", mutate); }, [mutate]);
 return { data, error, isLoading: busy && data.length === 0, isValidating: busy, mutate, loadMore: () => setCursor(data[data.length-1]?.meta.cursor ?? null) };
}
export function AcademiaCatalogs({ canEdit }: { canEdit: boolean }) {
 const t = useT(); const [kind, setKind] = useState<CatalogKind>("audiences");
 return <section aria-label={t("Cadastros da academia")}>
   <div className="mb-6 flex flex-wrap gap-2" aria-label={t("Tipo de cadastro")}>
    {catalogKinds.map(k => <Button key={k} variant={kind === k ? "default" : "outline"} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(catalogLabels[k])}</Button>)}
   </div>
   <CatalogList key={kind} kind={kind} canEdit={canEdit} />
 </section>;
}
function CatalogList({ kind, canEdit }: { kind: CatalogKind; canEdit: boolean }) {
 const t = useT(); const [editor, setEditor] = useState<{ row?: CatalogRecord; key: string } | null>(null);
 const { data, error, isLoading, isValidating, loadMore, mutate } = useCatalogPages(kind);
 const rows = data?.flatMap(p => p.data) ?? [];
 const hasMore = data?.[data.length-1]?.meta.has_more;
 return <>
   <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
    <h2 className="text-xl font-semibold">{t(catalogLabels[kind])}</h2>
    {canEdit && <Button onClick={() => setEditor({ key: randomId() })}>{t("Novo cadastro")}</Button>}
   </div>
   {kind === "audiences" && <p className="mb-4 text-sm text-muted-foreground">{t("As faixas etárias podem ser ajustadas. Marque como provisória toda regra que ainda precisa de confirmação.")}</p>}
   {!canEdit && <p className="mb-4 text-sm text-muted-foreground">{t("Administradores e gestores podem editar estes cadastros.")}</p>}
   {isLoading && <p role="status">{t("Carregando cadastros…")}</p>}
   {error && <div role="alert" className="mb-4 rounded-lg border p-4"><p>{t("Não foi possível atualizar a lista. Os dados exibidos podem estar desatualizados.")}</p><Button variant="outline" className="mt-3" onClick={() => void mutate()}>{t("Tentar novamente")}</Button></div>}
   {!isLoading && !error && rows.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center"><h3 className="font-medium">{t("Nenhum cadastro por aqui ainda.")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("Os registros cadastrados aqui serão usados na grade de aulas.")}</p></div>}
   <div className="grid gap-3 md:grid-cols-2">
    {rows.map(row => <article key={row.id} className="min-w-0 rounded-xl border bg-card p-5">
     <div className="flex items-start justify-between gap-3"><h3 className="break-words font-semibold">{row.name}</h3><span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs">{t(row.active ? "Ativo" : "Inativo")}</span></div>
     {kind === "audiences" && <div className="mt-3 text-sm"><p>{t("Idade mínima")}: {row.min_age ?? t("Não definida")} · {t("Idade máxima")}: {row.max_age ?? t("Não definida")}</p><p className="mt-1 text-muted-foreground">{t(row.age_pending ? "Faixa etária provisória" : "Faixa etária confirmada")}</p></div>}
     {!!row.aliases?.length && <p className="mt-3 break-words text-sm">{t("Nomes alternativos")}: {row.aliases.join(", ")}</p>}
     {row.notes && <p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{row.notes}</p>}
     {canEdit && <Button className="mt-4" variant="outline" aria-label={`${t("Editar")}: ${row.name}`} onClick={() => setEditor({ row, key: row.id })}>{t("Editar")}</Button>}
    </article>)}
   </div>
   {hasMore && <Button className="mt-5" variant="outline" disabled={isValidating} onClick={() => loadMore()}>{t("Carregar mais")}</Button>}
   {editor && <CatalogEditor key={editor.key} kind={kind} row={editor.row} creationKey={editor.key} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void mutate(); }} />}
 </>;
}
function CatalogEditor({ kind, row, creationKey, onClose, onSaved }: { kind: CatalogKind; row?: CatalogRecord; creationKey: string; onClose: () => void; onSaved: () => void }) {
 const t = useT(); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
 const [name, setName] = useState(row?.name ?? ""); const [notes, setNotes] = useState(row?.notes ?? "");
 const [active, setActive] = useState(row?.active ?? true);
 const [minAge, setMinAge] = useState(row?.min_age == null ? "" : String(row.min_age));
 const [maxAge, setMaxAge] = useState(row?.max_age == null ? "" : String(row.max_age));
 const [pending, setPending] = useState(row?.age_pending ?? true); const [aliases, setAliases] = useState(row?.aliases?.join(", ") ?? "");
 async function save(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault(); setSaving(true); setError("");
  const values = { name, notes, active, ...(kind === "audiences" ? { min_age: minAge === "" ? null : Number(minAge), max_age: maxAge === "" ? null : Number(maxAge), age_pending: pending } : {}), ...(kind === "modalities" ? { aliases: aliases.split(",").map(a => a.trim()).filter(Boolean) } : {}) };
  try {
   const response = await fetch(`/api/v1/academia/catalogs/${kind}`, { method: row ? "PATCH" : "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": creationKey }, body: JSON.stringify({ ...(row ? { id: row.id, revision: row.revision } : {}), values }) });
   const result = await response.json();
   if (!response.ok) { setError(result.error?.message ? t(result.error.message) : t("Não foi possível salvar o cadastro.")); return; }
   toast.success(t("Cadastro salvo.")); onSaved();
  } catch { setError(t("Não foi possível confirmar a gravação. Tente salvar novamente para conferir, sem duplicar o cadastro.")); }
  finally { setSaving(false); }
 }
 return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
  <DialogHeader><DialogTitle>{t(row ? "Editar cadastro" : "Novo cadastro")}</DialogTitle><DialogDescription>{t(catalogLabels[kind])}</DialogDescription></DialogHeader>
  <form className="space-y-5" onSubmit={event => void save(event)}>
   <fieldset disabled={saving} className="space-y-5">
    <div className="space-y-2"><Label htmlFor="catalog-name">{t("Nome")}</Label><Input id="catalog-name" required maxLength={120} value={name} onChange={e => setName(e.target.value)} autoFocus /></div>
    {kind === "audiences" && <>
     <div className="grid grid-cols-2 gap-4"><div className="space-y-2"><Label htmlFor="catalog-min">{t("Idade mínima")}</Label><Input id="catalog-min" type="number" min={0} max={120} step={1} value={minAge} onChange={e => setMinAge(e.target.value)} /></div><div className="space-y-2"><Label htmlFor="catalog-max">{t("Idade máxima")}</Label><Input id="catalog-max" type="number" min={0} max={120} step={1} value={maxAge} onChange={e => setMaxAge(e.target.value)} /></div></div>
     <p className="text-sm text-muted-foreground">{t("Campo vazio significa informação não definida. As idades são informadas em anos completos.")}</p>
     <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={pending} onChange={e => setPending(e.target.checked)} />{t("Faixa etária provisória")}</label>
    </>}
    {kind === "modalities" && <div className="space-y-2"><Label htmlFor="catalog-aliases">{t("Nomes alternativos")}</Label><Input id="catalog-aliases" value={aliases} onChange={e => setAliases(e.target.value)} /><p className="text-sm text-muted-foreground">{t("Separe por vírgulas. Exemplo: spinning, bike indoor.")}</p></div>}
    <div className="space-y-2"><Label htmlFor="catalog-notes">{t("Observações")}</Label><Textarea id="catalog-notes" maxLength={2000} rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></div>
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />{t("Cadastro ativo")}</label>
    <p className="text-sm text-muted-foreground">{t("Desativar preserva o cadastro e seu histórico.")}</p>
   </fieldset>
   {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
   <div className="flex flex-wrap justify-end gap-3"><Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancelar")}</Button><Button type="submit" disabled={saving}>{t(saving ? "Salvando…" : "Salvar cadastro")}</Button></div>
  </form>
 </DialogContent></Dialog>;
}

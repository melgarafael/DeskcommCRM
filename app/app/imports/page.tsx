import Link from "next/link";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ARCHIVE_LABELS, archiveManifest, archiveQuery, importedRecordHref, importedRecordSummary } from "@/lib/imports/archive";

export const dynamic = "force-dynamic";

export default async function ImportedHistoryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requireRole("manager", { resource: "data_import_records" });
  if (!authz.ok) return <p>{traduzir("Acesso restrito a gestores.", "pt-BR")}</p>;
  const t = (text: string) => traduzir(text, authz.user.idioma);
  const parsed = archiveQuery.safeParse(await searchParams);
  if (!parsed.success) return <p>{t("Filtros inválidos.")}</p>;
  const supabase = await createClient();
  const { data: batch, error: batchError } = await supabase.from("data_import_batches")
    .select("id, source, source_cutoff, status, manifest")
    .eq("organization_id", authz.org.orgId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (batchError) return <p>{t("Não foi possível carregar o histórico importado.")}</p>;
  if (!batch) return <div className="p-6"><h1 className="text-2xl font-semibold">{t("Histórico importado")}</h1><p className="mt-4 text-muted-foreground">{t("Nenhuma importação registrada nesta empresa.")}</p></div>;
  const manifest = archiveManifest.safeParse(batch.manifest);
  if (!manifest.success) return <p>{t("Não foi possível carregar o histórico importado.")}</p>;
  const tables = Object.entries(manifest.data.tables).filter(([, value]) => value.count > 0);
  const { page, contact } = parsed.data;
  const table = tables.some(([name]) => name === parsed.data.table) ? parsed.data.table : tables[0]?.[0];
  if (!table) return <p>{t("Nenhum registro encontrado.")}</p>;
  let query = supabase.from("data_import_records")
    .select("id, source_id, source_data, target_table, target_id, occurred_at, file_name, file_availability", { count: "exact" })
    .eq("organization_id", authz.org.orgId).eq("batch_id", batch.id).eq("source_table", table)
    .order("source_id").range((page - 1) * 20, page * 20 - 1);
  if (contact) query = query.eq("contact_id", contact);
  const { data: records, count, error } = await query;
  if (error) return <p>{t("Não foi possível carregar o histórico importado.")}</p>;
  const href = (next: number) => `/app/imports?${new URLSearchParams({ table, page: String(next), ...(contact ? { contact } : {}) })}`;
  return <div className="mx-auto max-w-5xl space-y-6 p-6">
    <header><h1 className="text-2xl font-semibold">{t("Histórico importado")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("Consulte os registros preservados da origem e abra os cadastros vinculados no CRM.")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("Origem")}: {batch.source} · {t("Data de corte")}: {batch.source_cutoff}</p>
    </header>
    <form className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">{t("Tipo de registro")}
        <select name="table" defaultValue={table} className="rounded-md border bg-background p-2 text-foreground">
          {tables.map(([name, item]) => <option key={name} value={name}>{t(ARCHIVE_LABELS[name] ?? "Outros registros")} ({item.count})</option>)}
        </select>
      </label>
      {contact && <input type="hidden" name="contact" value={contact} />}
      <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" type="submit">{t("Consultar")}</button>
      <span className="py-2 text-sm text-muted-foreground">{count ?? 0} {t("registros")}</span>
    </form>
    <div className="space-y-3">{(records ?? []).map(record => {
      const destination = importedRecordHref(record.target_table, record.target_id);
      return <article key={record.id} className="rounded-lg border bg-card p-4 text-card-foreground">
        <p className="whitespace-pre-wrap break-words text-sm">{importedRecordSummary(record.source_data) ?? t(ARCHIVE_LABELS[table] ?? "Registro de origem")}</p>
        <p className="mt-2 text-xs text-muted-foreground">{record.occurred_at ?? batch.source_cutoff} · {t("ID de origem")}: {record.source_id}</p>
        {destination && <Link href={destination} className="mt-2 inline-block text-sm text-primary underline">{t("Abrir no CRM")}</Link>}
        {record.file_availability === "available" && <a href={`/api/v1/imports/${record.id}/file`} target="_blank" rel="noreferrer" className="ml-3 text-sm text-primary underline">{record.file_name ?? t("Abrir arquivo")}</a>}
        {record.file_availability === "unavailable" && <p className="mt-2 text-sm text-muted-foreground">{t("Anexo indisponível na origem.")}</p>}
        <details className="mt-3 text-xs"><summary className="cursor-pointer">{t("Dados preservados da origem")}</summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-muted-foreground">{JSON.stringify(record.source_data, null, 2)}</pre>
        </details>
      </article>;
    })}</div>
    <nav className="flex items-center gap-4 text-sm" aria-label={t("Paginação")}>
      {page > 1 && <Link href={href(page - 1)} className="underline">{t("Anterior")}</Link>}
      <span>{t("Página")} {page}</span>
      {page * 20 < (count ?? 0) && <Link href={href(page + 1)} className="underline">{t("Próxima")}</Link>}
    </nav>
  </div>;
}

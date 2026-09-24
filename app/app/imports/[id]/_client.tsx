"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";

export function ImportDetailClient({ id }: { id: string }) {
  const t = useT();
  const [batch, setBatch] = useState<Record<string, unknown> | null>(null);
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [onlyConflicts, setOnlyConflicts] = useState(false);

  const load = useCallback(async () => {
    const qs = onlyConflicts ? "?status=conflict" : "";
    const res = await fetch(`/api/v1/imports/${id}${qs}`);
    const json = await res.json();
    if (res.ok) {
      setBatch(json.data.batch);
      setRows(json.data.rows ?? []);
    }
  }, [id, onlyConflicts]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!batch) return <div className="p-6 text-muted-foreground">{t("Carregando…")}</div>;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <Link href="/app/imports" className="text-sm text-muted-foreground hover:underline">
          ← {t("Importações")}
        </Link>
        <h1 className="text-xl font-semibold">{batch.filename as string}</h1>
        <p className="text-sm text-muted-foreground">
          {batch.status as string} · {batch.successful_rows as number} ok ·{" "}
          {batch.conflict_rows as number} conflitos · {batch.failed_rows as number} falhas
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={onlyConflicts}
          onChange={(e) => setOnlyConflicts(e.target.checked)}
        />
        {t("Só conflitos")}
      </label>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Erro")}</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Person</TableHead>
              <TableHead>Contact</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id as string}>
                <TableCell>{r.row_number as number}</TableCell>
                <TableCell>{r.status as string}</TableCell>
                <TableCell className="max-w-xs truncate text-xs">{(r.error as string) || "—"}</TableCell>
                <TableCell className="font-mono text-xs">{(r.company_id as string)?.slice(0, 8) || "—"}</TableCell>
                <TableCell className="font-mono text-xs">{(r.person_id as string)?.slice(0, 8) || "—"}</TableCell>
                <TableCell className="font-mono text-xs">{(r.contact_id as string)?.slice(0, 8) || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

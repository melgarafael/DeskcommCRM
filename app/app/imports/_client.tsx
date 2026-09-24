"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";

interface BatchRow {
  id: string;
  filename: string;
  status: string;
  total_rows: number;
  successful_rows: number;
  failed_rows: number;
  conflict_rows: number;
  created_at: string;
  completed_at: string | null;
}

export function ImportsListClient() {
  const t = useT();
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/v1/imports");
    const json = await res.json();
    setRows(Array.isArray(json.data) ? json.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function upload() {
    if (!file) return;
    setUploading(true);
    setMessage(null);
    const fd = new FormData();
    fd.set("file", file);
    const res = await fetch("/api/v1/imports", { method: "POST", body: fd });
    const json = await res.json();
    setUploading(false);
    if (!res.ok) {
      setMessage(json.error?.message ?? t("Falha na importação."));
      return;
    }
    setMessage(
      t("Lote processado") +
        `: ${json.data.successful_rows} ok, ${json.data.conflict_rows} conflitos, ${json.data.failed_rows} falhas.`,
    );
    setFile(null);
    void load();
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-semibold">{t("Importações")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("CSV ou XLSX com empresa, CNPJ, pessoa, cargo, telefone e e-mail.")}
        </p>
      </div>

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium">{t("Arquivo")}</label>
          <Input
            type="file"
            accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <Button disabled={!file || uploading} onClick={() => void upload()}>
          {uploading ? t("Importando…") : t("Importar")}
        </Button>
        {message ? <p className="w-full text-sm text-muted-foreground">{message}</p> : null}
      </Card>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Arquivo")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Linhas")}</TableHead>
              <TableHead>{t("Sucesso")}</TableHead>
              <TableHead>{t("Conflitos")}</TableHead>
              <TableHead>{t("Falhas")}</TableHead>
              <TableHead>{t("Data")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  {t("Nenhuma importação ainda.")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <Link className="hover:underline" href={`/app/imports/${b.id}`}>
                      {b.filename}
                    </Link>
                  </TableCell>
                  <TableCell>{b.status}</TableCell>
                  <TableCell>{b.total_rows}</TableCell>
                  <TableCell>{b.successful_rows}</TableCell>
                  <TableCell>{b.conflict_rows}</TableCell>
                  <TableCell>{b.failed_rows}</TableCell>
                  <TableCell className="text-xs">
                    {new Date(b.created_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

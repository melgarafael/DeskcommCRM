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
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { neutralizarFormula } from "@/lib/csv/neutralizar-formula";
import { roleAtLeast } from "@/lib/auth/types";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

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

/** A prévia que a rota devolve com `previa=true` (A23, #4888). */
export interface Previa {
  previa: {
    total: number;
    novas: number;
    anexadas: number;
    ja_existem: number;
    conflitos: number;
    repetidas: number;
    sem_telefone: number;
    invalidas: number;
  };
  headers: string[];
  linhas_fora: Array<{
    linha: number;
    status: string;
    motivo: string | null;
    existente_nome: string | null;
    de_quem: string | null;
    valores: string[];
  }>;
}

/**
 * CSV (com BOM, para o Excel abrir o acento) das linhas que ficaram de fora.
 * Cada célula passa por `neutralizarFormula`, como todo export do produto: o
 * nome do cadastro existente e as células da planilha são texto de terceiro.
 */
export function csvDasLinhasDeFora(p: Previa, t: (s: string) => string): string {
  const aspas = (v: string) => `"${neutralizarFormula(v).replace(/"/g, '""')}"`;
  const cabecalho = [t("Linha"), t("Situação"), t("Motivo"), t("Já cadastrado como"), t("De quem é"), ...p.headers];
  const linhas = p.linhas_fora.map((l) =>
    [String(l.linha), l.status, l.motivo ?? "", l.existente_nome ?? "", l.de_quem ?? "", ...l.valores].map(aspas).join(","),
  );
  return "\uFEFF" + [cabecalho.map(aspas).join(","), ...linhas].join("\r\n");
}

interface Membro {
  user_id: string;
  role: string;
  full_name: string | null;
}

export function ImportsListClient() {
  const t = useT();
  const usuario = useUser();
  const podeEscolherODono = roleAtLeast(useActiveOrg()?.role, "manager");
  // A23 parte 2: o dono da carteira dos contatos criados. Padrão: quem importa.
  // O Atendente só é dono dele mesmo (o servidor também confere); gerente e admin escolhem.
  const [membros, setMembros] = useState<Membro[]>([]);
  const [donoId, setDonoId] = useState<string>(usuario.id);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A23: a prévia vem ANTES de gravar. `null` = ainda não conferiu o arquivo.
  const [previa, setPrevia] = useState<Previa | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/v1/imports");
    const json = await res.json();
    setRows(Array.isArray(json.data) ? json.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!podeEscolherODono) return;
    void fetch("/api/v1/team/assignable")
      .then((r) => r.json())
      .then((j) => setMembros(Array.isArray(j.data) ? (j.data as Membro[]) : []))
      .catch(() => setMembros([]));
  }, [podeEscolherODono]);

  async function enviar(modo: "previa" | "importar") {
    if (!file) return;
    setUploading(true);
    setMessage(null);
    const fd = new FormData();
    fd.set("file", file);
    if (modo === "previa") fd.set("previa", "true");
    else fd.set("dono_user_id", donoId);
    const res = await fetch("/api/v1/imports", { method: "POST", body: fd });
    const json = await res.json();
    setUploading(false);
    if (!res.ok) {
      setMessage(json.error?.message ?? t("Falha na importação."));
      return;
    }
    if (modo === "previa") {
      setPrevia(json.data as Previa);
      return;
    }
    // A carteira é best-effort: o lote grava mesmo se ela falhar. Quem importou precisa
    // saber quantos contatos ficaram sem dono (-1 = nem a leitura do lote funcionou).
    const carteira = json.data.carteira as { definidos: number; falhas: number } | undefined;
    const avisoDaCarteira =
      !carteira || carteira.falhas === 0
        ? ""
        : carteira.falhas < 0
          ? ` ${t("Não foi possível conferir a carteira: confira o dono dos contatos do lote.")}`
          : ` ${carteira.falhas} ${t("contatos ficaram sem dono na carteira.")}`;
    setMessage(
      t("Lote processado") +
        `: ${json.data.successful_rows} ok, ${json.data.conflict_rows} conflitos, ${json.data.failed_rows} falhas.` +
        avisoDaCarteira,
    );
    setFile(null);
    setPrevia(null);
    void load();
  }

  function baixarCsvDoQueFicouDeFora() {
    if (!previa) return;
    const blob = new Blob([csvDasLinhasDeFora(previa, t)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(file?.name ?? "importacao").replace(/\.[^.]+$/, "")}-ficaram-de-fora.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPrevia(null); // outro arquivo, outra conferência
            }}
          />
        </div>
        <Button disabled={!file || uploading} onClick={() => void enviar("previa")} data-testid="conferir-importacao">
          {uploading && !previa ? t("Conferindo…") : t("Conferir arquivo")}
        </Button>
        {message ? <p className="w-full text-sm text-muted-foreground">{message}</p> : null}
      </Card>

      {/* A23: a prévia antes de gravar. Só duas saídas — importar as novas, ou baixar o resto. */}
      {previa ? (
        <Card className="space-y-3 p-4" data-testid="previa-da-importacao">
          <p className="text-sm font-medium">
            {previa.previa.total} {t("linhas")}: {previa.previa.novas} {t("novas")}, {previa.previa.anexadas}{" "}
            {t("anexadas à empresa que já existe")}, {previa.previa.ja_existem}{" "}
            {t("já existem")}, {previa.previa.conflitos + previa.previa.repetidas} {t("conflitos ou repetidas")},{" "}
            {previa.previa.sem_telefone} {t("sem telefone")}, {previa.previa.invalidas} {t("inválidas")}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={uploading || previa.previa.novas + previa.previa.anexadas === 0}
              onClick={() => void enviar("importar")}
              data-testid="importar-so-as-novas"
            >
              {uploading ? t("Importando…") : `${t("Importar só as")} ${previa.previa.novas + previa.previa.anexadas} ${t("novas")}`}
            </Button>
            <Button
              variant="outline"
              disabled={previa.linhas_fora.length === 0}
              onClick={baixarCsvDoQueFicouDeFora}
              data-testid="baixar-csv-de-fora"
            >
              {t("Baixar o CSV do que ficou de fora")} ({previa.linhas_fora.length})
            </Button>
          </div>
          {/* A23 parte 2: de quem ficam os contatos criados. */}
          <div className="grid max-w-sm gap-1.5">
            <label className="text-sm font-medium" htmlFor="dono-da-carteira">
              {t("Dono da carteira dos contatos criados")}
            </label>
            {podeEscolherODono ? (
              <select
                id="dono-da-carteira"
                data-testid="dono-da-carteira"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={donoId}
                onChange={(e) => setDonoId(e.target.value)}
              >
                <option value={usuario.id}>{t("Eu (quem importa)")}</option>
                {membros
                  .filter((m) => m.user_id !== usuario.id)
                  .map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {rotuloDoMembro(m, t)}
                    </option>
                  ))}
              </select>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="dono-da-carteira">
                {t("Eu (quem importa)")}
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("O que já existe não é duplicado nem sobrescrito: o CSV diz de quem é, para você resolver com o responsável.")}
          </p>
        </Card>
      ) : null}

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

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Buildings, MagnifyingGlass, Plus } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

interface CompanyRow {
  id: string;
  trade_name: string | null;
  legal_name: string | null;
  cnpj: string | null;
  city: string | null;
  state: string | null;
  registration_status: string | null;
  enrichment_status: string;
  updated_at: string;
}

export function CompaniesListClient() {
  const t = useT();
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [tradeName, setTradeName] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    const res = await fetch(`/api/v1/companies${qs}`);
    const json = await res.json();
    setRows(Array.isArray(json.data) ? json.data : []);
    setLoading(false);
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/v1/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legal_name: legalName || null,
        trade_name: tradeName || null,
        cnpj: cnpj || null,
        enrich: true,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(json.error?.message ?? t("Não foi possível criar."));
      return;
    }
    setCreateOpen(false);
    setLegalName("");
    setTradeName("");
    setCnpj("");
    void load();
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("Empresas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Cadastro B2B com CNPJ e enriquecimento via BrasilAPI.")}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 size-4" />
          {t("Nova empresa")}
        </Button>
      </div>

      <div className="relative max-w-sm">
        <MagnifyingGlass className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder={t("Buscar por nome ou CNPJ")}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          autoComplete="new-password"
        />
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Nome fantasia")}</TableHead>
              <TableHead>{t("Razão social")}</TableHead>
              <TableHead>CNPJ</TableHead>
              <TableHead>{t("Cidade/UF")}</TableHead>
              <TableHead>{t("Situação")}</TableHead>
              <TableHead>{t("Atualizado")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  {t("Carregando…")}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  <Buildings className="mx-auto mb-2 size-8 opacity-40" />
                  {t("Nenhuma empresa ainda.")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <Link className="font-medium underline-offset-2 hover:underline" href={`/app/companies/${c.id}`}>
                      {c.trade_name || c.legal_name || "—"}
                    </Link>
                  </TableCell>
                  <TableCell>{c.legal_name || "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{c.cnpj || "—"}</TableCell>
                  <TableCell>
                    {[c.city, c.state].filter(Boolean).join("/") || "—"}
                  </TableCell>
                  <TableCell>{c.registration_status || c.enrichment_status}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(c.updated_at).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Nova empresa")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label>{t("Razão social")}</Label>
              <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Nome fantasia")}</Label>
              <Input value={tradeName} onChange={(e) => setTradeName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>CNPJ</Label>
              <Input value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0000-00" />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void create()} disabled={saving || (!legalName && !tradeName && !cnpj)}>
              {saving ? t("Salvando…") : t("Criar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

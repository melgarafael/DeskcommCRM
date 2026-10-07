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
  const [street, setStreet] = useState("");
  const [number, setNumber] = useState("");
  const [complement, setComplement] = useState("");
  const [district, setDistrict] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [consulting, setConsulting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Aviso que NÃO é erro: consulta ok, mas algo o usuário precisa ver. */
  const [aviso, setAviso] = useState<string | null>(null);

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

  /**
   * Consulta ANTES de criar (#1937): o CNPJ vai pra BrasilAPI, os dados públicos
   * preenchem o formulário e quem cria revisa. Nada é gravado aqui — a rota de
   * lookup só lê.
   */
  async function consultar() {
    setConsulting(true);
    setError(null);
    setAviso(null);
    const res = await fetch(`/api/v1/companies/lookup?cnpj=${encodeURIComponent(cnpj)}`);
    const json = await res.json().catch(() => null);
    setConsulting(false);
    if (!res.ok) {
      const dica = json?.error?.details?.dica;
      setError(
        [json?.error?.message ?? t("Não foi possível consultar o CNPJ."), dica]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }
    const dados = json?.data ?? {};
    const f = dados.fields ?? {};
    setLegalName((f.legal_name as string) || legalName);
    setTradeName((f.trade_name as string) || tradeName);
    setStreet((f.street as string) || "");
    setNumber((f.number as string) || "");
    setComplement((f.complement as string) || "");
    setDistrict((f.district as string) || "");
    setCity((f.city as string) || "");
    setState((f.state as string) || "");
    setZipCode((f.zip_code as string) || "");
    setEmail((f.email as string) || "");
    setPhone((f.phone as string) || "");
    if (dados.cnpj) setCnpj(dados.cnpj);
    setAviso(
      dados.already_registered
        ? t("Já existe uma empresa com este CNPJ nesta organização. Revise antes de criar.")
        : t("Dados públicos preenchidos. Revise antes de criar."),
    );
  }

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
        street: street || null,
        number: number || null,
        complement: complement || null,
        district: district || null,
        city: city || null,
        state: state || null,
        zip_code: zipCode || null,
        email: email || null,
        phone: phone || null,
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
    setStreet("");
    setNumber("");
    setComplement("");
    setDistrict("");
    setCity("");
    setState("");
    setZipCode("");
    setEmail("");
    setPhone("");
    setAviso(null);
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

      <Dialog
        open={createOpen}
        onOpenChange={(aberto) => {
          setCreateOpen(aberto);
          if (aberto) {
            setError(null);
            setAviso(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Nova empresa")}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto py-2 pr-1">
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
              <div className="flex gap-2">
                <Input
                  value={cnpj}
                  onChange={(e) => setCnpj(e.target.value)}
                  placeholder="00.000.000/0000-00"
                  maxLength={32}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void consultar()}
                  disabled={consulting || !cnpj.trim()}
                >
                  {consulting ? t("Consultando…") : t("Consultar CNPJ")}
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>{t("E-mail")}</Label>
                <Input
                  type="email"
                  value={email}
                  maxLength={254}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Telefone")}</Label>
                <Input value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
              <div className="grid gap-1.5">
                <Label>{t("Rua")}</Label>
                <Input
                  value={street}
                  maxLength={300}
                  onChange={(e) => setStreet(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Número")}</Label>
                <Input value={number} maxLength={40} onChange={(e) => setNumber(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>{t("Complemento")}</Label>
                <Input
                  value={complement}
                  maxLength={120}
                  onChange={(e) => setComplement(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>{t("Bairro")}</Label>
                <Input
                  value={district}
                  maxLength={120}
                  onChange={(e) => setDistrict(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_5rem_9rem]">
              <div className="grid gap-1.5">
                <Label>{t("Cidade")}</Label>
                <Input value={city} maxLength={120} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>UF</Label>
                <Input
                  value={state}
                  maxLength={2}
                  onChange={(e) => setState(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>CEP</Label>
                <Input
                  value={zipCode}
                  maxLength={16}
                  onChange={(e) => setZipCode(e.target.value)}
                />
              </div>
            </div>
            {aviso ? (
              <p
                role="status"
                className="rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg"
              >
                {aviso}
              </p>
            ) : null}
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
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

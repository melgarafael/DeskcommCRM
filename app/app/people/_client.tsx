"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MagnifyingGlass, Plus, UserCircle } from "@/lib/ui/icons";
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
import { CamposDoVinculo, VINCULO_VAZIO, type Vinculo } from "@/components/crm-b2b/CamposDoVinculo";

interface EmpresaEscolhida {
  id: string;
  nome: string;
}

/**
 * Campo Empresa da "Nova pessoa" (issue #3198): busca curta, sem diálogo por
 * cima do diálogo. Opcional — a pessoa pode nascer sem empresa e ser ligada
 * depois pela ficha.
 */
function CampoEmpresa({
  valor,
  onChange,
}: {
  valor: EmpresaEscolhida | null;
  onChange: (v: EmpresaEscolhida | null) => void;
}) {
  const t = useT();
  const [busca, setBusca] = useState("");
  const [opcoes, setOpcoes] = useState<EmpresaEscolhida[]>([]);

  useEffect(() => {
    if (valor || !busca.trim()) {
      setOpcoes([]);
      return;
    }
    let cancelado = false;
    const timer = setTimeout(() => {
      void fetch(`/api/v1/companies?limit=5&search=${encodeURIComponent(busca.trim())}`)
        .then((res) => res.json())
        .then((json) => {
          if (cancelado) return;
          const linhas = Array.isArray(json?.data) ? (json.data as Record<string, unknown>[]) : [];
          setOpcoes(
            linhas.map((l) => ({
              id: l.id as string,
              nome: (l.trade_name as string) || (l.legal_name as string) || (l.id as string),
            })),
          );
        })
        .catch(() => {
          if (!cancelado) setOpcoes([]);
        });
    }, 250);
    return () => {
      cancelado = true;
      clearTimeout(timer);
    };
  }, [busca, valor]);

  if (valor) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
        <span className="font-medium">{valor.nome}</span>
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          {t("Trocar")}
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <Input
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder={t("Buscar empresa por nome ou CNPJ")}
        autoComplete="new-password"
      />
      {opcoes.length > 0 ? (
        <ul className="rounded-md border text-sm">
          {opcoes.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left hover:bg-muted"
                onClick={() => {
                  onChange(o);
                  setBusca("");
                }}
              >
                {o.nome}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface PersonRow {
  id: string;
  full_name: string;
  email: string | null;
  /** O da ficha e os dos contatos ligados (issue #3198). */
  emails?: string[];
  updated_at: string;
}

export function PeopleListClient() {
  const t = useT();
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [empresa, setEmpresa] = useState<EmpresaEscolhida | null>(null);
  const [vinculo, setVinculo] = useState<Vinculo>(VINCULO_VAZIO);
  const [erroAoCriar, setErroAoCriar] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    const res = await fetch(`/api/v1/people${qs}`);
    const json = await res.json();
    setRows(Array.isArray(json.data) ? json.data : []);
    setLoading(false);
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setSaving(true);
    setErroAoCriar(null);
    const res = await fetch("/api/v1/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        full_name: fullName,
        email: email || null,
        ...(empresa
          ? {
              company_id: empresa.id,
              job_title: vinculo.job_title.trim() || null,
              is_decision_maker: vinculo.is_decision_maker,
            }
          : {}),
      }),
    });
    setSaving(false);
    if (res.ok) {
      setCreateOpen(false);
      setFullName("");
      setEmail("");
      setEmpresa(null);
      setVinculo(VINCULO_VAZIO);
      void load();
    } else {
      const json = await res.json().catch(() => null);
      setErroAoCriar((json?.error?.message as string | undefined) || t("Não foi possível salvar."));
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("Pessoas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Decisores e contatos — telefones ficam em Contatos.")}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 size-4" />
          {t("Nova pessoa")}
        </Button>
      </div>

      <div className="relative max-w-sm">
        <MagnifyingGlass className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("Buscar por nome ou e-mail")}
          autoComplete="new-password"
        />
      </div>

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Nome")}</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>{t("Atualizado")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={3}>{t("Carregando…")}</TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                  <UserCircle className="mx-auto mb-2 size-8 opacity-40" />
                  {t("Nenhuma pessoa ainda.")}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link className="font-medium hover:underline" href={`/app/people/${p.id}`}>
                      {p.full_name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {(p.emails ?? (p.email ? [p.email] : [])).join(" · ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(p.updated_at).toLocaleString()}
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
          if (!aberto) {
            setEmpresa(null);
            setVinculo(VINCULO_VAZIO);
            setErroAoCriar(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Nova pessoa")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>{t("Nome completo")}</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>E-mail</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("Empresa (opcional)")}</Label>
              <CampoEmpresa valor={empresa} onChange={setEmpresa} />
            </div>
            {empresa ? <CamposDoVinculo valor={vinculo} onChange={setVinculo} /> : null}
            {erroAoCriar ? (
              <p className="text-sm text-destructive" role="alert">
                {erroAoCriar}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                setEmpresa(null);
                setVinculo(VINCULO_VAZIO);
                setErroAoCriar(null);
              }}
            >
              {t("Cancelar")}
            </Button>
            <Button disabled={!fullName.trim() || saving} onClick={() => void create()}>
              {t("Criar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

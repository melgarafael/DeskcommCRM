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

interface PersonRow {
  id: string;
  full_name: string;
  email: string | null;
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
    const res = await fetch("/api/v1/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: fullName, email: email || null }),
    });
    setSaving(false);
    if (res.ok) {
      setCreateOpen(false);
      setFullName("");
      setEmail("");
      void load();
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
                  <TableCell>{p.email || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(p.updated_at).toLocaleString()}
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
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

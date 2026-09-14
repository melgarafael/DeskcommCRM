"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";

type LinkRow = { id: string; pessoa_codigo: number; status: "pending" | "linked" | "conflict" | "unlinked" };

export function AdvomaxLinkCard({ contactId, canManage = false }: { contactId: string; canManage?: boolean }) {
  const t = useT();
  const [link, setLink] = useState<LinkRow | null>(null);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ativo = true;
    void fetch(`/api/v1/contacts/${contactId}/advomax-link`).then((r) => r.ok ? r.json() : null).then((body) => {
      if (!ativo) return;
      const value = body?.data as LinkRow | null | undefined;
      setLink(value ?? null);
      if (value) setCodigo(String(value.pessoa_codigo));
    }).catch(() => undefined);
    return () => { ativo = false; };
  }, [contactId]);

  async function vincular() {
    const pessoa = Number(codigo);
    if (!Number.isInteger(pessoa) || pessoa <= 0) { setErro(t("Informe o código da Pessoa no Advomax.")); return; }
    setSaving(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pessoa_codigo: pessoa }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível criar o vínculo."));
      setLink(body.data as LinkRow);
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível criar o vínculo.")); }
    finally { setSaving(false); }
  }

  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">{t("Cadastro jurídico")}</h2><p className="text-sm text-muted-foreground">{t("Vincule este contato a uma Pessoa do Advomax para compartilhar contexto e documentos.")}</p></div>
      {link && <Badge variant={link.status === "linked" ? "success" : "warning"}>{link.status === "linked" ? t("Vinculado") : t("Aguardando confirmação")}</Badge>}
    </div>
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input inputMode="numeric" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder={t("Código da Pessoa") } aria-label={t("Código da Pessoa") } disabled={!canManage} />
      <Button onClick={vincular} disabled={!canManage || saving}>{saving ? t("Salvando…") : t("Vincular Pessoa")}</Button>
    </div>
    {!canManage && <p className="text-xs text-muted-foreground">{t("Somente gerentes podem confirmar este vínculo.")}</p>}
    {erro && <p role="alert" className="text-sm text-error-fg">{erro}</p>}
  </Card>;
}

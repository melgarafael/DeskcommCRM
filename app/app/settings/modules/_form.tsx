"use client";
import { toast } from "sonner";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

export function ModulesForm({ initial, organizationName }: { initial: boolean; organizationName: string }) {
  const t = useT();
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function save() {
    setSaving(true); setError(""); setSaved(false);
    try {
      const response = await fetch("/api/v1/modules", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ academia: enabled }) });
      if (!response.ok) throw new Error("save_failed");
      setSaved(true); toast.success(t("Configuração salva.")); router.refresh();
    } catch {
      setError(t("Não foi possível confirmar a alteração. Atualize a página para conferir e tente novamente."));
    } finally { setSaving(false); }
  }
  return <section className="rounded-xl border bg-card p-6" aria-labelledby="academia-title">
    <div className="flex flex-col items-start justify-between gap-6 sm:flex-row">
      <div><h2 id="academia-title" className="text-lg font-semibold">{t("Academia")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{organizationName}</p></div>
      <div className="flex shrink-0 items-center gap-3">
        <Label htmlFor="academia-enabled">{t("Habilitar módulo Academia")}</Label>
        <Switch id="academia-enabled" checked={enabled} disabled={saving} onCheckedChange={(value) => { setEnabled(value); setSaved(false); }} />
      </div>
    </div>
    <p className="mt-5 text-sm">{t("Ao ativar, Minha Academia aparece para a equipe. Ao desativar, o acesso ao módulo é bloqueado e os dados são preservados.")}</p>
    <p className="mt-2 text-sm text-muted-foreground">{t("Esta opção vale somente para esta empresa e não altera o atendimento do CRM.")}</p>
    <div className="mt-6 flex flex-wrap items-center gap-4">
      <Button onClick={() => void save()} disabled={saving || enabled === initial}>{t(saving ? "Salvando…" : "Salvar alteração")}</Button>
      {initial && <Link className="text-sm underline underline-offset-4" href="/app/academia">{t("Abrir Minha Academia")}</Link>}
      {saved && <span role="status" className="text-sm">{t("Configuração salva.")}</span>}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
  </section>;
}

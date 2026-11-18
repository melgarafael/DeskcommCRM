"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
export function Configuracao({ enabled: inicial }: { enabled: boolean }) {
  const t = useT();
  const router = useRouter();
  const [enabled, setEnabled] = useState(inicial);
  const [salvando, setSalvando] = useState(false);
  async function gravar(novo: boolean) {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/cadencias/configuracao", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: novo }) });
      if (!res.ok) throw new Error();
      setEnabled(novo);
      router.refresh();
      toast.success(t("Configuração salva."));
    } catch { toast.error(t("Não foi possível salvar a configuração.")); }
    finally { setSalvando(false); }
  }
  return <div className="mx-auto max-w-3xl space-y-6 p-6">
    <h1 className="text-xl font-semibold">{t("Cadências de e-mail")}</h1>
    <Card className="space-y-4 p-6">
      <label className="flex items-center justify-between gap-4"><span>{t("Usar cadências nesta empresa")}</span><Switch checked={enabled} disabled={salvando} onCheckedChange={(novo) => void gravar(novo)} /></label>
      <p className="text-sm text-text-muted">{t("Desligar preserva as cadências e inscrições e impede novos envios. Os links de descadastro continuam funcionando.")}</p>
      <p className="text-sm text-text-muted">{t("Os e-mails usam o transporte configurado pelo dono do servidor. A inscrição é manual; abertura só é contada com autorização do destinatário.")}</p>
      {enabled && <Button asChild><Link href="/app/cadencias">{t("Abrir cadências")}</Link></Button>}
    </Card>
  </div>;
}

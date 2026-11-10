"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirLeadSubmittedCausal } from "@/app/actions/settings/definirLeadSubmittedCausal";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function LeadSubmittedCausal({ ligado, idioma }: { ligado: boolean; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligado);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirLeadSubmittedCausal(novo);
      if (r.ok) {
        toast.success(t("Conexão salva."));
        router.refresh();
        return;
      }
      setValor(!novo);
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="meta_lead_birth">
            {t("Enviar LeadSubmitted por clique CTWA à Meta")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando alguém clicar em um anúncio Click-to-WhatsApp e efetivamente enviar uma mensagem, o sistema poderá registrar um LeadSubmitted na Meta. Apenas abrir a conversa não gera conversão.",
            )}
          </p>
        </div>
        <Switch id="meta_lead_birth" checked={valor} disabled={isPending} onCheckedChange={mudar} />
      </div>
    </Card>
  );
}

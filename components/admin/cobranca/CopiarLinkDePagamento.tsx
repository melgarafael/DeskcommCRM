"use client";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";

/** O link que o revendedor manda pelo WhatsApp da empresa atrasada: recupera receita sem esperar a régua. */
export function CopiarLinkDePagamento({ link }: { link: string }) {
  const t = useT();
  async function copiar() {
    // O helper também funciona em http://IP (self-host sem HTTPS), onde a API de cópia do navegador não existe.
    if (await copyToClipboard(link)) toast.success(t("Link copiado. Mande para a empresa pelo WhatsApp."));
    else toast.error(t("Não consegui copiar — selecione e copie o link manualmente."), { description: link });
  }
  return (
    <Button size="sm" variant="outline" onClick={() => void copiar()}>
      {t("Copiar link de pagamento")}
    </Button>
  );
}

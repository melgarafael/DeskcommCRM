"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { CreditCard } from "@/lib/ui/icons";

interface Props {
  leadId: string;
  /** Sem valor definido, não há o que cobrar — o botão fica desabilitado. */
  hasValue: boolean;
}

/**
 * Gera o link de cobrança PaySuite e copia direto para a área de
 * transferência — o destino é sempre colar no WhatsApp, então poupar o passo
 * de "abrir um diálogo, selecionar, copiar" é o que faz o botão valer a pena.
 *
 * Erro de "PaySuite não configurado" é o caminho mais comum na primeira vez:
 * a mensagem já aponta para a tela de configuração, não só "deu erro".
 */
export function CobrarButton({ leadId, hasValue }: Props) {
  const [enviando, setEnviando] = useState(false);

  async function cobrar() {
    setEnviando(true);
    try {
      const res = await fetch(`/api/v1/leads/${leadId}/charge`, { method: "POST" });
      const json = (await res.json()) as {
        error?: { message?: string };
        data?: { checkout_url?: string };
      };
      if (!res.ok) {
        toast.error(json.error?.message ?? "Não consegui gerar o link de cobrança.");
        return;
      }
      const url = json.data?.checkout_url;
      if (!url) {
        toast.error("PaySuite não devolveu o link de pagamento.");
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Link de pagamento copiado — cole no WhatsApp.");
      } catch {
        toast.success("Link gerado.", { description: url });
      }
    } catch {
      toast.error("Não consegui falar com o servidor.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1 px-2 text-xs"
      disabled={!hasValue || enviando}
      title={hasValue ? undefined : "Defina um valor para o negócio antes de cobrar."}
      onClick={cobrar}
    >
      <CreditCard size={14} weight="bold" />
      {enviando ? "Gerando…" : "Cobrar"}
    </Button>
  );
}

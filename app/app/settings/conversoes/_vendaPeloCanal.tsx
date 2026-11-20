"use client";

/**
 * "Enviar vendas pelo canal da conversa" — desligada por padrão (doc 76, PR #1819).
 * Salva no clique: é uma chave só, sem formulário em volta.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirVendaPeloCanal } from "@/app/actions/settings/definirVendaPeloCanal";
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

export function VendaPeloCanal({
  ligada,
  idioma,
  temCanalQueEnvia = true,
}: {
  ligada: boolean;
  idioma: Idioma;
  /**
   * Alguma conexão da organização devolve a venda pela conversa? `false` só
   * quando a lista de canais foi lida e nenhum serve (QR Code, API oficial
   * direta): sem canal a chave não aciona nada. Se a leitura falhou, quem chama
   * passa `true` — esconder a chave por erro de leitura seria o defeito oposto.
   */
  temCanalQueEnvia?: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligada);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirVendaPeloCanal(novo);
      if (r.ok) {
        toast.success(t("Conexão salva."));
        router.refresh();
        return;
      }
      setValor(!novo);
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  // Sem canal que envie e com a chave desligada, não há o que ligar: a tela
  // aponta para o caminho que serve em vez de oferecer uma chave que não faz nada.
  if (!temCanalQueEnvia && !valor) {
    return (
      <Card className="p-6">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t("Enviar vendas pelo canal da conversa")}</p>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Indisponível: nenhum canal desta organização consegue enviar a venda. Esse envio só existe para o WhatsApp conectado por um provedor intermediado. Com o número por QR Code ou pela API oficial direta, a venda sai pela conexão direta com a Meta (conjunto de dados e token), logo acima.",
            )}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="report_via_channel">{t("Enviar vendas pelo canal da conversa")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Sem conexão direta com a Meta, a venda de quem veio de anúncio pode ir pelo canal intermediado do WhatsApp, quando ele já liga o seu conjunto de dados da Meta ao número. Saem para o provedor do canal o valor, a moeda, o telefone do cliente e a conversa. Vem desligado: ligue só se a sua política de privacidade cobre esse uso.",
            )}
          </p>
        </div>
        <Switch
          id="report_via_channel"
          checked={valor}
          disabled={isPending}
          onCheckedChange={mudar}
        />
      </div>
      {!temCanalQueEnvia && (
        <p
          role="status"
          className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
        >
          {t(
            "Nenhum canal desta organização consegue enviar a venda por aqui, então nada sai enquanto isto estiver ligado. Use a conexão direta com a Meta, logo acima, ou desligue a chave.",
          )}
        </p>
      )}
    </Card>
  );
}

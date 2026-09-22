"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { precoParaCentavos } from "@/lib/schemas/produtos";
import type { Contact } from "@/lib/types/contacts";
import { comoMoeda } from "@/lib/format/moeda";

/**
 * Aba FINANCEIRO da ficha 360° — limite de crédito e condição padrão.
 *
 * Editar é `manager` na TELA (cortesia): a rota de PATCH de contatos é
 * agent+ por desenho (vale para todos os campos do contato), e afunilar só o
 * crédito exigiria granularidade que aquela rota não tem. O que REALMENTE
 * protege o dinheiro é o bloqueio no POST/PATCH de pedidos — esse é
 * server-side e não depende desta tela.
 */
export function FinanceiroDoContato({
  contato,
  podeEditar,
  aoSalvar,
}: {
  contato: Contact;
  podeEditar: boolean;
  aoSalvar: () => void;
}) {
  const t = useT();
  const [limiteTexto, setLimiteTexto] = React.useState(
    contato.limite_credito_cents !== null
      ? (contato.limite_credito_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })
      : "",
  );
  const [condicao, setCondicao] = React.useState(contato.condicao_pagamento ?? "");
  const [salvando, setSalvando] = React.useState(false);

  async function salvar() {
    const limite = limiteTexto.trim() === "" ? null : precoParaCentavos(limiteTexto);
    if (limiteTexto.trim() !== "" && limite === null) {
      toast.error(t("Limite inválido. Escreva assim: 5.000,00"));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/contacts/${contato.id}`, {
        limite_credito_cents: limite,
        condicao_pagamento: condicao.trim() === "" ? null : condicao.trim(),
      });
      toast.success(t("Financeiro salvo"));
      aoSalvar();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="limite">{t("Limite de crédito (R$)")}</Label>
          <Input
            id="limite"
            value={limiteTexto}
            onChange={(e) => setLimiteTexto(e.target.value)}
            placeholder={t("Vazio = sem limite")}
            disabled={!podeEditar}
          />
          <p className="text-xs text-muted-foreground">
            {t("Acima disto, pedido novo é barrado — salvo override de gerente.")}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="condicao-fin">{t("Condição padrão")}</Label>
          <Input
            id="condicao-fin"
            value={condicao}
            onChange={(e) => setCondicao(e.target.value)}
            placeholder={t("Ex.: 30/60/90 dias")}
            disabled={!podeEditar}
          />
        </div>
      </div>
      {contato.limite_credito_cents !== null && (
        <p className="text-sm">
          {t("Limite atual")}:{" "}
          <strong>{comoMoeda(contato.limite_credito_cents, "BRL")}</strong>
        </p>
      )}
      {podeEditar && (
        <Button onClick={salvar} disabled={salvando}>
          {t(salvando ? "Salvando…" : "Salvar financeiro")}
        </Button>
      )}
    </Card>
  );
}

/**
 * Contas a receber do cliente — resumo vivo (aberto + vencido) com atalho
 * para a central. O crédito acima é política; isto aqui é posição.
 */
export function ContasDoCliente({ contactId }: { contactId: string }) {
  const t = useT();
  const [resumo, setResumo] = React.useState<{ aberto_cents: number; vencido_cents: number; qtd: number } | null>(null);

  React.useEffect(() => {
    let vivo = true;
    apiClient
      .get<{
        data: { saldo_cents: number; situacao: string }[];
      }>(`/api/v1/financeiro/recebiveis?contact_id=${contactId}&limit=200`)
      .then((r) => {
        if (!vivo) return;
        const linhas = r.data ?? [];
        setResumo({
          aberto_cents: linhas.filter((l) => l.situacao !== "pago" && l.situacao !== "cancelado").reduce((s, l) => s + l.saldo_cents, 0),
          vencido_cents: linhas.filter((l) => l.situacao === "vencido").reduce((s, l) => s + l.saldo_cents, 0),
          qtd: linhas.length,
        });
      })
      .catch(() => vivo && setResumo({ aberto_cents: 0, vencido_cents: 0, qtd: 0 }));
    return () => {
      vivo = false;
    };
  }, [contactId]);

  if (resumo === null || resumo.qtd === 0) return null;
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-1 p-4 text-sm">
      <p>
        <span className="text-muted-foreground">{t("Em aberto")}: </span>
        <strong className="tabular-nums">{comoMoeda(resumo.aberto_cents, "BRL")}</strong>
      </p>
      {resumo.vencido_cents > 0 && (
        <p>
          <span className="text-muted-foreground">{t("Vencido")}: </span>
          <strong className="tabular-nums text-error-fg">{comoMoeda(resumo.vencido_cents, "BRL")}</strong>
        </p>
      )}
      <Link href="/app/financeiro" className="ml-auto text-sm underline underline-offset-4">
        {t("Ver financeiro")}
      </Link>
    </Card>
  );
}

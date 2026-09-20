"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { apiClient } from "@/lib/api/client";
import type { PendingAiUsage, ReconciliationList } from "@/lib/billing/reconciliation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
const endpoint = "/api/v1/admin/billing/reconciliation";
const brl = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
export function AiReconciliation() {
  const t = useT();
  const dateLocale = useTagDeIdioma();
  const client = useQueryClient();
  const [after, setAfter] = useState<string | null>(null);
  const [selected, setSelected] = useState<PendingAiUsage | null>(null);
  const [cost, setCost] = useState("");
  const [reference, setReference] = useState("");
  const [verified, setVerified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const costInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selected) costInput.current?.focus();
  }, [selected]);
  const query = useQuery({
    queryKey: ["admin", "ai-reconciliation", after],
    queryFn: () =>
      apiClient
        .get<{ data: ReconciliationList }>(
          endpoint + (after ? "?after=" + encodeURIComponent(after) : ""),
        )
        .then((r) => r.data),
  });
  function open(item: PendingAiUsage) {
    setSelected(item);
    setCost("");
    setReference("");
    setVerified(false);
    setError("");
    setSuccess("");
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || saving) return;
    const normalized = cost.trim().replace(",", ".");
    const cents = Math.round(Number(normalized) * 1_000_000) / 10_000;
    if (
      !/^\d+(?:\.\d{1,6})?$/.test(normalized) ||
      !Number.isFinite(cents) ||
      reference.trim().length < 10 ||
      !verified
    ) {
      setError(t("Informe o custo em dólares, a referência da consulta e confirme a verificação."));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await apiClient.post<{ data: { charged_brl_cents: string } }>(endpoint, {
        reservation_id: selected.id,
        cost_usd_cents: cents,
        reference: reference.trim(),
        verified: true,
      });
      setSuccess(
        t("Conciliação confirmada. Valor aplicado à franquia:") +
          " " +
          brl(Number(response.data.charged_brl_cents)),
      );
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["admin", "ai-reconciliation"] });
      void client.invalidateQueries({ queryKey: ["admin", "usage"] });
    } catch {
      setError(
        t(
          "Não foi possível confirmar. Os dados foram preservados. Atualize a lista antes de tentar novamente.",
        ),
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="space-y-4 rounded-xl border p-5" aria-labelledby="ai-review-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ai-review-title" className="text-lg font-semibold">
            {t("Consumos em conferência")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Confira o custo no provedor antes de liberar a reserva. Esta ação não gera cobrança extra.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={query.isFetching || saving}
          onClick={() => void query.refetch()}
        >
          {t("Atualizar lista")}
        </Button>
      </div>
      {success && (
        <p role="status" className="text-sm">
          {success}{" "}
          <Link className="underline" href="/admin/audit">
            {t("Ver auditoria")}
          </Link>
        </p>
      )}
      {query.isLoading ? (
        <p role="status">{t("Carregando consumos…")}</p>
      ) : query.isError ? (
        <p role="alert">{t("Não foi possível carregar os consumos. Tente atualizar a lista.")}</p>
      ) : (
        <>
          {query.data?.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("Nenhum consumo em conferência nesta página.")}
            </p>
          ) : (
            <ul className="divide-y">
              {query.data?.items.map((item) => (
                <li key={item.id} className="space-y-2 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{item.company}</p>
                      <p className="text-sm break-words text-muted-foreground">
                        {item.provider ?? t("Provedor não identificado")} ·{" "}
                        {item.model ?? t("Modelo não identificado")}
                      </p>
                      <p className="text-sm">
                        {t("Reserva:")} {brl(Number(item.reserved_brl_cents))}
                      </p>
                    </div>
                    {query.data?.can_resolve && (
                      <Button
                        variant="outline"
                        disabled={saving || !item.provider || !item.model}
                        onClick={() => open(item)}
                      >
                        {t("Conferir consumo")}
                      </Button>
                    )}
                  </div>
                  <details className="text-sm">
                    <summary className="cursor-pointer">{t("Ver referências da chamada")}</summary>
                    <p className="mt-2 break-all">
                      {t("Reserva:")} {item.id}
                    </p>
                    <p>
                      {t("Ciclo:")} {new Date(item.period_start).toLocaleDateString(dateLocale)} –{" "}
                      {new Date(item.period_end).toLocaleDateString(dateLocale)}
                    </p>
                    {item.usage_evidence?.steps.length ? (
                      <ul>
                        {item.usage_evidence.steps.map((step, index) => (
                          <li key={index} className="mt-2 break-all">
                            {t("Etapa")} {index + 1}:{" "}
                            {step.responseId ?? t("Referência não retornada")} · {t("Entrada:")}{" "}
                            {step.inputTokens ?? "—"} · {t("Saída:")} {step.outputTokens ?? "—"}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        {t(
                          "O provedor não retornou evidência completa. Não estime o custo pelos horários ou pelo texto da resposta.",
                        )}
                      </p>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            {after && (
              <Button variant="outline" disabled={saving} onClick={() => setAfter(null)}>
                {t("Primeira página")}
              </Button>
            )}
            {query.data?.next_cursor && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => setAfter(query.data!.next_cursor)}
              >
                {t("Próximos consumos")}
              </Button>
            )}
          </div>
        </>
      )}
      {selected && (
        <form
          onSubmit={submit}
          className="space-y-4 rounded-lg bg-muted/40 p-4"
          aria-label={t("Conferir consumo")}
        >
          <h3 className="font-medium">
            {selected.company} · {t("Confirmar custo apurado")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(
              "Some todas as etapas desta execução conforme a consulta ao provedor. Use zero somente se a ausência de custo foi comprovada.",
            )}
          </p>
          <div className="space-y-2">
            <Label htmlFor="review-cost">{t("Custo confirmado no provedor (US$)")}</Label>
            <Input
              id="review-cost"
              ref={costInput}
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              disabled={saving}
              placeholder="0,0125"
              required
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {t("Tarifa do ciclo:")} {brl(Number(selected.usd_to_brl_rate) * 100)}{" "}
            {t("por US$ 1. O desconto respeita o saldo disponível do ciclo original.")}
          </p>
          <div className="space-y-2">
            <Label htmlFor="review-reference">{t("Referência da verificação no provedor")}</Label>
            <Input
              id="review-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              minLength={10}
              maxLength={1000}
              disabled={saving}
              required
            />
            <p className="text-sm text-muted-foreground">
              {t(
                "Identifique o relatório ou consulta e as chamadas verificadas. Não inclua chaves, mensagens ou dados de clientes.",
              )}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
              disabled={saving}
              required
            />
            {t(
              "Conferi todas as chamadas desta execução no provedor e confirmo o valor informado.",
            )}
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? t("Confirmando…") : t("Confirmar conciliação")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setSelected(null)}
            >
              {t("Cancelar")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StudioShell, Intro, Notice, Loading, Empty, studioApi } from "./_shared";
type Result = {
  connected: boolean;
  accounts: { id: string; name: string }[];
  insights?: {
    dateRange: { since: string; until: string };
    metrics: Record<string, { total: number }>;
  };
  checked_at?: string;
};
const metrics = [
  { key: "reach", title: "Pessoas alcançadas", description: "Quantas contas viram seu conteúdo." },
  { key: "views", title: "Visualizações", description: "Quantas vezes seu conteúdo foi visto." },
  {
    key: "accounts_engaged",
    title: "Pessoas que interagiram",
    description: "Contas que tiveram alguma interação.",
  },
  {
    key: "total_interactions",
    title: "Interações",
    description: "Ações registradas no seu conteúdo.",
  },
];
export function Insights() {
  const t = useT();
  const locale = useTagDeIdioma();
  const [data, setData] = useState<Result | null>(null);
  const [account, setAccount] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const load = useCallback(async (id?: string) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await studioApi<Result>(
        `/insights${id ? `?account_id=${encodeURIComponent(id)}` : ""}`,
      );
      if (sequence !== requestSequence.current) return;
      setData(result);
      if (!id && result.accounts.length === 1 && result.accounts[0])
        setAccount(result.accounts[0].id);
    } catch (e) {
      if (sequence !== requestSequence.current) return;
      setError(e instanceof Error ? e.message : "Não foi possível consultar.");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (account) void load(account);
    }, 0);
    return () => clearTimeout(timer);
  }, [account, load]);
  return (
    <StudioShell>
      <Intro eyebrow={t("Meus resultados")} title={t("Entenda o que está chegando às pessoas.")}>
        {t(
          "Resultados reais da conta conectada, nos últimos 30 dias. Os dados podem levar até 48 horas para atualizar.",
        )}
      </Intro>
      {error && (
        <Notice error>
          {error}{" "}
          <button className="underline" onClick={() => void load(account || undefined)}>
            {t("Tentar novamente")}
          </button>
        </Notice>
      )}
      {loading ? (
        <Loading />
      ) : data && !data.connected ? (
        <Empty
          title={t("Conecte sua conta para ver os resultados.")}
          href="/app/connections?aba=sociais"
          label={t("Conectar Instagram")}
        >
          {t(
            "A criação de imagens continua disponível. Para consultar as métricas, conecte sua conta profissional e autorize o acesso aos resultados.",
          )}
        </Empty>
      ) : data?.connected ? (
        <section className="space-y-8">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label htmlFor="insight-account" className="mb-2 block text-sm font-medium">
                {t("Conta do Instagram")}
              </label>
              <select
                id="insight-account"
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setData((d) => (d ? { ...d, insights: undefined } : d));
                }}
                className="min-h-11 max-w-full rounded-xl border border-border bg-background px-3"
              >
                <option value="">{t("Escolha a conta")}</option>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.name}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="outline" disabled={!account} onClick={() => void load(account)}>
              {t("Atualizar resultados")}
            </Button>
          </div>
          {data.insights && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("Período:")}
                {data.insights.dateRange.since} a {data.insights.dateRange.until}
              </p>
              <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
                {metrics.map((m) => (
                  <div key={m.key} className="border-b border-border pb-7">
                    <dt className="font-medium">{t(m.title)}</dt>
                    <dd className="my-3 font-serif text-5xl tabular-nums">
                      {data.insights?.metrics[m.key]?.total === undefined
                        ? "—"
                        : data.insights.metrics[m.key]?.total.toLocaleString(locale)}
                    </dd>
                    <p className="text-sm text-muted-foreground">
                      {data.insights?.metrics[m.key]?.total === undefined
                        ? t("A conta não disponibilizou essa métrica neste período.")
                        : t(m.description)}
                    </p>
                  </div>
                ))}
              </dl>
              <Notice>
                {t(
                  "Use o alcance para avaliar a distribuição do conteúdo e as interações para entender a resposta do público. Esses números, sozinhos, não comprovam vendas.",
                )}
              </Notice>
            </>
          )}
        </section>
      ) : null}
    </StudioShell>
  );
}

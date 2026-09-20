import type { AiAllowanceView } from "@/lib/billing/ai-allowance-view";
import { formatBRL } from "@/lib/billing/plans";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function AiAllowanceCard({ balance, idioma }: { balance: AiAllowanceView; idioma: Idioma }) {
  const t = (text: string) => traduzir(text, idioma);
  const date = (value: string) =>
    new Intl.DateTimeFormat(idioma, { dateStyle: "short", timeZone: "UTC" }).format(
      new Date(value),
    );
  const notice =
    balance.status === "review"
      ? "O uso de IA está pausado enquanto conferimos um consumo anterior. Seu saldo foi preservado."
      : balance.status === "inactive"
        ? "Este saldo não está liberado para uso. Confira a situação da sua assinatura."
        : balance.remaining === 0
          ? "O saldo está usado ou reservado por atendimentos em andamento. Não haverá cobrança automática de excedente."
          : null;
  return (
    <section
      aria-label={t("Sua franquia de IA")}
      className="space-y-5 rounded-3xl border bg-card p-6 sm:p-8"
    >
      <div>
        <h2 className="font-serif text-2xl">{t("Sua franquia de IA")}</h2>
        {balance.periodStart && balance.periodEnd && (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Ciclo:")} {date(balance.periodStart)} — {date(balance.periodEnd)}
          </p>
        )}
      </div>
      {balance.status === "unconfirmed" ? (
        <p role="status">{t("O saldo aparecerá após a confirmação do ciclo da assinatura.")}</p>
      ) : (
        <>
          <div>
            <p className="text-sm text-muted-foreground">{t("Saldo restante")}</p>
            <p className="mt-1 text-4xl font-semibold tracking-tight">
              {formatBRL(balance.remaining)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("Franquia do ciclo:")} {formatBRL(balance.budget)}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-4 border-y py-4">
            <div>
              <dt className="text-sm text-muted-foreground">{t("Já utilizado")}</dt>
              <dd className="mt-1 font-medium">{formatBRL(balance.used)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("Reservado")}</dt>
              <dd className="mt-1 font-medium">{formatBRL(balance.reserved)}</dd>
            </div>
          </dl>
          {notice && (
            <p role="status" className="rounded-xl bg-muted p-3 text-sm">
              {t(notice)}
            </p>
          )}
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {t(
              "Enquanto a IA atende, parte do saldo fica reservada. Ao concluir, descontamos o consumo e liberamos a diferença.",
            )}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("Tarifa fixa deste ciclo:")} {formatBRL(balance.rate * 100)}{" "}
            {t("por US$ 1 de consumo de IA. Sem cobrança automática de excedente.")}
          </p>
        </>
      )}
    </section>
  );
}

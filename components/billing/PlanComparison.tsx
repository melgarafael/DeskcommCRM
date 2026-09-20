import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { SUBSCRIPTION_PLANS, formatBRL } from "@/lib/billing/plans";

/** Presentation only: a selection must never be mistaken for a paid subscription. */
export function PlanComparison({ idioma }: { idioma: Idioma }) {
  const t = (text: string) => traduzir(text, idioma);
  return (
    <section aria-label={t("Planos de assinatura")} className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-3">
        {SUBSCRIPTION_PLANS.map((plan) => (
          <article key={plan.id} className="flex flex-col rounded-3xl border bg-card p-6 sm:p-8">
            <h2 className="font-serif text-3xl">{t(plan.name)}</h2>
            <p className="mt-3 min-h-12 text-sm text-muted-foreground">{t(plan.description)}</p>
            <p className="my-6">
              <strong className="text-4xl tracking-tight">
                {formatBRL(plan.monthly_price_cents)}
              </strong>
              <span className="text-sm text-muted-foreground"> {t("/ mês")}</span>
            </p>
            <ul className="mb-6 flex-1 space-y-3 text-sm">
              <li>
                {plan.seats} {t("pessoas na equipe")}
              </li>
              <li>
                {plan.channels}{" "}
                {plan.channels === 1 ? t("canal conectado") : t("canais conectados")}
              </li>
              <li>
                {plan.agents} {t("Agentes de IA")}
              </li>
              <li>
                {formatBRL(plan.ai_credit_cents)} {t("de franquia de IA por mês")}
              </li>
              <li>{t("Inbox, contatos, funis e agenda")}</li>
            </ul>
            <p className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">
              {t("Contratação em preparação")}
            </p>
          </article>
        ))}
      </div>
      <div className="max-w-3xl space-y-3 text-sm leading-6 text-muted-foreground">
        <p>
          {t(
            "Mensalidade em reais. A franquia de IA é compartilhada pelos agentes da empresa e varia conforme o modelo e o volume de texto. Não representa uma quantidade garantida de mensagens.",
          )}
        </p>
        <p>
          {t(
            "Tarifas cobradas pela Meta e por outros provedores de canal são separadas. A conexão do Instagram depende das permissões e da aprovação da Meta.",
          )}
        </p>
        <p>
          {t(
            "Estes são os novos planos. Sua conta e seus acessos atuais permanecem como estão até a contratação ser concluída.",
          )}
        </p>
      </div>
    </section>
  );
}

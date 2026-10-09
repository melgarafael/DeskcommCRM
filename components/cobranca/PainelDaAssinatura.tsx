import { Card } from "@/components/ui/card";
import type { DadosDoPainel } from "@/lib/cobranca/painel";
import { formatadorDeData } from "@/lib/cobranca/fuso";
import { ROTULO_DO_ESTADO } from "@/lib/cobranca/rotulos";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * O painel da assinatura da empresa (spec da cobrança §9), só leitura na PR 2.
 * Sem hooks: é desenhado pelo servidor, no idioma de quem abriu.
 */
export function PainelDaAssinatura({ dados, idioma }: { dados: DadosDoPainel; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const data = formatadorDeData(idioma, dados.fuso, { dateStyle: "short" });
  const brl = new Intl.NumberFormat(idioma, { style: "currency", currency: "BRL" });
  const usd = new Intl.NumberFormat(idioma, { style: "currency", currency: "USD" });
  // "2 de 3"; sem teto, "2 · sem limite" (e não "2 de sem limite").
  const deLimite = (usados: string, limite: string | null) =>
    limite === null
      ? `${usados} · ${t("sem limite")}`
      : t("{usados} de {limite}").replace("{usados}", usados).replace("{limite}", limite);
  const limite = (n: number | null) => (n === null ? null : String(n));

  if (!dados.assinatura || !dados.plano) {
    return (
      <Card className="max-w-xl p-6">
        <h2 className="text-sm font-semibold">{t("Seu plano")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Sua empresa não tem plano de cobrança: não paga e não tem limites.")}
        </p>
      </Card>
    );
  }

  const { assinatura: a, plano: p, uso } = dados;
  const dia = (v: string | null) => (v ? data.format(new Date(v)) : "");
  const situacao = situacaoDaAssinatura(a, t, dia);

  return (
    <Card className="max-w-xl space-y-4 p-6">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold">
          {t("Seu plano")}: {p.nome}
        </h2>
        <p className="text-sm text-muted-foreground">
          {brl.format(p.preco_cents / 100)} {p.intervalo === "mes" ? t("por mês") : t("por ano")}
        </p>
      </div>
      <p className="text-sm font-medium">{situacao}</p>
      {a.plano_agendado && (
        <p className="text-sm">
          {t("Novo plano a partir de")} {dia(a.proximo_vencimento)}: {a.plano_agendado.nome}
        </p>
      )}
      {a.modo === "teste" && <p className="text-xs text-warning-fg">{t("Modo de teste: nenhum pagamento aqui é real.")}</p>}
      {a.prazo_extra_ate && (
        <p className="text-sm">
          {t("Prazo extra até")} {data.format(new Date(a.prazo_extra_ate))}
        </p>
      )}
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt>{t("Pessoas")}</dt>
        <dd data-uso="assentos">{deLimite(String(uso.assentos), limite(p.max_assentos))}</dd>
        <dt>{t("Números conectados")}</dt>
        <dd data-uso="canais">{deLimite(String(uso.canais), limite(p.max_canais))}</dd>
        <dt>{t("Uso de IA no mês")}</dt>
        <dd data-uso="ia">
          {deLimite(
            usd.format(dados.gastoIaUsdCents / 100),
            p.teto_ia_usd_cents === null ? null : usd.format(p.teto_ia_usd_cents / 100),
          )}
        </dd>
      </dl>
    </Card>
  );
}

/** A situação em linguagem simples (spec §9). Uma função, para a tela e o hub dizerem a mesma coisa. */
function situacaoDaAssinatura(
  a: NonNullable<DadosDoPainel["assinatura"]>,
  t: (texto: string) => string,
  dia: (v: string | null) => string,
): string {
  switch (a.estado) {
    case "trial":
      if (!a.trial_ate) return t(ROTULO_DO_ESTADO.trial);
      return `${t("Teste grátis até")} ${dia(a.trial_ate)}${a.assinaturas_vivas > 0 ? ` · ${t("1ª cobrança agendada")}` : ""}`;
    case "ativa":
      return a.cancela_no_fim && a.proximo_vencimento ? `${t("Cancelada, acesso até")} ${dia(a.proximo_vencimento)}` : t(ROTULO_DO_ESTADO.ativa);
    case "em_atraso":
      return a.vencida_desde ? `${t("Em atraso desde")} ${dia(a.vencida_desde)}` : t(ROTULO_DO_ESTADO.em_atraso);
    case "cancelada":
      return a.proximo_vencimento && Date.parse(a.proximo_vencimento) > Date.now()
        ? `${t("Cancelada, acesso até")} ${dia(a.proximo_vencimento)}`
        : t(ROTULO_DO_ESTADO.cancelada);
  }
}

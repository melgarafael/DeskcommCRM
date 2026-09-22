import { comoMoeda } from "@/lib/format/moeda";
import type { DadosIndicadores } from "./_indicadores";

/**
 * Cabeçalho orientado a decisão: saudação + resumo operacional do dia.
 * Server component — só desenha os agregados que a página já calculou.
 */
export function Saudacao({
  nome,
  hora,
  dados,
}: {
  nome: string | null;
  hora: number;
  dados: DadosIndicadores;
}) {
  const cumprimento =
    hora >= 5 && hora < 12 ? "Bom dia" : hora >= 12 && hora < 18 ? "Boa tarde" : "Boa noite";
  const primeiro = nome?.trim().split(/\s+/)[0];
  const ticket = dados.qtdMes > 0 ? dados.vendidoMes / dados.qtdMes : null;

  const itens = [
    {
      rotulo: "Vendido hoje",
      valor: comoMoeda(dados.vendidoHoje, "BRL"),
      detalhe: `${dados.qtdMes} pedidos no mês`,
    },
    {
      rotulo: "Vendido no mês",
      valor: comoMoeda(dados.vendidoMes, "BRL"),
      detalhe:
        ticket != null
          ? `ticket médio ${comoMoeda(Math.round(ticket), "BRL")}`
          : "sem pedidos ainda",
    },
    {
      rotulo: "Meta",
      valor: dados.objetivo != null ? `${dados.pctObjetivo?.toFixed(0) ?? "0"}%` : "Sem meta",
      detalhe:
        dados.necessarioDia != null
          ? `faltam ${comoMoeda(Math.round(dados.necessarioDia), "BRL")}/dia útil`
          : "defina em Relatórios",
    },
    {
      rotulo: "Previsão de fechamento",
      valor: comoMoeda(dados.previsaoMes, "BRL"),
      detalhe: `${dados.diasUteisRestantes} dias úteis restantes`,
    },
  ];

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-medium tracking-tight text-text">
          {cumprimento}
          {primeiro ? `, ${primeiro}` : ""}.
        </h1>
        <p className="text-sm text-muted-foreground">
          {dados.rotuloMes} · Vendido, carteira, ranking e curva ABC.
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {itens.map((item) => (
          <div
            key={item.rotulo}
            className="rounded-lg border border-border bg-surface px-4 py-3 shadow-xs"
          >
            <dt className="text-xs text-muted-foreground uppercase">{item.rotulo}</dt>
            <dd className="mt-0.5 text-xl font-semibold text-text tabular-nums">{item.valor}</dd>
            <dd className="text-xs text-muted-foreground">{item.detalhe}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

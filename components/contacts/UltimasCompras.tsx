"use client";

import { format } from "date-fns";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useUltimasCompras } from "@/hooks/contacts/useUltimasCompras";
import type { CompraDoContato } from "@/lib/leads/compras-do-contato";
import { ArrowRight } from "@/lib/ui/icons";

/**
 * "Últimas compras" do contato (issue #3179), no painel do Inbox e na ficha.
 *
 * O que o cliente JÁ comprou — negócios ganhos do contato em TODOS os funis: data
 * do ganho, título, valor, mais os campos que a organização escolheu (lidos dos
 * campos personalizados do negócio) e o atalho para abrir o negócio.
 *
 * O atalho usa a ROTA ESTÁVEL `/app/leads/<id>` (lição do #3062): ela resolve o
 * funil na hora e redireciona o quadro para o card. Montar a URL do quadro aqui
 * apontaria para o funil de ONTEM no dia em que o negócio mudasse de funil.
 *
 * O componente é BURRO de propósito (recebe a lista por prop): a montagem em teste
 * injeta o dublê e mede o DOM sem subir banco.
 */
export function UltimasCompras({
  compras,
  erro = false,
  onTentarDeNovo,
}: {
  compras: CompraDoContato[];
  erro?: boolean;
  onTentarDeNovo?: () => void;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();

  // Leitura que FALHA não vira "sem compras" — é o defeito que o painel inteiro
  // combate: dizer que o cliente não comprou nada em cima de um erro de leitura.
  if (erro) {
    return (
      <section data-testid="ultimas-compras">
        <h3 className="text-xs font-semibold text-text">{t("Últimas compras")}</h3>
        <div className="mt-2 space-y-1">
          <p className="text-xs text-error-fg">{t("Não consegui ler as compras.")}</p>
          {onTentarDeNovo && (
            <Button size="sm" variant="outline" onClick={onTentarDeNovo}>
              {t("Tentar de novo")}
            </Button>
          )}
        </div>
      </section>
    );
  }

  // Contato sem compra ganha não desenha a seção: um bloco vazio ao lado dos
  // negócios leria como tela quebrada, não como "ainda não comprou".
  if (compras.length === 0) return null;

  return (
    <section data-testid="ultimas-compras">
      <h3 className="text-xs font-semibold text-text">{t("Últimas compras")}</h3>
      <ul className="mt-2 space-y-1.5">
        {compras.map((compra) => (
          <li
            key={compra.id}
            data-testid={`compra-${compra.id}`}
            className="rounded-md border border-border p-2 text-xs"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-medium" data-testid="compra-titulo">
                {compra.title}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground" data-testid="compra-valor">
                {formatMoney(compra.value_cents, compra.currency)}
              </span>
            </div>
            {compra.closed_at && (
              <div className="mt-0.5 text-muted-foreground" data-testid="compra-data">
                {t("Ganho em {data}").replace(
                  "{data}",
                  format(new Date(compra.closed_at), "dd/MM/yyyy", { locale: localeDaData }),
                )}
              </div>
            )}
            {compra.campos.length > 0 && (
              <dl className="mt-1 space-y-0.5">
                {compra.campos.map((campo) => (
                  <div key={campo.chave} className="flex gap-1" data-testid={`compra-campo-${campo.chave}`}>
                    <dt className="shrink-0 text-muted-foreground">{campo.rotulo}:</dt>
                    <dd className="min-w-0 truncate">{campo.valor}</dd>
                  </div>
                ))}
              </dl>
            )}
            <Button asChild size="sm" variant="ghost" className="mt-1 h-7 px-2 text-xs">
              <Link href={`/app/leads/${compra.id}`} data-testid={`compra-abrir-${compra.id}`}>
                {t("Abrir negócio")}
                <ArrowRight size={12} className="ml-1" weight="regular" aria-hidden />
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A seção ligada à rota — é o que o painel do Inbox e a ficha montam. A busca e o
 * desenho ficam em peças separadas para a montagem em teste injetar só a lista.
 */
export function UltimasComprasDoContato({ contactId }: { contactId: string }) {
  const q = useUltimasCompras(contactId);
  // Enquanto carrega, nada: a seção não é a primeira pergunta da tela, e um
  // esqueleto a mais no painel (que já tem vários) viraria ruído.
  if (q.isLoading) return null;
  return (
    <UltimasCompras
      compras={q.data ?? []}
      erro={q.isError}
      onTentarDeNovo={() => void q.refetch()}
    />
  );
}

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  const cur = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${cur}`;
  }
}

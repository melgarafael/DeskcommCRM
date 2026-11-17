"use client";

import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { ajudaDoPapel } from "@/lib/ajuda/papel";

/**
 * "O QUE O SEU PAPEL PODE FAZER" (issue #3567, fatia F2).
 *
 * Fica ACIMA do índice: a pessoa chega sabendo o que pode, e só então desce
 * para o atalho da tarefa. Sem papel resolvido (instalação sem vínculo, papel
 * de máquina ou papel desconhecido) o bloco simplesmente não renderiza — o
 * índice abaixo continua valendo.
 *
 * `destinos` é a MESMA lista que filtra o índice (`destinosDaInterface`): um
 * atalho só aparece se a porta existe no menu desta pessoa. Sem isso o bloco
 * ofereceria link para tela que a empresa escondeu.
 */
export function BlocoDoPapel({
  papel,
  destinos,
}: {
  papel: string | null | undefined;
  destinos: readonly { href: string }[];
}) {
  const t = useT();
  const ajuda = ajudaDoPapel(papel);
  if (!ajuda) return null;

  const visiveis = new Set(destinos.map((destino) => destino.href));
  const poderes = ajuda.poderes.filter((item) => visiveis.has(item.href));

  return (
    <section
      data-testid="ajuda-do-papel"
      aria-labelledby="ajuda-do-papel-titulo"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <div>
        <h2
          id="ajuda-do-papel-titulo"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {t("O que o seu papel pode fazer")}
        </h2>
        <p className="mt-1 text-sm">{t(ajuda.resumo)}</p>
      </div>

      <ul className="flex flex-col divide-y">
        {poderes.map((item) => (
          <li key={item.href} className="py-1.5">
            <Link
              href={item.href}
              className="text-sm font-medium hover:underline"
              data-testid={`ajuda-papel-${item.href.replace(/\//g, "-")}`}
            >
              {t(item.texto)}
            </Link>
          </li>
        ))}
      </ul>

      {ajuda.limites.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("O que este papel não abre")}
          </h3>
          <ul className="mt-1 flex flex-col gap-1">
            {ajuda.limites.map((item) => (
              <li key={item.href} data-testid={`ajuda-limite-${item.href.replace(/\//g, "-")}`}>
                <span className="text-sm text-muted-foreground">{t(item.texto)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

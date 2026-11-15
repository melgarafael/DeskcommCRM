import Link from "next/link";
import type { ReactNode } from "react";

import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * O cabeçalho comum das SUBTELAS de Configurações.
 *
 * ─── Por que ele existe ────────────────────────────────────────────────────
 *
 * `/app/settings` é o índice, e as subtelas (Tags, Marca, Notificações…) não
 * tinham caminho de volta: quem entrava numa delas só saía reabrindo
 * Configurações pelo menu. Escrever o link uma vez não resolve — cada subtela
 * nova esquece dele. Por isso o caminho de volta mora aqui, num lugar só, e
 * `tests/unit/volta-das-subtelas-de-configuracoes.test.ts` reprova a tela que
 * não usar este cabeçalho.
 *
 * ─── O que ele NÃO faz ─────────────────────────────────────────────────────
 *
 * Não decide layout e não desenha a tela: só põe o caminho de volta acima do
 * título. `titulo` é opcional porque algumas subtelas delegam o corpo a um
 * `_client` que já rende o próprio `<h1>` — nelas o cabeçalho só rende o link,
 * e o título não aparece duas vezes.
 *
 * O rótulo sai do dicionário: texto solto no JSX continuaria em português para
 * quem escolheu espanhol.
 */
export function CabecalhoDaSubTela({
  titulo,
  idioma,
  className,
  tituloClassName = "text-2xl font-semibold tracking-tight",
  children,
}: {
  /** Título da subtela — já traduzido por quem conhece o idioma da sessão. */
  titulo?: ReactNode;
  idioma: Idioma;
  /** Classe do `<header>`, para a tela que já tinha um espaçamento próprio. */
  className?: string;
  /** Classe do `<h1>`, para a tela que já usava outro tamanho de título. */
  tituloClassName?: string;
  children?: ReactNode;
}) {
  return (
    <header className={className}>
      <Link
        href="/app/settings"
        data-testid="voltar-para-configuracoes"
        className="mb-2 flex w-fit items-center gap-1 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        <span aria-hidden="true">←</span>
        {traduzir("Voltar para Configurações", idioma)}
      </Link>
      {titulo != null ? <h1 className={tituloClassName}>{titulo}</h1> : null}
      {children}
    </header>
  );
}

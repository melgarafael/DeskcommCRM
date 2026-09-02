"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  return (
    /*
      A barra em PAPER, com o bloco da marca seguindo escuro.

      `data-superficie="clara"` no proprio <header> — o mesmo atributo das telas
      de conteudo, e nao um punhado de classes soltas. Com ele os tokens desta
      subarvore passam a resolver na superficie clara, e TUDO o que vive aqui
      dentro acompanha sem ser tocado: `bg-background` vira Paper, `--color-text`
      vira Ink, e os filhos (busca, sino, seletor de idioma, avatar) ja pintam
      com `text-muted-foreground`/`text-foreground`, que a superficie redeclara.
      Nenhum deles tem cor cravada — conferido antes de escrever isto.

      O `border-b` volta, e agora ele e o cinza claro da superficie
      (`--color-border` = #dfe2e8) em vez do #304770 do tema escuro que virou
      um fio azul sobre o Paper. E a divisoria discreta que faltava.

      `bg-surface` — BRANCO PURO, um degrau acima do Paper do conteudo.

      Nao e um hex cravado: na superficie clara `--color-surface` JA e #ffffff
      (o branco do cartao, contra o #f4f5f7 do fundo). Usar o token em vez da
      cor literal e o que mantem a barra dentro da mesma estrutura do resto e a
      faz acompanhar se a superficie for reajustada um dia.

      A barra passa a ler como uma superficie ELEVADA sobre o Paper — que e o
      que ela e: fixa, sempre por cima do conteudo que rola por baixo.

      O `border-b` continua em `--color-border` (#dfe2e8). Ele fica MAIS escuro
      que os dois lados que separa (branco em cima, Paper embaixo), entao segue
      lendo como divisoria mesmo com o degrau de tom agora sendo sutil — medido
      depois de trocar, nao suposto.

      Antes disto o fundo era `bg-background/95 backdrop-blur`, e ele estava
      TRANSPARENTE.

      Medido no navegador,
      `background-color` do <header> dava `rgba(0, 0, 0, 0)` — o modificador de
      opacidade do Tailwind (`/95`) precisa injetar alfa na cor, e a nossa vem
      como `var(--color-bg)`, um hex atras de uma custom property; a regra que
      ele gera nao resolve e o navegador descarta. A barra parecia escura porque
      o `body` (Ink) aparecia POR TRAS dela, nao porque ela tivesse cor.

      Com o fundo opaco o `backdrop-blur` perdeu a funcao — nao ha mais o que
      borrar atras — entao saiu junto.

            O quadrado do "K" NAO esta aqui e por isso nao muda: ele e o cabecalho da
      SIDEBAR (`components/shell/Sidebar.tsx`), que ocupa a altura inteira da
      janela — inclusive esta primeira linha. A barra comeca onde a sidebar
      termina, entao o bloco de marca continua escuro e com a largura dela sem
      uma linha de codigo a respeito.
    */
    <header
      data-superficie="clara"
      className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b bg-surface px-3 text-text md:gap-4 md:px-6"
    >
      <div className="flex min-w-0 items-center gap-2">
        <MobileSidebar />
        <TenantSwitcher />
      </div>
      <div className="flex min-w-0 flex-1 justify-center md:max-w-md">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}

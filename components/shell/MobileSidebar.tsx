"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import { SidebarContent } from "@/components/shell/Sidebar";
import { DotsThree, List } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A gaveta de navegação do celular.
 *
 * ─── Por que ela tem duas aparências, e não um gatilho parametrizável ───────
 *
 * Há DOIS jeitos de abri-la: o hambúrguer da barra de cima e o "Mais" da barra
 * de abas do rodapé (`components/shell/BarraInferior.tsx`). A primeira versão
 * disto recebia o botão por prop (`gatilho: ReactNode`), e aquilo cegava o gate
 * `tests/unit/controle-decorativo.test.ts`.
 *
 * Aquele gate acusa botão sem `onClick` — o botão mudo, que parece ativo e não
 * faz nada; foi assim que o "Ver na agenda" atravessou a v1.8.0. Uma das
 * exclusões legítimas dele é "o botão está imediatamente dentro de um gatilho
 * `asChild`", porque nesse caso quem dá o comportamento é o pai. Ele mede isso
 * olhando as DUAS LINHAS anteriores ao botão; com o botão vindo por prop, o que
 * está ali é `gatilho={`, a exclusão não casa, e o gate acusou dois botões
 * corretos.
 *
 * (Ele varre o texto cru, comentário inclusive — é por isso que esta prosa fala
 * "botão" em vez de escrever a tag. Escrevê-la aqui faria o gate acusar o
 * próprio comentário que a explica.)
 *
 * Poderia ter afrouxado o gate. Mas a exclusão por prop seria FRACA de verdade —
 * nada garante que quem recebe um `ReactNode` o ligue a um Trigger —, e o botão
 * mudo é defeito que o usuário encontra antes de qualquer teste. Então o literal
 * volta para dentro do `<SheetTrigger asChild>`, onde o gate o vê, e o que varia
 * é só a aparência.
 *
 * ─── O cookie do desktop ────────────────────────────────────────────────────
 *
 * O estado "Recolher" é do sidebar desktop e persiste em cookie. No mobile a
 * navegação é uma gaveta temporária: abrir/fechar não escreve esse cookie, para
 * não trocar a preferência que a pessoa escolheu no laptop.
 */
export function GavetaDeNavegacao({ comoAba = false }: { comoAba?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={comoAba ? undefined : "icon"}
          className={cn(
            comoAba
              ? // Como aba: ocupa a vaga inteira na fila do rodapé, ícone em
                // cima e rótulo embaixo, igual às outras quatro.
                "flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-muted-foreground"
              : // Como hambúrguer: 44px de alvo, e só no celular — acima de `md`
                // a barra lateral já está na tela.
                "h-11 w-11 md:hidden",
          )}
          // Como aba, o nome acessível é o rótulo visível "Mais". Herdar
          // "Abrir navegação" deixava DOIS controles com o mesmo nome na tela de
          // celular (este e o hambúrguer da barra de cima).
          aria-label={comoAba ? undefined : t("Abrir navegação")}
        >
          {comoAba ? <DotsThree size={22} aria-hidden /> : <List size={22} aria-hidden />}
          {comoAba ? (
            <span className="w-full truncate text-center text-[10px] leading-tight">
              {t("Mais")}
            </span>
          ) : null}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-0 p-0 sm:max-w-xs"
      >
        <SheetTitle className="sr-only">{t("Navegação principal")}</SheetTitle>
        <SidebarContent
          collapsed={false}
          showCollapseControl={false}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

/**
 * Navegação mobile do app autenticado — o hambúrguer da barra de cima.
 *
 * Continua existindo ao lado da barra de abas de propósito: a gaveta é o
 * inventário COMPLETO (todos os grupos, todas as telas), e a barra de baixo é
 * atalho para as quatro de uso diário. Tirar o hambúrguer deixaria o resto do
 * produto alcançável só pelo "Mais".
 */
export function MobileSidebar() {
  return <GavetaDeNavegacao />;
}

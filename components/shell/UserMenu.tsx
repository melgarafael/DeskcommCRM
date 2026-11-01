"use client";
import { useTransition } from "react";
import { useUser, useAuth } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";
import { useT } from "@/hooks/i18n/useT";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignOut, ShieldCheck } from "@/lib/ui/icons";

function initials(name: string | null, email: string): string {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const t = useT();
  const user = useUser();
  const { signOut } = useAuth();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-2">
      <SeletorDeIdioma />
      <ThemeToggle />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={`${t("Menu do usuário")}: ${initials(user.full_name, user.email)}`}>
            <Avatar className="h-8 w-8">
              {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
              <AvatarFallback>{initials(user.full_name, user.email)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{user.full_name ?? user.email}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/*
            A PORTA DO MODO ADMINISTRADOR.

            Até aqui só se chegava ao painel da instalação digitando /admin na
            barra de endereços, ou por um item chamado "Gerenciar organizações"
            escondido no seletor de organização — que leva a UMA tela do painel e
            não anuncia que existe um painel.

            Ela não entra em `lib/navigation/registry.ts` de propósito: aquele
            registro descreve a navegação do TENANT (`app/app/**`), e o teste de
            completude varre só aquela raiz — uma entrada para /admin reprovaria
            o CI como link morto. Além disso o registro não sabe expressar "só o
            dono do servidor": o campo `platform` que existe lá é um atalho que
            ABRE tudo para quem é dono, não um cadeado que restringe aos outros.
            Mesmo precedente de `VersionFooter`: porta bespoke, gate próprio.

            O rótulo diz MODO, não "admin": para quem instalou o sistema, o que
            ele quer não é "uma área chamada admin", é "ir para onde eu mexo no
            servidor" — e o subtítulo diz de que servidor se trata.
          */}
          {user.is_platform_admin && (
            <>
              <DropdownMenuItem
                asChild
                /*
                  ⚠️ QUEM NAVEGA É O `onClick` DAQUI, E NÃO O `<Link>`.

                  Medido no CI do #3608 (run 40791878045, job 123178915982): o
                  caso "a porta do modo administrador é achável sem digitar URL"
                  reprovou com a URL em `/app/inbox` — o clique FECHOU o menu
                  (`data-state="closed"` no trace) e **nenhuma** requisição de
                  navegação saiu, nem documento nem `_rsc`. Ou seja: o item foi
                  selecionado e a navegação do `<Link>` se perdeu no meio.

                  O mecanismo é a ORDEM dos handlers: o Next chama o `onClick`
                  que recebe por prop ANTES do `linkClicked` dele (`next/link`
                  16.4.2, `app-dir/link.js`), e esse `onClick` aqui é o do Radix,
                  que termina em `handleSelect` → fecha o menu no meio do MESMO
                  evento. A navegação do `<Link>` é, portanto, a ÚLTIMA coisa a
                  rodar, depois de o menu já ter sido fechado — e foi ela que
                  faltou no CI.

                  Por isso a porta não depende mais dela: não há como provar de
                  fora por que aquele trecho não rodou; há como não depender.
                  `preventDefault` faz o Radix PULAR o `onSelect` (que é quem
                  fecha o menu) e faz o próprio Link desistir no
                  `if (e.defaultPrevented) return` dele; quem leva ao painel é a
                  linha seguinte, uma só vez. O `<a href>` continua ali — clique
                  com ⌘/Ctrl/Shift/Alt ou com o botão do meio não é nosso, e o
                  navegador abre em aba nova como manda o href.
                */
                onClick={(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  ) {
                    return;
                  }
                  event.preventDefault();
                  router.push("/admin");
                }}
              >
                <Link href="/admin" data-testid="porta-modo-administrador">
                  <ShieldCheck size={16} className="mr-2" aria-hidden />
                  <span className="flex flex-col">
                    <span>{t("Modo administrador")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("Configurar este servidor")}
                    </span>
                  </span>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem disabled={isPending} onClick={() => startTransition(async () => { await signOut(); })}>
            <SignOut size={16} className="mr-2" aria-hidden />
            {t("Sair")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

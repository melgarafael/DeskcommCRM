"use client";

import { toast } from "sonner";
import { flushSync } from "react-dom";
import { useOrganizationTransition } from "@/components/shell/OrganizationTransitionProvider";
import { useTransition } from "react";

import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowBendUpLeft, CaretDown } from "@/lib/ui/icons";

/**
 * A VOLTA — o caminho de saída do wizard para quem tem outra organização.
 *
 * ═══ O defeito que isto fecha ═══
 *
 * `app/app/layout.tsx` manda para `/onboarding` toda organização ativa sem
 * `onboarded_at`. Trocar para uma organização recém-criada — pelo seletor no
 * topo, um clique — levava a pessoa para o wizard dela **e tirava o seletor da
 * tela junto**: o layout de `/app` sai inteiro da árvore, e com ele o
 * `TenantSwitcher`.
 *
 * O que sobrava no wizard, medido no snapshot de uma falha do CI: "Termos de
 * Uso", "Política de Privacidade" e um "Continuar" desabilitado. Três controles,
 * nenhum deles uma saída. Quem chegou ali por engano — foi convidado para uma
 * organização nova, trocou para ver o que era — perdia o caminho de volta para
 * a organização onde estava trabalhando, e a única saída real era limpar cookie
 * ou adivinhar a URL de logout.
 *
 * É o invariante "nenhuma demanda sem próximo passo" pelo avesso: a tela pede
 * seis passos de configuração de quem talvez só quisesse espiar, e não oferece
 * a porta de trás. Configurar continua sendo o caminho principal — este botão
 * não o atropela, fica ao lado dele no cabeçalho.
 *
 * A navegação completa após trocar reinicia cache e subscriptions. A guarda
 * visual fica na raiz e sobrevive ao refresh RSC disparado pelo cookie.
 */
export function OutrasOrganizacoes({
  outras,
}: {
  outras: Array<{ id: string; nome: string }>;
}) {
  const [isPending, startTransition] = useTransition();
  const t = useT();
  const transition = useOrganizationTransition();


  if (outras.length === 0) return null;

  const trocar = (id: string) =>
    startTransition(async () => {
      flushSync(() => transition.begin(t("Carregando organização…")));
      try {
        const r = await setActiveOrg(id);
        if (!r.ok) throw new Error(r.error);
        window.location.assign("/app/inbox");
      } catch {
        transition.cancel();
        toast.error(t("Não foi possível trocar de organização. Tente novamente."));
      }
    });

  // Uma organização só: a escolha já está feita, e um menu de um item é
  // cerimônia. O rótulo diz PARA ONDE se vai, não "trocar" — quem está preso
  // aqui quer o nome do lugar de onde veio.
  if (outras.length === 1) {
    const unica = outras[0]!;
    return (
      <Button
        variant="ghost"
        size="sm"
        data-testid="sair-do-onboarding"
        disabled={isPending}
        onClick={() => trocar(unica.id)}
        className="gap-1.5"
      >
        <ArrowBendUpLeft size={14} weight="bold" aria-hidden />
        <span className="max-w-[180px] truncate">
          {t("Voltar para")} {unica.nome}
        </span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid="sair-do-onboarding"
          disabled={isPending}
          className="gap-1.5"
        >
          <ArrowBendUpLeft size={14} weight="bold" aria-hidden />
          <span>{t("Ir para outra organização")}</span>
          <CaretDown size={12} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        {outras.map((o) => (
          <DropdownMenuItem
            key={o.id}
            data-testid={`sair-do-onboarding-item-${o.id}`}
            onClick={() => trocar(o.id)}
          >
            <span className="truncate">{o.nome}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

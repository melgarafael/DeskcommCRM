"use client";
import { useTransition } from "react";
import { toast } from "sonner";

import { trocarIdioma } from "@/app/actions/settings/trocarIdioma";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";
import { useAplicarIdioma, useIdioma } from "@/lib/i18n/IdiomaProvider";
import { type Idioma } from "@/lib/i18n/idiomas";
import { IDIOMAS_VISIVEIS, idiomaVisivelPorCodigo } from "@/lib/i18n/registro";
import { Check } from "@/lib/ui/icons";

/**
 * Trocar de idioma no TOPO, em dois cliques, de qualquer tela.
 *
 * ─── Por que aqui, e não só em Configurações ───────────────────────────────
 *
 * Porque quem precisa dele é justamente quem NÃO acha Configurações: alguém que
 * abriu o sistema num idioma que não lê. Enterrar a troca a três telas de
 * distância transforma "está em português" num beco — a pessoa teria de
 * navegar, em português, até a tela que resolve o problema de estar em
 * português. O botão fica ao lado do controle de tema, que é o lugar onde este
 * produto já guarda o que muda a APARÊNCIA e não os dados.
 *
 * ─── O rótulo é o código, e é de propósito ─────────────────────────────────
 *
 * "PT" / "ES" são legíveis nos dois idiomas e cabem no mesmo espaço de um
 * ícone. Um ícone de globo diria "idioma" sem dizer QUAL — e saber qual está
 * em vigor é metade da pergunta de quem procura este botão.
 */

export function SeletorDeIdioma() {
  const t = useT();
  const idioma = useIdioma();
  const emVigor = idiomaVisivelPorCodigo(idioma);
  const aplicar = useAplicarIdioma();
  const [salvando, startTransition] = useTransition();

  const escolher = (novo: Idioma) => {
    if (novo === idioma) return;
    const anterior = idioma;
    // Pinta primeiro: quem clica quer ver o efeito no clique, não depois do
    // round-trip. Se o servidor recusar, voltamos ao anterior e dizemos.
    aplicar(novo);
    startTransition(async () => {
      const r = await trocarIdioma(novo);
      if (!r.ok) {
        aplicar(anterior);
        toast.error(t("Não foi possível trocar o idioma. Tente de novo."));
        return;
      }
      // ⚠️ RECARGA INTEIRA, e não `router.refresh()` — os dois foram MEDIDOS.
      //
      // O problema: `revalidatePath` invalida o cache do SERVIDOR. O Router
      // Cache do CLIENTE é outro, e guarda o layout de `/app` já renderizado —
      // que é justamente quem monta o `IdiomaProvider`. Numa sonda Playwright,
      // sem nada disto: logo após o clique a tela mostrava o idioma novo (o
      // estado local pintando), ao NAVEGAR ela voltava ao antigo, e só um
      // reload acertava. A troca parecia funcionar e se desfazia sozinha no
      // primeiro clique seguinte — o pior desfecho possível.
      //
      // `router.refresh()` melhora e não resolve: medido na mesma sonda, a
      // PRIMEIRA navegação depois do clique ainda vinha no idioma antigo e só a
      // SEGUNDA vinha certa. Ele é assíncrono, e quem clica em "ES" e sai
      // navegando ganha a corrida dele. "Funciona porque o humano é lento" não
      // é garantia — é a corrida esperando um dia ruim.
      //
      // A recarga é determinística e é o que qualquer produto faz ao trocar de
      // idioma. O preço é o estado não salvo da tela, e ele é pequeno aqui:
      // trocar o idioma da interface é ação rara, deliberada, e feita antes de
      // trabalhar — não no meio de uma mensagem pela metade.
      window.location.reload();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={salvando}
          aria-label={`${t("Idioma")}: ${emVigor.nomeNativo}`}
          data-testid="seletor-de-idioma"
        >
          <span className="text-xs font-semibold tabular-nums">
            {emVigor.rotuloCurto}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {IDIOMAS_VISIVEIS.map(({ codigo, nomeNativo }) => (
          <DropdownMenuItem
            key={codigo}
            onClick={() => escolher(codigo)}
            data-testid={`idioma-${codigo}`}
            aria-current={codigo === idioma}
          >
            <Check
              size={16}
              className={`mr-2 ${codigo === idioma ? "" : "invisible"}`}
              aria-hidden
            />
            {nomeNativo}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

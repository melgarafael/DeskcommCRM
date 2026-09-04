"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { NAV_GROUPS, searchable, type NavDestination } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

/**
 * Paleta de navegação (⌘K).
 *
 * Sem `cmdk`: o projeto já tem Dialog e Input, e uma lista filtrada com setas e
 * Enter são poucas linhas. Uma dependência a mais para isso seria peso sem ganho.
 *
 * v1 busca só NAVEGAÇÃO — os destinos do registro. Contato, conversa e lead têm
 * outra fonte de dados e são outra feature.
 */

/** Sem acento e sem caixa: ninguém digita "orçamento" com cedilha às pressas. */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const ROTULO_GRUPO = new Map(NAV_GROUPS.map((g) => [g.id, g.label]));

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[15%] max-w-xl translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">{t("Buscar telas")}</DialogTitle>
        {/* O miolo é um componente à parte porque o Radix o DESMONTA ao fechar:
            busca e destaque nascem zerados na próxima abertura por construção,
            sem um efeito de reset para manter em sincronia. */}
        <Resultados aoEscolher={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function Resultados({ aoEscolher }: { aoEscolher: () => void }) {
  const t = useT();
  const router = useRouter();
  const { user, activeOrg } = useAuth();
  const [busca, setBusca] = useState("");
  const [destacado, setDestacado] = useState(0);

  const visiveis = useMemo(
    () => searchable(user.is_platform_admin, activeOrg?.role ?? null),
    [user.is_platform_admin, activeOrg?.role],
  );

  const resultados = useMemo(() => {
    const termo = normalizar(busca.trim());
    // Sem termo, abre no trabalho do dia em vez de uma tela vazia que não
    // ensina nada sobre o que dá para procurar aqui.
    if (!termo) return visiveis.filter((d) => d.group === "atendimento");
    return visiveis.filter((d) => normalizar(`${d.label} ${d.description}`).includes(termo));
  }, [busca, visiveis]);

  function navegar(destino: NavDestination) {
    aoEscolher();
    router.push(destino.href);
  }

  /**
   * O destaque volta ao topo junto com a busca, no mesmo evento: mantê-lo
   * apontaria para outro item depois que a lista muda, e o Enter navegaria
   * para o lugar errado.
   */
  function aoDigitar(valor: string) {
    setBusca(valor);
    setDestacado(0);
  }

  function aoTeclar(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setDestacado((i) => Math.min(i + 1, resultados.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setDestacado((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const alvo = resultados[destacado];
      if (alvo) navegar(alvo);
    }
  }

  return (
    <>
      <div className="flex items-center gap-3 border-b px-4">
        <MagnifyingGlass size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-resultados"
          aria-activedescendant={resultados[destacado] ? `palette-${destacado}` : undefined}
          value={busca}
          onChange={(e) => aoDigitar(e.target.value)}
          onKeyDown={aoTeclar}
          placeholder={t("Buscar telas do sistema…")}
          className="h-12 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
        />
      </div>

      {resultados.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t("Nada encontrado para")} “{busca}”.
        </p>
      ) : (
        <ul
          id="palette-resultados"
          role="listbox"
          aria-label={t("Telas")}
          className="max-h-80 overflow-y-auto p-2"
        >
          {resultados.map((d, i) => {
            const Icon = d.icon;
            const ativo = i === destacado;
            return (
              <li
                key={d.href}
                id={`palette-${i}`}
                role="option"
                aria-selected={ativo}
                data-href={d.href}
                onMouseEnter={() => setDestacado(i)}
                onClick={() => navegar(d)}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2",
                  ativo && "bg-accent text-accent-foreground",
                )}
              >
                <Icon size={18} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{t(d.label)}</span>
                    <span className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">
                      {t(ROTULO_GRUPO.get(d.group) ?? "")}
                    </span>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{t(d.description)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

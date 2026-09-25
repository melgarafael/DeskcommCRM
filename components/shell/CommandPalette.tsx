"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { NAV_GROUPS, searchable, type NavDestination, type NavGroupId } from "@/lib/navigation/registry";
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
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const ROTULO_GRUPO = new Map(NAV_GROUPS.map((g) => [g.id, g.label]));
const ORDEM_GRUPO = new Map(NAV_GROUPS.map((g, i) => [g.id, i]));

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
      <DialogContent className="top-[10%] max-w-2xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-3xl">
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
  const [categoriaAtiva, setCategoriaAtiva] = useState<string>("todos");

  const visiveis = useMemo(
    () =>
      searchable(
        user.is_platform_admin && !user.support,
        activeOrg?.role ?? null,
        activeOrg?.interface_settings,
        activeOrg?.modulos_ligados ?? [],
      ),
    [
      user.is_platform_admin,
      user.support,
      activeOrg?.role,
      activeOrg?.interface_settings,
      activeOrg?.modulos_ligados,
    ],
  );

  // Lista dos grupos disponíveis nos destinos visíveis
  const categoriasDisponiveis = useMemo(() => {
    const gruposNoCatalogo = new Set(visiveis.map((v) => v.group));
    return NAV_GROUPS.filter((g) => gruposNoCatalogo.has(g.id));
  }, [visiveis]);

  const resultados = useMemo(() => {
    const termo = normalizar(busca.trim());
    const filtrados = visiveis.filter((d) => {
      const casaCategoria = categoriaAtiva === "todos" || d.group === categoriaAtiva;
      if (!casaCategoria) return false;
      if (!termo) return true;
      return normalizar(`${d.label} ${d.description} ${ROTULO_GRUPO.get(d.group) ?? ""}`).includes(termo);
    });
    if (termo) return filtrados;
    // O catálogo não é contíguo por grupo (a Prospecção, de CRM, vem antes do
    // Inbox). Sem reordenar, a 1ª seção seria a do 1º item e as setas, que
    // andam por este array, pulariam de uma seção para outra. Ordenado pelo
    // NAV_GROUPS, a ordem do array é a ordem da tela. O sort é estável.
    return [...filtrados].sort((a, b) => (ORDEM_GRUPO.get(a.group) ?? 0) - (ORDEM_GRUPO.get(b.group) ?? 0));
  }, [busca, visiveis, categoriaAtiva]);

  // Agrupamento para exibição visual estruturada quando não há busca específica digitada
  const resultadosAgrupados = useMemo(() => {
    const map = new Map<NavGroupId, NavDestination[]>();
    for (const item of resultados) {
      const g = item.group;
      const lista = map.get(g) ?? [];
      lista.push(item);
      map.set(g, lista);
    }
    return map;
  }, [resultados]);

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

  function mudarCategoria(id: string) {
    setCategoriaAtiva(id);
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

  const emModoCatalogo = !busca.trim() && categoriaAtiva === "todos";

  return (
    <>
      <div className="flex items-center gap-3 border-b px-4">
        <MagnifyingGlass size={18} aria-hidden className="shrink-0 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="palette-resultados"
          aria-activedescendant={resultados[destacado] ? `palette-${destacado}` : undefined}
          value={busca}
          onChange={(e) => aoDigitar(e.target.value)}
          onKeyDown={aoTeclar}
          placeholder={t("Buscar por nome, objetivo ou função (ex: leads, agenda, prompt, whatsapp)...")}
          className="h-13 w-full bg-transparent text-sm text-foreground outline-hidden placeholder:text-muted-foreground"
        />
        {busca && (
          <button
            type="button"
            onClick={() => aoDigitar("")}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {t("Limpar")}
          </button>
        )}
      </div>

      {/* Categorias rápidas para navegação instantânea */}
      <div className="flex items-center gap-1.5 overflow-x-auto border-b bg-muted/30 px-3 py-2 text-xs">
        <button
          type="button"
          onClick={() => mudarCategoria("todos")}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap",
            categoriaAtiva === "todos"
              ? "bg-foreground text-background shadow-xs"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {t("Todas")} ({visiveis.length})
        </button>
        {categoriasDisponiveis.map((cat) => {
          const qtd = visiveis.filter((v) => v.group === cat.id).length;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => mudarCategoria(cat.id)}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors whitespace-nowrap",
                categoriaAtiva === cat.id
                  ? "bg-foreground text-background shadow-xs"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t(cat.label)} ({qtd})
            </button>
          );
        })}
      </div>

      {resultados.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">
            {t("Nada encontrado para")} “{busca}”.
          </p>
          <p className="mt-1 text-xs">{t("Tente buscar por outro termo ou selecione 'Todas' nas categorias.")}</p>
        </div>
      ) : emModoCatalogo ? (
        /* Modo Catálogo Visível: agrupado por departamentos/módulos para ver tudo de relance */
        <div
          id="palette-resultados"
          role="listbox"
          aria-label={t("Telas")}
          className="max-h-[60vh] space-y-5 overflow-y-auto p-4"
        >
          {Array.from(resultadosAgrupados.entries()).map(([grupoId, itens]) => {
            const rotuloGrupo = ROTULO_GRUPO.get(grupoId) ?? grupoId;
            return (
              <div key={grupoId} role="group" aria-label={t(rotuloGrupo)} className="space-y-2">
                <div className="flex items-center justify-between border-b pb-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {t(rotuloGrupo)}
                  </h3>
                  <span className="text-[11px] text-muted-foreground">
                    {itens.length} {itens.length === 1 ? t("ferramenta") : t("ferramentas")}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {itens.map((d) => {
                    const Icon = d.icon;
                    const idxGlobal = resultados.findIndex((r) => r.href === d.href);
                    const ativo = idxGlobal === destacado;
                    // Mesmo par do modo lista: cinza sobre o destaque dava 1,2:1.
                    const secundario = ativo ? "text-accent-foreground" : "text-muted-foreground";
                    return (
                      <div
                        key={d.href}
                        id={`palette-${idxGlobal}`}
                        role="option"
                        aria-selected={ativo}
                        data-href={d.href}
                        onMouseEnter={() => setDestacado(idxGlobal)}
                        onClick={() => navegar(d)}
                        className={cn(
                          "group flex cursor-pointer items-start gap-3 rounded-lg border border-border/50 p-2.5 transition-all",
                          ativo
                            ? "border-primary/40 bg-accent text-accent-foreground shadow-xs ring-1 ring-primary/20"
                            : "hover:border-border hover:bg-muted/50",
                        )}
                      >
                        <div
                          className={cn(
                            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background/80 transition-colors",
                            ativo && "bg-primary text-primary-foreground",
                          )}
                        >
                          <Icon size={16} aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold leading-tight">{t(d.label)}</p>
                          <p className={cn("mt-0.5 line-clamp-2 text-[11px] leading-snug", secundario)}>
                            {t(d.description)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Modo Lista Filtrada / Busca direta */
        <ul
          id="palette-resultados"
          role="listbox"
          aria-label={t("Telas")}
          className="max-h-[60vh] overflow-y-auto p-2"
        >
          {resultados.map((d, i) => {
            const Icon = d.icon;
            const ativo = i === destacado;
            // No item destacado o fundo é a cor de destaque: o cinza de apoio
            // ficava 1,2:1 sobre o verde (medido), ilegível. A cor de frente do
            // destaque SEM opacidade herda o piso de 4,5:1 que
            // lib/branding/contraste.ts garante para qualquer marca própria; a
            // 90%, uma marca de luminância média cai para 4,1:1.
            const secundario = ativo ? "text-accent-foreground" : "text-muted-foreground";
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
                  "flex cursor-pointer items-start gap-3 rounded-md px-3 py-2.5 transition-colors",
                  ativo && "bg-accent text-accent-foreground",
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background/60",
                    ativo && "bg-primary text-primary-foreground",
                  )}
                >
                  <Icon size={16} aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{t(d.label)}</span>
                    <span className={cn("truncate text-[10px] font-medium tracking-wider uppercase", secundario)}>
                      {t(ROTULO_GRUPO.get(d.group) ?? "")}
                    </span>
                  </div>
                  {/* Duas linhas, não uma cortada: a palavra que a pessoa buscou
                      pode estar no fim da descrição. */}
                  <p className={cn("line-clamp-2 text-xs", secundario)}>{t(d.description)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
        <span>{t("Use as setas ↑↓ e Enter para navegar")}</span>
        <span>{t("ESC para fechar")}</span>
      </div>
    </>
  );
}

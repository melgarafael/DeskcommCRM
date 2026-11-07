"use client";

/**
 * O PAINEL LATERAL DO MÓDULO CONECTADO (Spec 33, F4, tarefa 5).
 *
 * DESENHO (decisão desta tarefa). O navegador só tem `slug` e `titulo` do módulo
 * (`activeOrg.modulos_conectados`); o endereço do serviço e o id da instalação ficam no servidor.
 * Ao abrir o painel, a pessoa pede o módulo pelo slug à ação de servidor `moduloParaOPainel`, que
 * confere sessão/organização/papel pela mesma fonte da rota (`modulosNaTela`) e devolve SÓ aquele
 * módulo. O painel então desenha o MESMO `QuadroDoModulo` da rota: há UM só caminho de segurança
 * (sandbox, ponte de 6 mensagens, origem conferida, JWT limitado).
 *
 * Por que NÃO um iframe do próprio CRM numa rota `/painel`: o CRM manda `X-Frame-Options: DENY`
 * em tudo (`next.config.ts`), e enquadrar o CRM nele mesmo exigiria relaxar esse header para
 * `SAMEORIGIN` numa rota, além de carregar o layout inteiro do app (menu, topo) dentro do painel e
 * um iframe dentro do iframe. A ação de servidor evita as três coisas e não toca em header algum.
 *
 * Regras: um módulo por vez; `Esc` fecha; um único módulo => o botão abre direto; vários =>
 * escolha; sem módulo o botão não existe; em tela estreita (abaixo de `md`, 768px, o corte que o
 * shell já usa) abrir leva à rota `/app/m/<slug>` em vez de abrir painel.
 */
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { moduloParaOPainel } from "@/app/actions/modulo/moduloParaOPainel";
import { QuadroDoModulo } from "@/components/modulo/QuadroDoModulo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import type { ModuloNaTela } from "@/lib/extensions/modulos-na-tela";
import { PuzzlePiece, X } from "@/lib/ui/icons";

/** Mesmo corte do shell: abaixo de `md` a barra lateral some e o celular manda. */
export const CONSULTA_DE_TELA_LARGA = "(min-width: 768px)";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Estado =
  | { fase: "fechado" }
  | { fase: "carregando"; slug: string; titulo: string }
  | { fase: "aberto"; modulo: ModuloNaTela }
  | { fase: "erro"; slug: string; titulo: string };

type Contexto = {
  /** Slug e título dos módulos que a pessoa pode abrir (o que o navegador conhece). */
  modulos: readonly { slug: string; titulo: string }[];
  slugAberto: string | null;
  /** Largo: abre o painel (um por vez; o mesmo slug de novo fecha). Estreito: vai para a rota. */
  abrir: (slug: string) => void;
  fechar: () => void;
};

const SEM_PAINEL: Contexto = { modulos: [], slugAberto: null, abrir: () => {}, fechar: () => {} };
const PainelContext = createContext<Contexto>(SEM_PAINEL);

/** Sem provedor devolve um painel inerte (telas e testes que não têm o topo montado). */
export function usePainelDoModulo(): Contexto {
  return useContext(PainelContext);
}

function telaLarga(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(CONSULTA_DE_TELA_LARGA).matches;
}

export function PainelDoModuloProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { activeOrg } = useAuth();
  const [estado, setEstado] = useState<Estado>({ fase: "fechado" });
  const pedidoRef = useRef(0);

  const modulos = useMemo(
    () => (activeOrg?.modulos_conectados ?? []).filter((m) => SLUG.test(m.slug)),
    [activeOrg?.modulos_conectados],
  );

  const slugAberto =
    estado.fase === "fechado" ? null : estado.fase === "aberto" ? estado.modulo.slug : estado.slug;

  const fechar = useCallback(() => {
    pedidoRef.current += 1; // resposta atrasada de um pedido antigo não reabre nada
    setEstado({ fase: "fechado" });
  }, []);

  const abrir = useCallback(
    (slug: string) => {
      const alvo = modulos.find((m) => m.slug === slug);
      if (!alvo) return;
      // Tela estreita: sem layout novo, a pessoa vai para a rota do módulo.
      if (!telaLarga()) {
        fechar();
        router.push(`/app/m/${alvo.slug}` as never);
        return;
      }
      if (slug === slugAberto) {
        fechar();
        return;
      }
      const pedido = ++pedidoRef.current;
      setEstado({ fase: "carregando", slug: alvo.slug, titulo: alvo.titulo });
      moduloParaOPainel(alvo.slug).then(
        (modulo) => {
          if (pedido !== pedidoRef.current) return;
          setEstado(
            modulo
              ? { fase: "aberto", modulo }
              : { fase: "erro", slug: alvo.slug, titulo: alvo.titulo },
          );
        },
        () => {
          if (pedido !== pedidoRef.current) return;
          setEstado({ fase: "erro", slug: alvo.slug, titulo: alvo.titulo });
        },
      );
    },
    [modulos, slugAberto, fechar, router],
  );

  // Trocou de organização ou o módulo saiu da lista: o painel fecha.
  useEffect(() => {
    if (slugAberto && !modulos.some((m) => m.slug === slugAberto)) fechar();
  }, [modulos, slugAberto, fechar]);

  // `Esc` fecha.
  useEffect(() => {
    if (estado.fase === "fechado") return;
    function aoTeclar(e: KeyboardEvent) {
      if (e.key === "Escape") fechar();
    }
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [estado.fase, fechar]);

  const valor = useMemo<Contexto>(
    () => ({ modulos, slugAberto, abrir, fechar }),
    [modulos, slugAberto, abrir, fechar],
  );

  return (
    <PainelContext.Provider value={valor}>
      {children}
      <PainelDoModulo estado={estado} aoFechar={fechar} />
    </PainelContext.Provider>
  );
}

function PainelDoModulo({ estado, aoFechar }: { estado: Estado; aoFechar: () => void }) {
  const t = useT();
  if (estado.fase === "fechado") return null;
  const titulo = estado.fase === "aberto" ? estado.modulo.titulo : estado.titulo;
  return (
    <aside
      aria-label={titulo}
      data-testid="painel-do-modulo"
      className="fixed top-[calc(var(--faixas-de-cima,0px)+3.5rem)] right-0 bottom-0 z-30 flex w-[28rem] max-w-[90vw] flex-col border-l bg-background shadow-lg"
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="truncate text-sm font-semibold">{titulo}</h2>
        <Button variant="ghost" size="sm" onClick={aoFechar} aria-label={t("Fechar")}>
          <X size={16} aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {estado.fase === "aberto" && (
          <QuadroDoModulo key={estado.modulo.installationId} modulo={estado.modulo} />
        )}
        {estado.fase === "carregando" && (
          <p role="status" className="p-3 text-sm text-muted-foreground">
            {t("Abrindo o módulo...")}
          </p>
        )}
        {estado.fase === "erro" && (
          <p role="status" className="p-3 text-sm text-muted-foreground">
            {t("Não foi possível abrir este módulo.")}
          </p>
        )}
      </div>
    </aside>
  );
}

/** O botão do topo. Sem módulo, não existe. */
export function BotaoDoPainelDoModulo() {
  const t = useT();
  const { modulos, slugAberto, abrir } = usePainelDoModulo();
  if (modulos.length === 0) return null;
  const rotulo = t("Abrir ao lado");

  const unico = modulos.length === 1 ? modulos[0] : undefined;
  if (unico) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={`${rotulo}: ${unico.titulo}`}
        aria-pressed={slugAberto === unico.slug}
        onClick={() => abrir(unico.slug)}
      >
        <PuzzlePiece size={18} aria-hidden />
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={rotulo}>
          <PuzzlePiece size={18} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("Escolha um módulo")}</DropdownMenuLabel>
        {modulos.map((m) => (
          <DropdownMenuItem key={m.slug} onSelect={() => abrir(m.slug)}>
            {m.titulo}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

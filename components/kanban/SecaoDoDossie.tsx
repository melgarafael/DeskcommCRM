"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A seção RECOLHÍVEL do dossiê e o estado lembrado dela (issue #3181).
 *
 * ─── Por que aqui, e não numa preferência que já existe ─────────────────────
 *
 * O produto tem uma preferência de interface pronta — `interface_settings`, por
 * ORGANIZAÇÃO (`atualizarInterfaceDaEmpresa`, `lerInterface`, o
 * `interface_settings` que chega ao cliente em `lib/auth/server.ts`). Ela NÃO
 * serve para este estado, por duas razões medidas no próprio caminho:
 *
 *  1. ela é da EMPRESA — quem reclina uma seção mudaria a tela de todo mundo; e
 *  2. escrevê-la exige `podeAdministrarEmpresa` (admin/owner). Quem abre o
 *     dossiê no dia a dia é atendente: ele não conseguiria nem guardar a própria
 *     escolha, nem deixar de mexer na de todos.
 *
 * O autor pediu o estado "por usuário" numa issue sobre ROLAGEM individual — e
 * é isso que `localStorage` dá: POR NAVEGADOR, sem schema novo, sem rota nova e
 * sem permissão nova. O custo declarado: a escolha não atravessa máquinas nem
 * navegadores da mesma pessoa (mesma régua do recolhimento dos grupos da barra
 * lateral, `Sidebar.tsx`).
 *
 * ─── Guarda-se o CONJUNTO DOS FECHADOS ──────────────────────────────────────
 *
 * Como na barra lateral: sem nada salvo, tudo abre. Guardar os ABERTOS faria
 * "sem preferência" significar "tudo fechado" — e a primeira impressão do
 * dossiê passaria a ser um formulário sumido.
 *
 * Começa vazio em toda renderização (servidor, primeira pintura do cliente e
 * nos testes, que nunca clicam) e só muda depois do mount, se houver algo
 * salvo. Ler o storage no inicializador do `useState` daria HTML diferente no
 * servidor e no cliente — divergência de hidratação, que aqui não compra nada.
 */
export const CHAVE_DAS_SECOES_RECOLHIDAS = "dossie:secoes-recolhidas";

/** As três seções que o autor citou. `Tarefas` e `Propostas` ficam de fora. */
export type IdDeSecao = "contato" | "dados-do-negocio" | "linha-do-tempo";

function gravar(fechadas: Set<string>): void {
  try {
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify([...fechadas]));
  } catch {
    // Storage bloqueado (aba privada, política de cookies): o clique continua
    // valendo nesta sessão; só não sobrevive a um F5.
  }
}

export interface SecoesRecolhiveis {
  fechadas: Set<string>;
  alternar: (id: IdDeSecao) => void;
  /** Abre a seção sem fechar nenhuma — ver o atalho "Editar campos". */
  abrir: (id: IdDeSecao) => void;
}

export function useSecoesRecolhidas(): SecoesRecolhiveis {
  const [fechadas, setFechadas] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const salvo = window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS);
      if (salvo) setFechadas(new Set(JSON.parse(salvo) as string[]));
    } catch {
      // Valor corrompido ou storage bloqueado — tudo aberto, que é o padrão.
    }
  }, []);

  const alternar = useCallback((id: IdDeSecao) => {
    setFechadas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      gravar(next);
      return next;
    });
  }, []);

  /**
   * O atalho "Editar campos" rola até a seção dos campos. Se ela estiver
   * fechada, rolar até um título mostra um destino vazio: quem clicou pediu os
   * campos, então o clique também ABRE a seção.
   */
  const abrir = useCallback((id: IdDeSecao) => {
    setFechadas((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      gravar(next);
      return next;
    });
  }, []);

  return { fechadas, alternar, abrir };
}

interface Props {
  id: IdDeSecao;
  /**
   * O título JÁ traduzido — quem chama é que escreve `t("Contato")`, com o
   * literal na mão: `t()` de chave dinâmica é o que o guarda de i18n recusa, e
   * com razão (ele não consegue saber quais chaves existem).
   */
  titulo: string;
  recolhida: boolean;
  aoAlternar: (id: IdDeSecao) => void;
  children: ReactNode;
  /**
   * O que mostrar RECOLHIDA, quando mostrar nada não serve.
   *
   * A linha do tempo é o caso: recolhida, ela continua dizendo o que aconteceu
   * por último — as três entradas mais recentes e o "ver tudo" que o autor
   * pediu. Sem esta prop, o corpo fica MONTADO e escondido (`hidden`), nunca
   * desmontado: fechar "Dados do negócio" no meio de uma edição não pode
   * descartar em silêncio o que já tinha sido digitado.
   */
  conteudoRecolhido?: ReactNode;
  className?: string;
}

export function SecaoDoDossie({
  id,
  titulo,
  recolhida,
  aoAlternar,
  children,
  conteudoRecolhido,
  className,
}: Props) {
  const temConteudoRecolhido = conteudoRecolhido !== undefined;

  return (
    <section
      // Os três estados que um teste de tela precisa medir: QUAL seção, em que
      // ORDEM, e aberta ou fechada — sem depender de classe de estilo.
      data-secao={id}
      data-recolhida={recolhida ? "sim" : "nao"}
      className={cn("border-b border-border py-3", className)}
    >
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
        <button
          type="button"
          onClick={() => aoAlternar(id)}
          aria-expanded={!recolhida}
          className="flex w-full items-center gap-2 text-left hover:text-text"
        >
          <span>{titulo}</span>
          {/* Mesmo sinal da timeline: `+` fechado, `−` aberto. O `aria-expanded`
              é quem fala a verdade para quem não vê o sinal. */}
          <span aria-hidden className="ml-auto text-[10px]">
            {recolhida ? "+" : "−"}
          </span>
        </button>
      </h3>
      <div hidden={recolhida && !temConteudoRecolhido}>
        {recolhida && temConteudoRecolhido ? conteudoRecolhido : children}
      </div>
    </section>
  );
}

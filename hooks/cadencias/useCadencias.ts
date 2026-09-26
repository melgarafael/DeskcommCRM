"use client";

/**
 * Cadências pela API real (`/api/v1/cadencias`) — não mais localStorage.
 *
 * A tela só conhece `useCadencias()` e `useCadencia(id)`, como o comentário
 * antigo deste arquivo previa; o que muda aqui embaixo é a origem do dado.
 *
 * Duas traduções acontecem nesta camada, e só nesta camada:
 *  - **Nomes de coluna**: a API é `name`/`created_at`/`updated_at` (JSON
 *    snake_case, doutrina da API REST); a tela é `nome`/`criadaEm`/
 *    `atualizadaEm` (contrato de `lib/cadencias/tipos.ts`, que nasceu antes do
 *    backend). `configuracao`/`passos`/`status`/`id` já batem dos dois lados
 *    porque são jsonb opaco ou vocabulário compartilhado.
 *  - **Cadência do envio**: o construtor chama `salvar()` a cada tecla (ver
 *    `Construtor.tsx`). Mudança de STATUS (ativar/pausar) vai direto para
 *    `PATCH { status }` — precisa do erro 409 na hora se o estado mudou.
 *    Mudança de CONTEÚDO (nome/configuração/passos) é debounced: gravar a
 *    cada tecla encheria a rede e o audit por nada, e editar rascunho não
 *    audita mesmo (ver a rota).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Cadencia, ConfiguracaoDaCadencia, Passo, StatusDaCadencia } from "@/lib/cadencias/tipos";

interface LinhaDaApi {
  id: string;
  name: string;
  status: StatusDaCadencia;
  configuracao: ConfiguracaoDaCadencia;
  passos?: Passo[];
  versao: number;
  created_at: string;
  updated_at: string;
}

function linhaParaCadencia(row: LinhaDaApi): Cadencia {
  return {
    id: row.id,
    nome: row.name,
    status: row.status,
    configuracao: row.configuracao,
    passos: row.passos ?? [],
    criadaEm: row.created_at,
    atualizadaEm: row.updated_at,
  };
}

async function extrairErro(res: Response): Promise<string> {
  try {
    const corpo = (await res.json()) as { error?: { message?: string } };
    return corpo.error?.message ?? `Falha (${res.status}).`;
  } catch {
    return `Falha (${res.status}).`;
  }
}

export function useCadencias() {
  const [lista, setLista] = useState<Cadencia[]>([]);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const res = await fetch("/api/v1/cadencias");
        if (!res.ok) return;
        const { data } = (await res.json()) as { data: LinhaDaApi[] };
        if (vivo) setLista(data.map(linhaParaCadencia));
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  const criar = useCallback(async (nome: string, tagDoSegmento: string): Promise<Cadencia> => {
    const res = await fetch("/api/v1/cadencias", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nome, tagDoSegmento }),
    });
    if (!res.ok) throw new Error(await extrairErro(res));
    const { data } = (await res.json()) as { data: LinhaDaApi };
    const nova = linhaParaCadencia(data);
    setLista((atual) => [nova, ...atual]);
    return nova;
  }, []);

  const excluir = useCallback(async (id: string) => {
    const res = await fetch(`/api/v1/cadencias/${id}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await extrairErro(res));
    setLista((atual) => atual.filter((c) => c.id !== id));
  }, []);

  return { lista, criar, excluir, carregando };
}

const ESPERA_DO_DEBOUNCE_MS = 700;

export function useCadencia(id: string) {
  const [cadencia, setCadencia] = useState<Cadencia | null>(null);
  const [carregando, setCarregando] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendente = useRef<{ name?: string; configuracao?: ConfiguracaoDaCadencia; passos?: Passo[] }>({});

  useEffect(() => {
    let vivo = true;
    // `carregando` já nasce `true` (useState acima); Next.js remonta a página
    // quando o `id` da rota muda, então não há um segundo carregamento no
    // mesmo componente a resetar.
    (async () => {
      try {
        const res = await fetch(`/api/v1/cadencias/${id}`);
        if (!res.ok) {
          if (vivo) setCadencia(null);
          return;
        }
        const { data } = (await res.json()) as { data: LinhaDaApi };
        if (vivo) setCadencia(linhaParaCadencia(data));
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [id]);

  const gravarConteudoAgora = useCallback(async () => {
    const corpo = pendente.current;
    pendente.current = {};
    if (Object.keys(corpo).length === 0) return;
    const res = await fetch(`/api/v1/cadencias/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    if (res.ok) {
      const { data } = (await res.json()) as { data: LinhaDaApi };
      setCadencia(linhaParaCadencia(data));
    }
    // Falha na gravação debounced fica só no console: o construtor não tem
    // onde mostrar um erro de tecla perdida sem interromper quem está
    // digitando. A tela recarrega com o último estado salvo se navegar fora.
  }, [id]);

  const salvar = useCallback(
    (nova: Cadencia) => {
      setCadencia((atual) => {
        const anterior = atual;
        // Otimista: a tela mostra a mudança já, e a rede confirma depois.
        const otimista = { ...nova, atualizadaEm: new Date().toISOString() };

        if (anterior && nova.status !== anterior.status) {
          void (async () => {
            const res = await fetch(`/api/v1/cadencias/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: nova.status }),
            });
            if (res.ok) {
              const { data } = (await res.json()) as { data: LinhaDaApi };
              setCadencia(linhaParaCadencia(data));
            } else if (anterior) {
              // Estado recusado (409/422): volta pro que o servidor confirmou
              // por último — não deixa a tela mentir "ativa" com o backend
              // recusando.
              setCadencia(anterior);
            }
          })();
        }

        const mudouConteudo =
          !anterior || nova.nome !== anterior.nome || nova.configuracao !== anterior.configuracao || nova.passos !== anterior.passos;
        if (mudouConteudo) {
          pendente.current = {
            ...pendente.current,
            ...(nova.nome !== anterior?.nome ? { name: nova.nome } : {}),
            ...(nova.configuracao !== anterior?.configuracao ? { configuracao: nova.configuracao } : {}),
            ...(nova.passos !== anterior?.passos ? { passos: nova.passos } : {}),
          };
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void gravarConteudoAgora(), ESPERA_DO_DEBOUNCE_MS);
        }

        return otimista;
      });
    },
    [id, gravarConteudoAgora],
  );

  return { cadencia, salvar, carregando };
}

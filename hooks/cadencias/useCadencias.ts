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
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";

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
  const [erro, setErro] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [erroMais, setErroMais] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const res = await fetch("/api/v1/cadencias");
        if (!res.ok) throw new Error();
        const { data, meta } = (await res.json()) as { data: LinhaDaApi[]; meta: { cursor: string | null } };
        if (vivo) { setLista(data.map(linhaParaCadencia)); setCursor(meta.cursor); setErro(false); setErroMais(false); }
      } catch { if (vivo) setErro(true); } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [recarga]);

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

  const carregarMais = async () => {
    if (!cursor || carregandoMais) return;
    setCarregandoMais(true);
    try {
      const res = await fetch(`/api/v1/cadencias?cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error();
      const corpo = await res.json() as { data: LinhaDaApi[]; meta: { cursor: string | null } };
      setLista((atual) => [...atual, ...corpo.data.map(linhaParaCadencia).filter((c) => !atual.some((a) => a.id === c.id))]);
      setCursor(corpo.meta.cursor); setErroMais(false);
    } catch { setErroMais(true); }
    finally { setCarregandoMais(false); }
  };
  const recarregar = () => { setCarregando(true); setErro(false); setRecarga((n) => n + 1); };
  return { lista, criar, excluir, carregando, erro, recarregar, carregarMais, temMais: cursor !== null, carregandoMais, erroMais };
}

const ESPERA_DO_DEBOUNCE_MS = 700;

export function useCadencia(id: string) {
  const t = useT();
  const [cadencia, setCadencia] = useState<Cadencia | null>(null);
  const [carregando, setCarregando] = useState(true);
  const atual = useRef<Cadencia | null>(null);
  const [mudandoStatus, setMudandoStatus] = useState(false);
  const transicao = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendente = useRef<{ name?: string; configuracao?: ConfiguracaoDaCadencia; passos?: Passo[] }>({});
  const revisoes = useRef<Record<string, number>>({});
  const fila = useRef<Promise<boolean>>(Promise.resolve(true));
  const gravar = useCallback(async (corpo: object): Promise<LinhaDaApi | null> => {
    try {
      const res = await fetch(`/api/v1/cadencias/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
      if (!res.ok) { toast.error(await extrairErro(res)); return null; }
      const resposta = await res.json() as { data: LinhaDaApi };
      return resposta.data;
    } catch { toast.error(t("Não foi possível salvar a cadência. Suas alterações continuam nesta tela.")); return null; }
  }, [id, t]);
  const descarregar = useCallback((): Promise<boolean> => {
    if (timer.current) clearTimeout(timer.current);
    const corpo = pendente.current;
    const revisoesDoCorpo = { ...revisoes.current };
    pendente.current = {};
    if (Object.keys(corpo).length === 0) return fila.current;
    fila.current = fila.current.then(async () => {
      const salvo = Boolean(await gravar(corpo));
      if (!salvo) {
        // Uma falha velha não recoloca texto sobre uma edição mais nova já
        // enfileirada. Só restaura a chave que ainda tem a mesma revisão.
        const restaurar = Object.fromEntries(Object.entries(corpo).filter(([chave]) => revisoes.current[chave] === revisoesDoCorpo[chave]));
        pendente.current = { ...restaurar, ...pendente.current };
      }
      return salvo;
    });
    return fila.current;
  }, [gravar]);
  useEffect(() => {
    let vivo = true;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/cadencias/${id}`);
        if (!res.ok) throw new Error();
        const { data } = await res.json() as { data: LinhaDaApi };
        if (vivo) { atual.current = linhaParaCadencia(data); setCadencia(atual.current); }
      } catch { if (vivo) toast.error(t("Não foi possível carregar a cadência.")); }
      finally { if (vivo) setCarregando(false); }
    })();
    return () => { vivo = false; void descarregar(); };
  }, [id, descarregar, t]);
  const salvar = useCallback(async (nova: Cadencia): Promise<boolean> => {
    const anterior = atual.current;
    if (!anterior) return false;
    if (transicao.current) return false;
    if (nova.status !== anterior.status) {
      transicao.current = true; setMudandoStatus(true);
      try {
        if (anterior.status === "ativa" && nova.status === "pausada") {
          // Pausar é uma ação de contenção. Conteúdo recusado enquanto ativa
          // não pode bloquear a pausa nem ser reaplicado depois dela.
          if (timer.current) clearTimeout(timer.current);
          await fila.current;
          pendente.current = {};
        } else if (!(await descarregar())) return false;
        const confirmada = await gravar({ status: nova.status });
        if (!confirmada) return false;
        atual.current = linhaParaCadencia(confirmada); setCadencia(atual.current);
        return true;
      } finally { transicao.current = false; setMudandoStatus(false); }
    }
    // Mesmo que algum consumer antigo tente editar pelo nome, não cria fila
    // inválida que dependa de reload para permitir a pausa.
    if (anterior.status === "ativa") return false;
    atual.current = nova; setCadencia(nova);
    const alteracoes = {
      ...(nova.nome !== anterior.nome ? { name: nova.nome } : {}),
      ...(nova.configuracao !== anterior.configuracao ? { configuracao: nova.configuracao } : {}),
      ...(nova.passos !== anterior.passos ? { passos: nova.passos } : {}),
    };
    for (const chave of Object.keys(alteracoes)) revisoes.current[chave] = (revisoes.current[chave] ?? 0) + 1;
    pendente.current = { ...pendente.current, ...alteracoes };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void descarregar(); }, ESPERA_DO_DEBOUNCE_MS);
    return true;
  }, [descarregar, gravar]);
  return { cadencia, salvar, carregando, mudandoStatus };
}

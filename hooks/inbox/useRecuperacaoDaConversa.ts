"use client";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";

import { useParticipacoesRealtime } from "@/hooks/inbox/useParticipacoesRealtime";
import { lerConversa } from "@/hooks/inbox/useConversation";
import { lerPaginaDeMensagens, type MessagesResponse } from "@/hooks/inbox/useMessagesRealtime";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { ApiError } from "@/lib/api/types";

export interface AncoraDaConversa {
  id: string;
  deslocamento: number;
  paginas: number;
}

type Resultado = "confirmada" | "sem-acesso" | "sessao-expirada";

function recusaDaLeitura(err: unknown): Exclude<Resultado, "confirmada"> | null {
  if (!(err instanceof ApiError) || err.semEnvelope) return null;
  if (err.status === 404 && err.code === "not_found") return "sem-acesso";
  if (err.status === 401 && err.code === "unauthenticated") return "sessao-expirada";
  return null;
}

export function useRecuperacaoDaConversa({
  id, orgId, userId, lista, guardarAncora, fecharAcoes,
}: {
  id: string | null;
  orgId: string | null;
  userId: string;
  lista?: ListaEmCache;
  guardarAncora: (id: string) => AncoraDaConversa | null;
  fecharAcoes: () => void;
}) {
  const qc = useQueryClient();
  const instancia = useId();
  const [rodadas, setRodadas] = useState({ ultima: 0, geral: 0, pontuais: new Map<string, number>() });
  const [negadas, setNegadas] = useState<ReadonlyMap<string, { rodada: number; negadaEm: number }>>(() => new Map());
  const [sessaoExpirada, setSessaoExpirada] = useState(false);
  const [ancora, setAncora] = useState<{ conversa: string; valor: AncoraDaConversa } | null>(null);
  const rodadaDaConversa = useCallback((conversa: string) =>
    Math.max(rodadas.geral, rodadas.pontuais.get(conversa) ?? 0), [rodadas]);
  const rodada = id ? rodadaDaConversa(id) : 0;
  const temRodada = useCallback((conversa: string | null) =>
    !!conversa && rodadaDaConversa(conversa) > 0, [rodadaDaConversa]);
  const chaveDaInstancia = useMemo(() => ["inbox-revalidacao", instancia, orgId, userId] as const, [instancia, orgId, userId]);
  const valorDaAncora = ancora?.conversa === id ? ancora?.valor ?? null : null;
  if (ancora && ancora.conversa !== id) setAncora(null);

  const revalidar = useCallback((afetada: string | null) => {
    if (!afetada || afetada === id) {
      if (id) {
        const valor = guardarAncora(id);
        if (valor) setAncora({ conversa: id, valor });
      }
      fecharAcoes();
      void qc.cancelQueries({ queryKey: ["inbox-revalidacao", instancia, orgId, userId] });
    }
    setRodadas((anterior) => {
      const ultima = anterior.ultima + 1;
      if (!afetada) return { ultima, geral: ultima, pontuais: new Map() };
      return { ...anterior, ultima, pontuais: new Map(anterior.pontuais).set(afetada, ultima) };
    });
    return id;
  }, [id, fecharAcoes, guardarAncora, qc, instancia, orgId, userId]);

  useParticipacoesRealtime(userId, orgId, revalidar);

  const leitura = useQuery({
    queryKey: [...chaveDaInstancia, id, rodada],
    enabled: !!orgId && !!id && rodada > 0 && !sessaoExpirada,
    retry: false,
    retryOnMount: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }): Promise<Resultado> => {
      if (!id || !orgId) throw new Error("Conversa ausente na revalidação");
      try {
        const conversa = await lerConversa(id, signal, orgId);
        if (conversa?.id !== id || conversa.organization_id !== orgId) {
          throw new Error("A resposta não corresponde à conversa solicitada");
        }

        const historico: InfiniteData<MessagesResponse, string | undefined> = { pages: [], pageParams: [] };
        let cursor: string | undefined;
        const limite = valorDaAncora?.paginas ?? 1;
        do {
          const pagina = await lerPaginaDeMensagens(id, cursor, signal, orgId);
          if (!Array.isArray(pagina?.data) || pagina.data.some((m) => m.conversation_id !== id)) {
            throw new Error("A resposta não corresponde ao histórico solicitado");
          }
          historico.pages.push(pagina);
          historico.pageParams.push(cursor);
          cursor = pagina.meta?.has_more ? pagina.meta.cursor ?? undefined : undefined;
        } while (cursor && historico.pages.length < limite);

        signal.throwIfAborted();
        limparDadosDaConversa(qc, id, conversa.contact_id);
        qc.setQueryData<ConversationWithContact>(["conversation", id], conversa);
        qc.setQueryData(["messages", id], historico);
        return "confirmada";
      } catch (err) {
        signal.throwIfAborted();
        const recusa = recusaDaLeitura(err);
        if (!recusa) throw err;
        return recusa;
      }
    },
  });

  const registrarRecusa = useCallback((recusa: "sem-acesso" | "sessao-expirada") => {
    if (!id) return;
    if (recusa === "sessao-expirada") {
      setSessaoExpirada(true);
      qc.removeQueries({ predicate: ({ queryKey }) => chavesProtegidas.includes(String(queryKey[0])) });
    } else {
      const negadaEm = performance.now();
      setNegadas((atual) => new Map(atual).set(id, { rodada, negadaEm }));
      limparDadosDaConversa(qc, id);
      // A lista anterior pode responder depois do 404, inclusive após sair do
      // Inbox, quando o filtro deste componente já não existe.
      void qc.cancelQueries({ queryKey: ["conversations"] });
      qc.setQueriesData<ListaEmCache>({ queryKey: ["conversations"] }, (lista) =>
        filtrarListaProtegida(lista, (conversa) => conversa !== id));
    }
    setAncora(null);
    fecharAcoes();
  }, [id, rodada, qc, fecharAcoes]);

  useEffect(() => {
    if (leitura.data === "sem-acesso" || leitura.data === "sessao-expirada") registrarRecusa(leitura.data);
    else if (leitura.data === "confirmada" && id) {
      setNegadas((atual) => {
        if (!atual.has(id)) return atual;
        const novas = new Map(atual);
        novas.delete(id);
        return novas;
      });
    }
  }, [id, leitura.data, registrarRecusa]);

  useEffect(() => {
    const readmitidas = lista?.pages.flatMap((p) => p.data.filter((c) => {
      const negada = negadas.get(c.id);
      return negada && (p.consultaIniciadaEm ?? 0) > negada.negadaEm && c.organization_id === orgId;
    })) ?? [];
    if (!readmitidas.length) return;
    setNegadas((atual) => {
      const novas = new Map(atual);
      for (const conversa of readmitidas) novas.delete(conversa.id);
      return novas;
    });
    for (const conversa of readmitidas) revalidar(conversa.id);
  }, [lista, negadas, orgId, revalidar]);

  const negadaNestaRodada = id !== null && negadas.get(id)?.rodada === rodada;
  const estado = sessaoExpirada ? "sessao-expirada"
    : negadaNestaRodada ? "sem-acesso"
    : !rodada ? "normal"
    : leitura.data ?? (leitura.isError ? "falhou" : "verificando");
  const linhaPermitida = useCallback((conversa: string) =>
    !sessaoExpirada && leitura.data !== "sessao-expirada" && !negadas.has(conversa) && !(leitura.data === "sem-acesso" && id === conversa),
  [sessaoExpirada, negadas, leitura.data, id]);
  const podeAgir = useCallback((conversa: string) =>
    linhaPermitida(conversa) && (conversa !== id || estado === "normal" || estado === "confirmada"),
  [linhaPermitida, id, estado]);
  const registrarFalha = useCallback((err: unknown) => {
    const recusa = recusaDaLeitura(err);
    if (recusa) registrarRecusa(recusa);
  }, [registrarRecusa]);
  const soltarAncora = useCallback(() => setAncora(null), []);

  return {
    estado, linhaPermitida, podeAgir, temRodada, ancora: valorDaAncora,
    tentarDeNovo: () => { void leitura.refetch({ cancelRefetch: false }); },
    registrarFalha, soltarAncora, revalidar,
  };
}

const chavesDaConversa = ["conversation", "messages", "notes", "passagens", "conversation-reply-address"];
const chavesProtegidas = ["conversations", ...chavesDaConversa];

function limparDadosDaConversa(qc: ReturnType<typeof useQueryClient>, id: string, contatoId?: string | null) {
  qc.removeQueries({ predicate: ({ queryKey }) =>
    (queryKey[1] === id && chavesDaConversa.includes(String(queryKey[0])))
    || (!!contatoId && queryKey[1] === contatoId) });
}

type ListaEmCache = InfiniteData<{ data: ConversationWithContact[]; consultaIniciadaEm?: number }>;

export function filtrarListaProtegida<T extends ListaEmCache | undefined>(lista: T, permite: (id: string) => boolean): T {
  if (!lista?.pages.some((p) => p.data.some((c) => !permite(c.id)))) return lista;
  return { ...lista, pages: lista.pages.map((p) => ({ ...p, data: p.data.filter((c) => permite(c.id)) })) };
}

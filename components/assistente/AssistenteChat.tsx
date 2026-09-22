"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Send, X } from "lucide-react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { responder, SUGESTOES_INICIAIS, type LinkDeAjuda, type RespostaDeAjuda } from "./respostas";

interface PropostaUI {
  id: string;
  acao: string;
  titulo: string;
  resumo: string;
  payload: Record<string, unknown>;
  estado: "pendente" | "executando" | "ok" | "erro" | "descartada";
}

interface AtividadeUI {
  ferramenta: string;
  fez: string;
}

interface Mensagem extends RespostaDeAjuda {
  id: number;
  de: "user" | "bot";
  atividade?: AtividadeUI[];
  propostas?: PropostaUI[];
}

let proximoId = 1;
const novaId = () => proximoId++;

const AVISO_IA_DESLIGADA =
  "IA desligada aqui — respondendo no modo básico. Para eu gerar pedidos e notas, cadastre a chave em IA → Credenciais.";

async function lerEnvelope(res: Response): Promise<{ data?: unknown; code?: string; message?: string }> {
  try {
    const corpo = (await res.json()) as { data?: unknown; error?: { code?: string; message?: string } };
    if (!res.ok) return { code: corpo.error?.code, message: corpo.error?.message };
    return { data: corpo.data };
  } catch {
    return { code: "rede", message: "sem resposta do servidor" };
  }
}

/**
 * Janela do assistente — painel ancorado no canto, não modal.
 *
 * Dois cérebros, uma cara: com chave de IA configurada, fala com
 * `/api/v1/assistente/chat` (consulta de verdade, propõe ações); sem chave ou
 * fora do ar, cai para as regras locais (`respostas.ts`) e avisa — chat básico
 * funcionando é melhor que spinner infinito.
 *
 * Escrita SEMPRE com OK humano: a IA só monta a proposta; o botão Confirmar
 * chama `/api/v1/assistente/executar`, que revalida tudo e executa auditado.
 */
export function AssistenteChat({ aberto, onFechar }: { aberto: boolean; onFechar: () => void }) {
  const t = useT();
  const [mensagens, setMensagens] = useState<Mensagem[]>([
    {
      id: novaId(),
      de: "bot",
      texto:
        "Olá! Posso buscar clientes, produtos e pedidos, montar pedidos e tarefas, diagnosticar notas — ou tirar dúvidas de uso. O que precisa?",
      links: [],
    },
  ]);
  const [texto, setTexto] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [avisoDado, setAvisoDado] = useState(false);
  const listaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listaRef.current?.scrollTo({ top: listaRef.current.scrollHeight, behavior: "smooth" });
  }, [mensagens, aberto, ocupado]);

  useEffect(() => {
    if (aberto) setTimeout(() => inputRef.current?.focus(), 80);
  }, [aberto]);

  if (!aberto) return null;

  const historicoParaIA = (lista: Mensagem[]) =>
    lista
      .filter((m) => m.texto && !m.texto.startsWith("IA desligada"))
      .slice(-12)
      .map((m) => ({ papel: m.de === "user" ? "user" : "assistente", texto: m.texto }));

  const enviar = async (pergunta: string) => {
    const limpa = pergunta.trim();
    if (!limpa || ocupado) return;
    const comUsuario: Mensagem[] = [...mensagens, { id: novaId(), de: "user", texto: limpa, links: [] }];
    setMensagens(comUsuario);
    setTexto("");
    setOcupado(true);
    try {
      const res = await fetch("/api/v1/assistente/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mensagens: historicoParaIA(comUsuario) }),
      });
      const env = await lerEnvelope(res);
      if (!res.ok || !env.data) {
        throw new Error(env.code ?? "rede");
      }
      const dados = env.data as {
        resposta: string;
        atividade: AtividadeUI[];
        propostas: { id: string; acao: string; titulo: string; resumo: string; payload: Record<string, unknown> }[];
      };
      setMensagens((atual) => [
        ...atual,
        {
          id: novaId(),
          de: "bot",
          texto: dados.resposta || "Pronto — veja abaixo.",
          links: [],
          atividade: dados.atividade ?? [],
          propostas: (dados.propostas ?? []).map((p) => ({ ...p, estado: "pendente" as const })),
        },
      ]);
    } catch {
      // Sem IA (503 ai_indisponivel) ou sem rede: regras locais + aviso único.
      const local = responder(limpa);
      setMensagens((atual) => [
        ...atual,
        {
          id: novaId(),
          de: "bot",
          texto: avisoDado ? local.texto : `${AVISO_IA_DESLIGADA}\n\n${local.texto}`,
          links: local.links,
        },
      ]);
      setAvisoDado(true);
    } finally {
      setOcupado(false);
    }
  };

  const marcarProposta = (msgId: number, propostaId: string, estado: PropostaUI["estado"]) => {
    setMensagens((atual) =>
      atual.map((m) =>
        m.id === msgId
          ? { ...m, propostas: m.propostas?.map((p) => (p.id === propostaId ? { ...p, estado } : p)) }
          : m,
      ),
    );
  };

  const confirmar = async (msgId: number, proposta: PropostaUI) => {
    marcarProposta(msgId, proposta.id, "executando");
    try {
      const res = await fetch("/api/v1/assistente/executar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acao: proposta.acao, payload: proposta.payload }),
      });
      const env = await lerEnvelope(res);
      if (!res.ok || !env.data) {
        throw new Error(env.message ?? "falhou");
      }
      const feito = env.data as { mensagem: string; link: LinkDeAjuda };
      marcarProposta(msgId, proposta.id, "ok");
      setMensagens((atual) => [...atual, { id: novaId(), de: "bot", texto: `✅ ${feito.mensagem}`, links: [feito.link] }]);
    } catch (err) {
      marcarProposta(msgId, proposta.id, "erro");
      setMensagens((atual) => [
        ...atual,
        {
          id: novaId(),
          de: "bot",
          texto: `Não consegui executar: ${err instanceof Error ? err.message : "erro inesperado"}. Nada foi alterado — revise comigo ou tente de novo.`,
          links: [],
        },
      ]);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Assistente"
      className="flex h-105 w-[calc(100vw-3rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
    >
      <div className="flex items-center gap-2.5 border-b border-border bg-accent px-4 py-3 text-accent-foreground">
        <span aria-hidden className="grid h-8 w-8 place-items-center rounded-full bg-background/20 text-lg leading-none">
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Assistente</p>
          <p className="flex items-center gap-1.5 text-xs opacity-80">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> {ocupado ? t("pensando…") : t("online agora")}
          </p>
        </div>
        <button
          type="button"
          onClick={onFechar}
          aria-label="Fechar assistente"
          className="rounded-md p-1.5 opacity-80 transition hover:bg-background/15 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={listaRef} className="flex-1 space-y-3 overflow-y-auto bg-muted/40 p-3.5" aria-live="polite">
        {mensagens.map((m) => (
          <div key={m.id} className={cn("flex", m.de === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
                m.de === "user"
                  ? "rounded-br-md bg-accent text-accent-foreground"
                  : "rounded-bl-md border border-border bg-background text-text",
              )}
            >
              <p className="whitespace-pre-line">{m.texto}</p>
              {m.atividade && m.atividade.length > 0 && (
                <div className="mt-1.5 space-y-0.5 border-t border-border pt-1.5 text-xs text-text-muted">
                  {m.atividade.map((a, i) => (
                    <p key={`${a.ferramenta}-${i}`} className="flex items-center gap-1.5">
                      <Check className="h-3 w-3 shrink-0 text-emerald-500" /> {a.fez}
                    </p>
                  ))}
                </div>
              )}
              {m.propostas?.map(
                (p) =>
                  p.estado !== "descartada" && (
                    <div key={p.id} className="mt-2 rounded-xl border border-accent/40 bg-accent/5 p-2.5">
                      <p className="text-xs font-semibold">{p.titulo}</p>
                      <p className="mt-1 whitespace-pre-line text-xs text-text-muted">{p.resumo}</p>
                      {p.estado === "pendente" && (
                        <div className="mt-2 flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => confirmar(m.id, p)}
                            className="flex-1 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition hover:opacity-90"
                          >
                            Confirmar
                          </button>
                          <button
                            type="button"
                            onClick={() => marcarProposta(m.id, p.id, "descartada")}
                            className="rounded-full border border-border px-3 py-1.5 text-xs transition hover:bg-muted"
                          >
                            Descartar
                          </button>
                        </div>
                      )}
                      {p.estado === "executando" && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs text-text-muted">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Executando…
                        </p>
                      )}
                      {p.estado === "ok" && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                          <Check className="h-3.5 w-3.5" /> Executado
                        </p>
                      )}
                      {p.estado === "erro" && (
                        <p className="mt-2 text-xs font-medium text-red-600">{t("Falhou — nada foi alterado.")}</p>
                      )}
                    </div>
                  ),
              )}
              {m.links.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {m.links.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent-foreground transition hover:bg-accent/20"
                    >
                      {l.rotulo} →
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {ocupado && (
          <div className="flex justify-start">
            <p className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-border bg-background px-3 py-2 text-xs text-text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Consultando o sistema…
            </p>
          </div>
        )}
        {mensagens.length === 1 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {SUGESTOES_INICIAIS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => enviar(s)}
                className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-text-muted transition hover:border-accent hover:text-text"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-border p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          enviar(texto);
        }}
      >
        <label htmlFor="assistente-pergunta" className="sr-only">
          {t("Peça ao assistente")}
        </label>
        <input
          ref={inputRef}
          id="assistente-pergunta"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={t("Ex.: gere um pedido para Claudio Andrade…")}
          maxLength={500}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-full border border-border bg-background px-3.5 py-2 text-sm outline-hidden placeholder:text-text-muted focus:border-accent"
        />
        <button
          type="submit"
          aria-label="Enviar pergunta"
          disabled={!texto.trim() || ocupado}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  );
}

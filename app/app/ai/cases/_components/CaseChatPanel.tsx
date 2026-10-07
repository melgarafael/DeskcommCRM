"use client";
/**
 * "CONVERSAR SOBRE O CASO" — a consulta interna da equipe à IA que o abriu.
 *
 * ─── Três rótulos que são CONTRATO, não estética ───────────────────────────
 *
 * Dois e2e obrigatórios acham o painel de decisão (`CaseReplyPanel`) por
 * localizador frouxo: `page.locator("textarea").first()` e
 * `getByRole("button", { name: "Enviar", exact: true })`. Por isso, aqui:
 *
 *   1. o painel é montado DEPOIS da decisão no DOM (quem garante é o
 *      `CaseDetail`, e quem mede é `tests/unit/case-detail.test.tsx`);
 *   2. o botão chama "Perguntar" — nunca "Enviar";
 *   3. o placeholder é "Pergunte à IA sobre este caso…", distinto de
 *      "Escreva sua resposta para a IA..." do painel vizinho.
 *
 * Trocar qualquer um dos três deixa DOIS e2e vermelhos com um sintoma que não
 * aponta para cá — daí a guarda barata em `tests/unit/`.
 *
 * ─── Por que TEXTO PURO, e não markdown ───────────────────────────────────
 *
 * O corpo carrega, repetido pelo modelo, o que o CLIENTE escreveu. Não há
 * renderizador de markdown no projeto nem CSP global: interpretar
 * `![](https://x/?q=…)` faria o navegador de quem atende buscar aquela URL —
 * exfiltração pela tela de quem está decidindo o caso. `whitespace-pre-wrap`
 * dá a legibilidade sem abrir isso.
 *
 * ─── O que este painel DELIBERADAMENTE não tem ────────────────────────────
 *
 * · **"Copiar para a nota"** — fecharia o caminho cliente → chat → atendente →
 *   nota → cliente: a nota do humano vira instrução literal ao agente que fala
 *   com o cliente (`lib/agent-engine/agent/case-reply-turn.ts`).
 * · **"Ajudou / não ajudou"** — não existe consumidor para esse sinal. Controle
 *   que a tela oferece e o código ignora é pior que a ausência dele.
 */
import { useId, useState, type ReactNode } from "react";
import { format, type Locale } from "date-fns";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { CitationButton } from "@/components/ai/CitationButton";
import { useCaseChat, useAskCase, type CaseChatMessage } from "@/hooks/ai/useCaseChat";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { fraseDaFalha } from "@/lib/ai/conversa-do-caso/frases";
import { ApiError } from "@/lib/api/types";
import { ChatCircle, PaperPlaneTilt, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/** A rota exige 3 caracteres; o botão respeita o mesmo piso. */
const MINIMO_DA_PERGUNTA = 3;

/**
 * As perguntas prontas PREENCHEM o campo — nunca enviam.
 *
 * Cada envio é uma chamada paga na chave de quem instalou. Um clique acidental
 * numa sugestão que disparasse sozinha gastaria dinheiro sem ninguém ler a
 * pergunta antes.
 */
const SUGESTOES = [
  "Por que a IA não resolveu sozinha?",
  "O que o cliente já tentou?",
  "O que muda se eu concluir agora?",
];

/**
 * Por que quem responde não é o agente que abriu o caso.
 *
 * Tabela de módulo de propósito: é assim que o guarda de espanhol
 * (`tests/unit/i18n-espanhol-cobre-a-tela`) consegue resolver `t(TABELA[x])` e
 * cobrar tradução de cada motivo.
 */
const MOTIVO_DA_PERSONA = {
  sem_agente: "o agente foi removido",
  arquivado: "o agente foi arquivado",
  pausado: "o agente está pausado",
  despublicado: "o agente não tem versão publicada",
} as const;

type MotivoConhecido = keyof typeof MOTIVO_DA_PERSONA;

function ehMotivoConhecido(motivo: string | null): motivo is MotivoConhecido {
  return motivo !== null && motivo in MOTIVO_DA_PERSONA;
}

export function CaseChatPanel({ caseId }: { caseId: string }) {
  const t = useT();
  const locale = useLocaleDeData();
  const { data, isLoading, error: erroDaConsulta } = useCaseChat(caseId);
  const ask = useAskCase();
  const [pergunta, setPergunta] = useState("");
  const campoId = useId();
  const avisoId = useId();

  // ─── A conversa é de outra pessoa ───────────────────────────────────────
  //
  // A rota funde três recusas num 404 de propósito (um 403 confirmaria que o
  // caso existe). Aqui o caso JÁ está na tela — a lista é lida por caminho
  // privilegiado —, então o 404 do chat significa, na prática, que a conversa
  // pertence a outra pessoa. A frase diz o gesto, não o mecanismo.
  if (erroDaConsulta instanceof ApiError && erroDaConsulta.status === 404) {
    return (
      <Moldura t={t}>
        <p className="text-sm text-muted-foreground">
          {t(
            "Este atendimento é de outra pessoa. Peça para ela, ou para quem administra, se precisar acompanhar.",
          )}
        </p>
      </Moldura>
    );
  }

  if (erroDaConsulta) {
    // Falha de leitura: sem saber o estado do contato nem se há chave de IA, a
    // tela não oferece o campo. Fechado na AÇÃO, aberto na INFORMAÇÃO.
    return (
      <Moldura t={t}>
        <p className="text-sm text-muted-foreground">
          {t("Não deu para abrir a conversa do caso agora.")}
        </p>
      </Moldura>
    );
  }

  if (isLoading || !data) {
    return (
      <Moldura t={t}>
        <Skeleton className="h-16 w-full" />
      </Moldura>
    );
  }

  const { mensagens, persona, estado } = data;
  const anonimizado = estado.contato_anonimizado === true;
  const semIa = estado.ia_configurada === false;
  const podePerguntar = !anonimizado && !semIa;
  const podeEnviar = podePerguntar && pergunta.trim().length >= MINIMO_DA_PERGUNTA && !ask.isPending;

  function enviar() {
    if (!podeEnviar) return;
    ask.mutate(
      { id: caseId, pergunta: pergunta.trim() },
      { onSuccess: () => setPergunta("") },
    );
  }

  const nomeDaIa =
    persona?.fonte === "agente_do_caso" && persona.nome
      ? persona.nome
      : t("Assistente da organização");

  return (
    <Moldura t={t}>
      {persona !== null && persona.fonte !== "agente_do_caso" ? (
        <Faixa tom="neutro">
          {t("A IA que abriu este caso não está mais no ar.")}{" "}
          {ehMotivoConhecido(persona.motivo) ? (
            <>({t(MOTIVO_DA_PERSONA[persona.motivo])}){" "}</>
          ) : null}
          {t(
            "Quem responde aqui é o assistente padrão da organização — ele não tem as instruções daquele agente.",
          )}
        </Faixa>
      ) : null}

      {estado.caso_obsoleto === true ? (
        <Faixa tom="aviso">
          {t(
            "O atendimento que originou este caso já foi encerrado e reaberto. A conversa abaixo pode não ser a que gerou o caso.",
          )}
        </Faixa>
      ) : null}

      {/* `null` é DESCONHECIDO, nunca `false`: o GET degrada assim quando o
          banco não responde, e afirmar "está tudo certo" seria inventar. */}
      {estado.caso_obsoleto === null ? (
        <p className="text-xs text-muted-foreground">
          {t("Não deu para conferir se o atendimento mudou.")}
        </p>
      ) : null}

      {estado.contato_bloqueado === true ? (
        <Faixa tom="neutro">
          {t(
            "Este contato pediu para não receber mensagens. Dá para entender o caso aqui, mas nada pode ser enviado a ele.",
          )}
        </Faixa>
      ) : null}

      {/* `tabIndex` porque a área ROLA: sem ele, quem navega por teclado não
          alcança o histórico de um caso com muitas perguntas. */}
      <div
        role="log"
        tabIndex={0}
        aria-live="polite"
        aria-relevant="additions"
        className="flex max-h-[22rem] flex-col gap-3 overflow-y-auto focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-soft"
      >
        {mensagens.length === 0 && !ask.isPending ? (
          <div className="flex flex-col gap-2 py-2">
            <p className="text-sm font-medium">{t("Pergunte antes de decidir.")}</p>
            {podePerguntar ? (
              <div className="flex flex-wrap gap-2">
                {SUGESTOES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    // `t(s)`, não `s`: quem lê em espanhol clicaria num botão em
                    // espanhol e veria o campo preencher em português.
                    onClick={() => setPergunta(t(s))}
                    className="rounded-sm border border-border px-3 py-1.5 text-left text-xs text-text transition-colors hover:border-accent hover:text-accent"
                  >
                    {t(s)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {mensagens.map((m) => (
          <Bolha key={m.id} mensagem={m} nomeDaIa={nomeDaIa} locale={locale} t={t} />
        ))}

        {ask.isPending ? <Pensando t={t} /> : null}
      </div>

      {/* F3 (#1869): os trechos do acervo ligados à última pergunta. Não são
          a fonte da resposta — o modelo não os recebe —, e o texto diz isso.
          Eles voltam no POST (a thread periódica lê só o banco, que não guarda
          a lista — sem migração). Ainda no ar na troca de mensagens; somem num
          recarregamento completo da página, e sem elas a resposta segue
          legível. `length > 0` é a régua: sem acervo não há botão. `?.` porque o
          replay do mesmo `turn_id` volta sem `citacoes`. */}
      {ask.data?.citacoes?.length ? (
        <div className="flex items-center gap-2">
          <CitationButton citations={ask.data.citacoes ?? []} messageId={ask.data.turn_id} />
          <span className="text-xs text-muted-foreground">
            {t("Trechos do acervo ligados à pergunta.")}
          </span>
        </div>
      ) : null}

      {ask.error ? <ErroDaPergunta erro={ask.error} t={t} /> : null}

      {anonimizado ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "Este contato foi anonimizado a pedido dele. A IA não responde sobre casos de contato anonimizado.",
          )}
        </p>
      ) : null}

      {/* Sem chave de IA, um campo que sempre termina em bolha vermelha é pior
          que campo nenhum: gasta o clique e não diz onde configurar. É o estado
          de TODA instalação recém-feita. */}
      {semIa ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm text-muted-foreground">
            {t(
              "Nenhum provedor de IA está configurado. Peça a quem administra para configurar em IA › Provedores.",
            )}
          </p>
          <a className="text-sm text-accent underline underline-offset-2" href="/app/ai/providers">
            {t("Abrir IA › Provedores")}
          </a>
        </div>
      ) : null}

      {podePerguntar ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={campoId} className="text-xs font-medium text-muted-foreground">
            {t("Sua pergunta para a IA")}
          </label>
          <Textarea
            id={campoId}
            data-testid="case-chat-campo"
            aria-describedby={avisoId}
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            onKeyDown={(e) => {
              // A pergunta costuma ter duas frases: `Enter` sozinho quebra
              // linha. Enviar no `Enter` transformaria a segunda frase numa
              // segunda chamada paga.
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                enviar();
              }
            }}
            placeholder={t("Pergunte à IA sobre este caso…")}
            rows={2}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("Ctrl + Enter envia. Enter quebra linha.")}
            </p>
            <Button data-testid="case-chat-enviar" disabled={!podeEnviar} onClick={enviar}>
              <PaperPlaneTilt aria-hidden />
              {ask.isPending ? t("Perguntando…") : t("Perguntar")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* A thread atualiza por consulta periódica, não por push. Sem esta
          linha, dois atendentes no mesmo caso acham que o outro não perguntou. */}
      <p id={avisoId} className="text-xs text-muted-foreground">
        {t("As perguntas dos colegas aparecem aqui em alguns segundos.")}
      </p>
    </Moldura>
  );
}

/** A casca do painel — mesma gramática visual do `CaseReplyPanel` vizinho. */
function Moldura({ t, children }: { t: (s: string) => string; children: ReactNode }) {
  return (
    <section
      data-testid="case-chat"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex items-center gap-2">
        <ChatCircle weight="duotone" aria-hidden className="size-4 text-accent" />
        <h3 className="text-sm font-semibold">{t("Conversar sobre o caso")}</h3>
      </div>
      {/* O antídoto do modo de falha "a IA já avisou o cliente". Permanente de
          propósito: um aviso que some é um aviso que ninguém lê. */}
      <p className="text-xs text-muted-foreground">
        {t(
          "Conversa interna. O cliente não vê nada disto, e a IA aqui não envia mensagem nem muda o caso.",
        )}
      </p>
      {children}
    </section>
  );
}

/**
 * A espera, do lado da IA — pontos + a frase.
 *
 * A frase fica VISÍVEL, e não só para leitor de tela: três pontos sozinhos são
 * um idioma de aplicativo de mensagem, e quem usa este produto não é
 * necessariamente fluente nele. "A IA está lendo o caso…" também diz que a
 * espera tem causa, o que segura o segundo clique.
 *
 * `motion-reduce:animate-none` porque a animação é decorativa: para quem pediu
 * menos movimento, os pontos param e a frase continua contando tudo.
 * (`animate-pulse` é do Tailwind base — o plugin `tailwindcss-animate` NÃO está
 * instalado neste repo, e classes dele ficariam mudas.)
 */
function Pensando({ t }: { t: (s: string) => string }) {
  return (
    <div className="flex items-center gap-2 self-start rounded-sm border-l-2 border-accent bg-accent-soft px-3 py-2">
      <span aria-hidden className="flex items-center gap-1">
        {[0, 150, 300].map((atraso) => (
          <span
            key={atraso}
            style={{ animationDelay: `${atraso}ms` }}
            className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
          />
        ))}
      </span>
      <span className="text-xs text-muted-foreground">{t("A IA está lendo o caso…")}</span>
    </div>
  );
}

function Faixa({ tom, children }: { tom: "neutro" | "aviso"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-sm px-3 py-2 text-xs",
        tom === "aviso" ? "bg-warning-bg text-text" : "bg-accent-soft text-text",
      )}
    >
      {children}
    </p>
  );
}

function Bolha({
  mensagem,
  nomeDaIa,
  locale,
  t,
}: {
  mensagem: CaseChatMessage;
  nomeDaIa: string;
  locale: Locale;
  t: (s: string) => string;
}) {
  const daIa = mensagem.author_kind === "ai";
  const falhou = mensagem.body === null && mensagem.error_code !== null;

  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-sm px-3 py-2",
        falhou
          ? "border border-destructive/40"
          : daIa
            ? "border-l-2 border-accent bg-accent-soft"
            : "self-end border border-border bg-surface-elevated",
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {falhou ? <Warning aria-hidden className="size-3 text-destructive" /> : null}
        {/* O nome do agente vem do banco e NÃO passa por t(): traduzir o nome
            que o operador cadastrou seria reescrever o dado dele. */}
        <span>{daIa ? nomeDaIa : t("Pergunta da equipe")}</span>
        <time dateTime={mensagem.created_at} className="font-mono">
          {format(new Date(mensagem.created_at), "HH:mm", { locale })}
        </time>
      </div>
      <Corpo mensagem={mensagem} t={t} />
    </div>
  );
}

function Corpo({ mensagem, t }: { mensagem: CaseChatMessage; t: (s: string) => string }) {
  if (mensagem.body !== null) {
    // Texto, nunca marcação — ver o cabeçalho deste arquivo.
    return <p className="whitespace-pre-wrap text-sm">{mensagem.body}</p>;
  }
  if (mensagem.error_code !== null) {
    // A FRASE do motivo, nunca o código: `llm_not_configured` não é informação
    // para quem ia decidir o caso, é um enum.
    return <p className="text-sm">{t(fraseDaFalha(mensagem.error_code))}</p>;
  }
  if (mensagem.redacted_at !== null) {
    // A cascata de LGPD zerou o corpo. Bolha vazia pareceria defeito.
    return (
      <p className="text-sm text-muted-foreground">{t("Mensagem apagada a pedido do contato.")}</p>
    );
  }
  return null;
}

function ErroDaPergunta({ erro, t }: { erro: unknown; t: (s: string) => string }) {
  const daApi = erro instanceof ApiError ? erro : null;
  // O 429 da rota fala com quem opera ("Muitas perguntas seguidas"); aqui a
  // frase fala com quem PERGUNTOU, e diz quando voltar.
  const texto =
    daApi === null
      ? t(fraseDaFalha(null))
      : daApi.code === "rate_limited"
        ? t("Você fez muitas perguntas seguidas. Tente de novo em um minuto.")
        : // A rota já traduziu para o idioma da organização, e ela tem contexto
          // que nenhuma frase genérica daqui teria.
          daApi.message;

  return (
    <div className="flex flex-col gap-1 rounded-sm border border-destructive/40 px-3 py-2">
      <p className="text-sm">{texto}</p>
      {daApi !== null && daApi.code !== "rate_limited" ? (
        // O identificador é ANEXO, não a mensagem: quem lê não sabe o que é um
        // uuid, mas quem instalou o sistema sabe o que fazer com ele.
        <p className="text-xs text-muted-foreground">
          <code className="font-mono">{daApi.requestId}</code>
        </p>
      ) : null}
    </div>
  );
}

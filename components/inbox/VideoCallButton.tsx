"use client";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { useT } from "@/hooks/i18n/useT";
import { estadoDaJanela } from "@/lib/channels/janela";
import { copyToClipboard } from "@/lib/clipboard";
import { motivoDaJanelaFechada } from "@/lib/inbox/motivo-do-envio-bloqueado";
import { ArrowSquareOut, VideoCamera } from "@/lib/ui/icons";
import { novaSala, servidorDeVideo, urlDaSala } from "@/lib/video/jitsi";

interface Props {
  /** A conversa de quem envia o link — a sala em si é aleatória (#2441). */
  conversationId: string;
  /** Mesma régua do composer: `channel_sessions.provider` da conversa. */
  provider: string | null;
  /** Mesma régua do composer: `last_inbound_at` da conversa. */
  lastInboundAt: string | null;
  /**
   * O motivo de contato bloqueado/anonimizado, já com o texto do composer
   * (`motivoDoContato`): um lugar decide o que é "não pode enviar".
   */
  bloqueio?: string | null;
  /** Conversa encerrada: desabilita o envio sem texto próprio, como o composer. */
  encerrada?: boolean;
}

/**
 * O BOTÃO "VÍDEO" DO HEADER (#2440) — videochamada por Jitsi Meet.
 *
 * A feature é OPT-IN: sem `JITSI_SERVER_URL` no `.env`, `servidorDeVideo()`
 * devolve `null` e este componente NÃO RENDERIZA (padrão `DialButton` para a
 * voz: esconde, nunca erro).
 *
 * ─── Por que NOVA ABA e não iframe ──────────────────────────────────────────
 *
 * O `next.config.ts` manda `Permissions-Policy: camera=(), microphone=(self)`
 * em TODA rota, e o iframe do Jitsi é outra origem: câmera e microfone saem
 * negados lá dentro (medido no review do #2441 — `{camera:false, microphone:false}`
 * com o header de produção, `true` sem ele). Some o corte de 5 minutos do
 * `meet.jit.si` em chamada embutida (post oficial do Jitsi, 18/05/2023), e o
 * iframe não é um caminho que funcione. A aba nova carrega a página DO Jitsi,
 * com o `Permissions-Policy` e o rate-limit DELES — fora do alcance do nosso
 * header.
 *
 * ─── As duas travas do link ─────────────────────────────────────────────────
 *
 * 1. **Janela de 24h** — a rota `POST /api/v1/messages` só confere a janela
 *    para `api_token`/`ai_agent`; quem envia da tela entra como `user` e ela
 *    NÃO barra (`app/api/v1/messages/_handler.ts`, ~linha 548). Sem isto o
 *    link sairia como texto livre: a rota responde 201 e a plataforma recusa
 *    depois com 131047 — a falha silenciosa da #1614. Por isso o botão usa a
 *    MESMA régua do composer (`estadoDaJanela`, `lib/channels/janela.ts`), não
 *    uma segunda regra.
 * 2. **Bloqueio/encerramento** — `bloqueio` chega pronto do header (texto
 *    do composer) e `encerrada` só desabilita, como o composer faz. `supportReadonly` NÃO entra: ele mora no
 *    `user`, que o header não recebe, e não vou afirmar numa doc uma trava
 *    que não apliquei.
 *
 * A cópia passa por `copyToClipboard` e NUNCA pela API crua de clipboard do
 * navegador: self-host em `http://IP` não tem `isSecureContext`, e lá o
 * clipboard direto nem existe. (A frase é paráfrase de propósito —
 * `lib/clipboard.test.ts` varre os arquivos `"use client"` por essa sequência
 * literal e reprova qualquer ocorrência, comentário incluso.)
 *
 * ─── Por que a mutação mora no diálogo e não aqui ───────────────────────────
 *
 * `useSendMessage()` liga no `QueryClientProvider`. Este componente é montado
 * pelo header em QUALQUER teste de tela, e a maioria não tem provider nenhum:
 * chamar o hook aqui derrubaria `ConversationHeader.test.tsx` e
 * `contato-pessoal-gates.test.tsx` com "No QueryClient set" — foi exatamente
 * o que aconteceu na primeira passada deste review. Como o diálogo só existe
 * com servidor E aberto, o hook passa a rodar só quando há envio a fazer.
 */
export function VideoCallButton({
  conversationId,
  provider,
  lastInboundAt,
  bloqueio,
  encerrada = false,
}: Props) {
  const t = useT();
  const servidor = useMemo(() => servidorDeVideo(), []);
  const [aberto, setAberto] = useState(false);
  // A sala nasce quando o diálogo abre e morre quando ele fecha: nada de
  // gravar, nada de reusar o link da chamada anterior desta conversa.
  const [sala, setSala] = useState<string | null>(null);

  // Reavaliada a cada render, como o selo de janela faz: a régua é uma conta
  // sobre `last_inbound_at`, não estado guardado (cabeçalho de lib/channels/janela.ts).
  const janela = estadoDaJanela(provider, lastInboundAt, new Date());
  const janelaFechada = janela.tipo === "fechada";
  // O MESMO texto do composer, inclusive o da rede sem modelo aprovado.
  const motivoJanela = motivoDaJanelaFechada(janela, provider, t);
  const envioLiberado = !bloqueio && !janelaFechada && !encerrada;

  // Sala nova a cada abertura: fechar e reabrir é OUTRA chamada, e o link da
  // anterior deixa de apontar para este encontro. Nasce AQUI (no gesto de
  // abrir), não num `useEffect` — `set-state-in-effect` é anti-padrão e o
  // efeito só correria depois do render, com o diálogo já aberto e o link
  // ainda nulo.
  const abrir = (vaiAbrir: boolean) => {
    if (vaiAbrir) setSala(novaSala());
    setAberto(vaiAbrir);
  };

  if (!servidor) return null;

  return (
    <>
      <Button
        variant="outline"
        className="shrink-0"
        onClick={() => abrir(true)}
        data-testid="btn-videochamada"
      >
        <VideoCamera size={16} weight="bold" aria-hidden />
        <span>{t("Vídeo")}</span>
      </Button>

      {/* O diálogo só existe ABERTO: é a condição que segura a mutação
          (`useSendMessage`) para dentro — ver o cabeçalho deste arquivo.
          `key={sala}` remonta a cada chamada, então nada da anterior sobrevive. */}
      {aberto && sala && (
        <DialogoVideo
          key={sala}
          conversationId={conversationId}
          sala={sala}
          envioLiberado={envioLiberado}
          bloqueio={bloqueio ?? motivoJanela}
          onFechar={() => abrir(false)}
        />
      )}
    </>
  );
}

/**
 * O diálogo da videochamada — a parte que manda a mensagem.
 *
 * Separado de `VideoCallButton` por um motivo de ordem de hooks: `useSendMessage`
 * exige `QueryClientProvider`, e o botão é montado pelo header em teste de tela
 * que não tem um. Aqui dentro o hook só roda quando o operador abriu a sala,
 * que é quando existe envio para fazer.
 *
 * As travas (`envioLiberado`/`bloqueio`) vêm calculadas do pai: quem decide a
 * régua é quem tem `provider` e `last_inbound_at`, e recalculá-las aqui seria
 * uma segunda verdade.
 */
function DialogoVideo({
  conversationId,
  sala,
  envioLiberado,
  bloqueio,
  onFechar,
}: {
  conversationId: string;
  sala: string;
  envioLiberado: boolean;
  /** O motivo pronto para mostrar — janela fechada ou bloqueio do composer. */
  bloqueio: string | null;
  onFechar: () => void;
}) {
  const t = useT();
  const enviar = useSendMessage();
  const url = urlDaSala(servidorDeVideo(), sala);

  const copiar = useCallback(async () => {
    if (!url) return;
    // `copyToClipboard` e nunca a API crua de clipboard: self-host em
    // http://IP não tem isSecureContext, e lá o clipboard direto nem existe.
    const ok = await copyToClipboard(url);
    if (ok) toast.success(t("Link da videochamada copiado."));
    else
      toast.error(t("Não consegui copiar o link. Selecione e copie da barra de endereço."));
  }, [url, t]);

  const enviarLink = useCallback(() => {
    if (!url) return;
    enviar.mutate(
      { conversation_id: conversationId, body: url },
      {
        onSuccess: () => {
          toast.success(t("Link da videochamada enviado na conversa."));
          onFechar();
        },
        onError: () => {
          // O erro detalhado já vem do showApiError; aqui só o convite a
          // copiar o link, que é a saída que não depende do canal.
          toast.error(t("Não consegui enviar o link. Copie e cole na conversa."));
        },
      },
    );
  }, [url, conversationId, enviar, t, onFechar]);

  return (
    <Dialog open onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{t("Videochamada")}</DialogTitle>
          <DialogDescription>
            {t(
              "A sala abre em uma aba nova: é lá que o navegador pede câmera e microfone.",
            )}
          </DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {t(
            "Envie o link pelo chat e o contato entra pelo celular, sem instalar nada. A sala vale só para esta chamada.",
          )}
        </p>

        {url && (
          <Button asChild className="w-full justify-between" data-testid="btn-abrir-sala">
            {/* target="_blank" + rel="noopener": a aba nova não recebe
                `window.opener` — sem isso, a sala aberta manipularia a tela
                do atendimento de quem abriu. */}
            <a href={url} target="_blank" rel="noopener noreferrer">
              <span className="truncate">{t("Abrir sala em nova aba")}</span>
              <ArrowSquareOut size={16} aria-hidden />
            </a>
          </Button>
        )}

        {/* A trava NÃO some: o operador precisa ver POR QUE o link não sai,
            senão ele descobre a regra pelo erro da plataforma (#1614). */}
        {!envioLiberado && bloqueio && (
          <p
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            data-testid="video-bloqueio"
          >
            {bloqueio}
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onFechar}>
            {t("Fechar")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={copiar} data-testid="btn-copiar-link-video">
              {t("Copiar link")}
            </Button>
            <Button
              onClick={enviarLink}
              disabled={enviar.isPending || !envioLiberado}
              data-testid="btn-enviar-link-video"
            >
              {enviar.isPending ? t("Enviando…") : t("Enviar link na conversa")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

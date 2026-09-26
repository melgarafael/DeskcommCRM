"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { format } from "date-fns";
import { useT } from "@/hooks/i18n/useT";
import { ArrowBendUpLeft, CaretDown, Check, Checks, PencilSimple, Robot, Trash, WarningOctagon } from "@/lib/ui/icons";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { ContactCard } from "@/components/inbox/media/ContactCard";
import { LocationCard } from "@/components/inbox/media/LocationCard";
import { localizacaoDaMensagem } from "@/lib/messaging/localizacao";
import {
  extractCitations,
  isAiGeneratedMessage,
} from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  debugCitations?: boolean;
  /** Escolher esta mensagem para responder "em cima" dela. */
  onResponder?: (m: Message) => void;
  /** A mensagem citada por ESTA, quando houver — desenha o fio. */
  citada?: Message | null;
  /**
   * QUEM está lendo a conversa. É o que separa "Você" de "Atendente": a coluna
   * `sent_via='user'` só diz *"um humano digitou no CRM"*, nunca QUAL humano.
   *
   * Sem este id, uma organização com dois atendentes mostrava "Você" nas
   * mensagens do colega — cada um lia o atendimento do outro como se fosse o
   * seu. Por isso a ausência do id NÃO cai em "Você": quem não sabe quem está
   * lendo (a leitura do super-admin em `AdminThread`, por exemplo) rotula
   * "Atendente", que é verdadeiro para todo mundo.
   */
  viewerUserId?: string | null;
  onEditar?: (text: string) => Promise<void>;
  onApagar?: () => Promise<void>;
  onOcultar?: () => Promise<void>;
  onRestaurar?: () => Promise<void>;
}

function AckIndicator({ status, t }: { status: string; t: (texto: string) => string }) {
  if (status === "read") {
    return <Checks size={12} weight="bold" className="text-blue-400" aria-label={t("Lida")} />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label={t("Entregue")} />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label={t("Enviada")} />;
  }
  return null;
}

export function MessageBubble({
  message,
  debugCitations,
  onResponder,
  citada,
  viewerUserId,
  onEditar,
  onApagar,
  onOcultar,
  onRestaurar,
}: Props) {
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState(message.body ?? "");
  const [apagando, setApagando] = useState(false);
  const [ocultando, setOcultando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const salvandoEdicao = useRef(false);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const abrindoEdicao = useRef(false);
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setAgora(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!editando) return;
    // O editor aumenta a altura da última bolha; sem rolar o fio, os botões
    // ficam escondidos atrás da área de resposta até a pessoa usar o mouse.
    editorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [editando]);
  const localeDaData = useLocaleDeData();
  const t = useT();
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: localeDaData });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  const isContact = message.type === "contact";
  // Pino com coordenadas: o cartão substitui o corpo, que é só o mesmo link em texto.
  const localizacao = localizacaoDaMensagem(message);
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
  // Apagada pelo autor ("apagar para todos"). A linha continua no histórico —
  // sumir com ela deixaria a resposta seguinte respondendo ao nada —, mas o
  // texto não aparece: mostrá-lo seria expor justamente o que o cliente pediu
  // para tirar do ar.
  const apagada = Boolean(message.revoked_at);
  const ocultaNoCrm = Boolean(message.metadata?.crm_hidden_at);
  const editada = Boolean(message.edited_at) && !apagada;
  const enviadaPeloAtendente = isOutbound && ["user", "crm"].includes(message.sent_via)
    && Boolean(message.external_id) && !apagada
    && ["sent", "delivered", "read"].includes(message.status);
  const podeEditar = enviadaPeloAtendente && message.type === "text" && Boolean(message.body)
    && agora - new Date(message.sent_at).getTime() <= 15 * 60 * 1000;
  const podeApagar = enviadaPeloAtendente && Boolean(onApagar);
  const podeOcultar = !isOutbound && !apagada && Boolean(ocultaNoCrm ? onRestaurar : onOcultar);
  const temMenu = Boolean(onResponder || (podeEditar && onEditar) || podeApagar || podeOcultar);
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  const showCitationButton =
    isOutbound && aiGenerated && (debugCitations ?? false);
  // De quem saiu esta linha. `external_device` é a resposta pelo CELULAR — o
  // operador atendeu pelo WhatsApp do telefone, fora do CRM, e o ingest carimba
  // aqui. Antes isto voltava null para tudo que não fosse IA, e a bolha ficava
  // sem nome: o dono lia a conversa como se tudo tivesse sido digitado no CRM.
  // Os rótulos passam por t() no render (ver dicionario.ts para o espanhol).
  //
  // `'automation'` é a categoria de quem não é pessoa nem IA: regra de
  // automação, texto fixo do follow-up e lembrete de agenda (#652, decidida pelo
  // mantenedor em 16/09). Enquanto ninguém gravava o valor, um ramo aqui seria
  // controle decorativo — a tela oferecendo uma distinção que o motor não fazia.
  // O carimbo vive em `origemDaMensagem` (`app/api/v1/messages/_handler.ts`) e o
  // par é vigiado nas duas direções por tests/unit/rotulo-de-origem-tem-emissor.
  const senderLabel = (() => {
    if (!isOutbound) return null;
    // #1613: a autoria "em nome de" sobe a MESA. Quem apertou foi o token, mas
    // quem decidiu foi uma pessoa no outro sistema — sem este ramo a conversa
    // leria "Sistema" e perderia quem mandou. Os nomes vêm GRAVADOS na própria
    // linha (`metadata.sent_on_behalf`, escrito pelo handler), porque o balão
    // não faz join: o que não está na linha não aparece em lugar nenhum.
    const emNomeDe = message.sent_on_behalf_of_user_id
      ? (message.metadata?.sent_on_behalf as
          | { user_name?: string | null; token_name?: string | null }
          | undefined)
      : undefined;
    if (emNomeDe) {
      const nome = emNomeDe.user_name?.trim() || t("Atendente");
      // "Fulano · via {token}": só a palavra "via" passa por `t()`; os nomes
      // são dado do operador e saem como cadastrados — traduzir nome próprio é
      // o mesmo erro de #1046.
      return emNomeDe.token_name ? `${nome} · ${t("via")} ${emNomeDe.token_name}` : nome;
    }
    if (message.sent_via === "ai") return "IA";
    // A REGRA falou, e não a IA: texto fixo de automação, follow-up ou lembrete
    // de agenda (#652). O ramo passou a existir porque o valor passou a ser
    // gravado — antes dele, um rótulo aqui seria promessa sem dado atrás.
    if (message.sent_via === "automation") return "Automação";
    // A integração falou, a IA não. Sem este ramo a bolha omite a autoria e o
    // dono lê a conversa como se tudo tivesse saído do CRM — que é o defeito do
    // #866 visto de dentro da tela.
    if (message.sent_via === "system") return "Sistema";
    if (message.sent_via === "external_device") return "Celular";
    if (message.sent_via === "user" || message.sent_via === "crm") {
      // "Você" exige as DUAS pontas: saber quem lê e saber quem enviou. Falta
      // qualquer uma, o rótulo cai para "Atendente" — que continua dizendo o
      // que `sent_via` de fato garante (um humano, pelo CRM) sem afirmar uma
      // identidade que o dado não sustenta.
      return viewerUserId != null && message.sent_by_user_id === viewerUserId
        ? "Você"
        : "Atendente";
    }
    return null;
  })();

  async function salvarEdicao() {
    const novoTexto = texto.trim();
    if (!onEditar || !novoTexto || salvandoEdicao.current) return;
    // Enter e clique podem chegar antes de React atualizar `ocupado`; o ref
    // impede duas chamadas ao WhatsApp para a mesma edição.
    salvandoEdicao.current = true;
    setOcupado(true);
    try { await onEditar(novoTexto); setEditando(false); }
    catch { /* O hook mostra o erro; manter o texto para nova tentativa. */ }
    finally { salvandoEdicao.current = false; setOcupado(false); }
  }

  return (
    <div
      className={cn(
        "group flex w-full min-w-0 items-center gap-1 px-4 py-1",
        isOutbound ? "justify-end" : "justify-start",
      )}
    >
      <div
        // Identidade, não aparência. O e2e de citação contava bolhas por
        // `[class*='rounded-2xl']`, e qualquer componente novo com a mesma
        // classe utilitária entrava na conta — foi assim que o painel flutuante
        // fez a spec achar que havia mensagem onde não havia (issue #1318).
        data-testid="message-bubble"
        className={cn(
          "relative max-w-[75%] min-w-0 text-sm",
          isBareSticker
            ? "px-0 py-0"
            : cn(
                "rounded-2xl px-3 py-2 shadow-sm",
                temMenu && "pr-8",
                isOutbound
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground",
              ),
          isFailed && "border border-destructive",
          apagada && "opacity-70",
        )}
      >
        {temMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={t("Opções da mensagem")} disabled={ocupado}
                className={cn(
                  "absolute right-1 top-1 z-10 rounded-md p-0.5 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-1",
                  "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                  isOutbound ? "text-primary-foreground hover:bg-primary-foreground/15" : "text-muted-foreground hover:bg-background/70",
                )}>
                <CaretDown size={16} weight="bold" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={isOutbound ? "end" : "start"} sideOffset={4}
              onCloseAutoFocus={(event) => {
                if (!abrindoEdicao.current) return;
                // O Radix devolve o foco à setinha ao fechar o menu. Isso rola o
                // fio de volta e esconde o Salvar logo depois de abrir o editor.
                event.preventDefault();
                abrindoEdicao.current = false;
                editorRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
                editorRef.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
              }}>
              {onResponder && (
                <DropdownMenuItem onSelect={() => onResponder(message)}>
                  <ArrowBendUpLeft size={16} aria-hidden />{t("Responder a esta mensagem")}
                </DropdownMenuItem>
              )}
              {podeEditar && onEditar && (
                <DropdownMenuItem onSelect={() => {
                  abrindoEdicao.current = true;
                  setTexto(message.body ?? "");
                  setEditando(true);
                }}>
                  <PencilSimple size={16} aria-hidden />{t("Editar mensagem")}
                </DropdownMenuItem>
              )}
              {podeApagar && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setApagando(true)} className="text-destructive focus:text-destructive">
                    <Trash size={16} aria-hidden />{t("Apagar para todos")}
                  </DropdownMenuItem>
                </>
              )}
              {podeOcultar && (ocultaNoCrm ? onRestaurar : onOcultar) && (
                <DropdownMenuItem onSelect={() => {
                  if (ocultaNoCrm && onRestaurar) void onRestaurar().catch(() => undefined);
                  else setOcultando(true);
                }}>
                  {ocultaNoCrm ? <PencilSimple size={16} aria-hidden /> : <Trash size={16} aria-hidden />}
                  {t(ocultaNoCrm ? "Restaurar no CRM" : "Ocultar no CRM")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/*
          A CITAÇÃO, dentro da bolha e acima do texto — o fio.

          Mostra de quem era e um trecho. `line-clamp-2` porque serve para
          reconhecer, não para reler: a original está logo acima no histórico.
        */}
        {citada && (
          <div
            className={cn(
              "mb-1 rounded-md border-l-2 px-2 py-1 text-xs",
              isOutbound
                ? "border-primary-foreground/50 bg-primary-foreground/10"
                : "border-primary bg-background/60",
            )}
          >
            <div className="font-medium opacity-80">
              {citada.direction === "outbound" ? t("Você") : t("Cliente")}
            </div>
            {/*
              A CITADA PODE TER SIDO APAGADA — e aí o texto dela não volta aqui.

              A bolha principal já trata isto (`apagada`, acima): "mostrá-lo
              seria expor justamente o que o cliente pediu para tirar do ar". A
              citação é o mesmo texto, num segundo lugar da tela — sem esta
              linha, o "apagar para todos" do cliente sumia da bolha original e
              continuava legível dentro de cada resposta que a citou. O fio
              permanece (a citação some, não a resposta); o conteúdo, não.
            */}
            <div className={cn("line-clamp-2 wrap-anywhere opacity-70", Boolean(citada.revoked_at || citada.metadata?.crm_hidden_at) && "italic")}>
              {citada.revoked_at
                ? t("Esta mensagem foi apagada")
                : citada.metadata?.crm_hidden_at
                ? t("Mensagem ocultada no CRM")
                : citada.body?.trim() || t("(sem texto)")}
            </div>
          </div>
        )}
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold opacity-80">
            {senderLabel === "IA" ? (
              <Robot size={10} weight="duotone" aria-hidden />
            ) : null}
            {senderLabel && t(senderLabel)}
          </div>
        )}

        {editando ? (
          <div ref={editorRef} className="space-y-2">
            <textarea
              aria-label={t("Editar mensagem")}
              value={texto}
              onChange={(event) => setTexto(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void salvarEdicao();
                }
              }}
              maxLength={4096}
              className="min-h-20 w-full rounded-md border border-border bg-background p-2 text-foreground"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setEditando(false)}>{t("Cancelar")}</Button>
              <Button size="sm" disabled={ocupado || !texto.trim()} onClick={() => void salvarEdicao()}>{t("Salvar")}</Button>
            </div>
          </div>
        ) : apagada ? (
          <div className="space-y-1">
            <p className="italic leading-snug opacity-70">{t("Esta mensagem foi apagada")}</p>
            {/* O WhatsApp revoga o envio; o CRM conserva o corpo para auditoria
                interna. Não revelamos texto de uma mensagem apagada pelo cliente. */}
            {isOutbound && message.body && (
              <div className="border-t border-current/20 pt-1">
                <p className="text-[10px] opacity-70">{t("Visível só aqui no CRM")}</p>
                <p className="whitespace-pre-wrap wrap-anywhere leading-snug">{message.body}</p>
              </div>
            )}
          </div>
        ) : ocultaNoCrm ? (
          <p className="whitespace-pre-wrap wrap-anywhere italic leading-snug opacity-60">
            {t("Mensagem ocultada no CRM")}
          </p>
        ) : (
          <>
            {hasMedia && (
              <div className={cn(message.body && "mb-1")}>
                <MediaRenderer message={message} />
              </div>
            )}

            {isContact && !hasMedia && (
              <div className={cn(message.body && isContact && "mb-1")}>
                <ContactCard message={message} />
              </div>
            )}

            {localizacao && <LocationCard localizacao={localizacao} />}

            {message.body && !isContact && !localizacao && (
              <p className="whitespace-pre-wrap wrap-anywhere leading-snug">{message.body}</p>
            )}
          </>
        )}

        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            isOutbound ? "text-primary-foreground" : "text-muted-foreground",
          )}
        >
          {editada && (
            // Ao lado da hora, não no corpo: o texto mostrado JÁ é o novo, e o
            // que falta é avisar que ele mudou. Sem isso, um combinado de preço
            // ou endereço é lido como se sempre tivesse dito aquilo — e a
            // divergência só aparece quando alguém cobra o que não foi.
            <span title={t("O autor editou esta mensagem")}>{t("editada")}</span>
          )}
          <span>{time}</span>
          {showCitationButton && (
            <CitationButton citations={citations} messageId={message.id} />
          )}
          {isOutbound && !isFailed && <AckIndicator status={message.status} t={t} />}
          {isFailed && (
            // Provider local: o painel do inbox não tem TooltipProvider ancestral e
            // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
            // conversa com falha de envio derrubava o painel inteiro (error boundary).
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                    <WarningOctagon size={10} weight="fill" aria-hidden /> {t("Falhou")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {message.error_message ? t(message.error_message) : (message.error_code ?? t("Erro desconhecido"))}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
      <AlertDialog open={apagando} onOpenChange={setApagando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Apagar mensagem para todos?")}</AlertDialogTitle>
            <AlertDialogDescription>{t("O WhatsApp tentará remover esta mensagem também para o cliente.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ocupado}>{t("Cancelar")}</AlertDialogCancel>
            <Button variant="destructive" disabled={ocupado} onClick={async () => {
              if (!onApagar) return;
              setOcupado(true);
              try { await onApagar(); setApagando(false); }
              catch { /* Mantém a confirmação aberta se o canal recusar. */ }
              finally { setOcupado(false); }
            }}>{t("Apagar para todos")}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={ocultando} onOpenChange={setOcultando}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Ocultar esta mensagem no CRM?")}</AlertDialogTitle>
            <AlertDialogDescription>{t("A mensagem continua no WhatsApp do cliente e no registro da empresa. Um gestor pode restaurá-la aqui.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={ocupado}>{t("Cancelar")}</AlertDialogCancel>
            <Button variant="destructive" disabled={ocupado} onClick={async () => {
              if (!onOcultar) return;
              setOcupado(true);
              try { await onOcultar(); setOcultando(false); }
              catch { /* O hook já informa a falha; preservar a confirmação. */ }
              finally { setOcupado(false); }
            }}>{t("Ocultar no CRM")}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

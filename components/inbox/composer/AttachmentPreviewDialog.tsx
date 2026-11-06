"use client";
import { useEffect, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileText, X } from "@/lib/ui/icons";
import { formatBytes } from "@/components/inbox/media/media-utils";
import { anexoLevaLegenda } from "@/components/inbox/media/legenda-do-anexo";

interface Props {
  /**
   * Uma FILA, não um arquivo (#2526).
   *
   * O "+" do composer escolhe uma e a lista tem um; a resposta rápida traz as
   * várias que o operador carregou no template. As duas continuam no MESMO
   * diálogo porque é o mesmo contrato: preview, legenda, remover e só então
   * enviar — o operador aprova antes de qualquer byte sair.
   *
   * A LEGENDA só aparece quando ALGUM anexo da fila a leva (#3151): áudio não
   * leva legenda em nenhum adaptador de canal de `lib/channels/` (ver
   * `anexoLevaLegenda`), então pedir o texto
   * é escrever algo que nunca chega. Fila mista mantém o campo — a legenda vai
   * com a imagem.
   */
  files: File[];
  /**
   * O texto da resposta rápida, que entra como legenda da PRIMEIRA imagem —
   * o mesmo contrato do envio de mídia que já existe. `null` no caminho do
   * "+", onde a legenda nasce vazia.
   */
  legendaInicial?: string | null;
  /**
   * A fila vai para uma NOTA INTERNA, não para o canal. Ali o texto é o corpo
   * da nota e aparece ao lado do anexo — inclusive de um áudio —, então o campo
   * fica sempre: a régua de #3151 vale só para o que sai ao cliente.
   */
  notaInterna?: boolean;
  sending: boolean;
  onCancel: () => void;
  onSend: (caption: string) => void;
  /**
   * Tira UM item da fila antes do envio (#2526: "o operador pode remover
   * imagem antes de enviar"). Leva a legenda do momento para que tirar uma
   * imagem não apague o que o operador já editou.
   */
  onRemove?: (indice: number, caption: string) => void;
}

/** Preview antes do envio (padrão WhatsApp): capa, demais imagens e legenda. */
export function AttachmentPreviewDialog({
  files,
  legendaInicial = null,
  notaInterna = false,
  sending,
  onCancel,
  onSend,
  onRemove,
}: Props) {
  const t = useT();
  const [caption, setCaption] = useState(legendaInicial ?? "");
  // A legenda é reposta NA MESMA renderização em que a fila muda, e não num
  // efeito depois dela: com o efeito, um Enviar entre a troca da fila e o
  // efeito mandava a legenda velha junto da imagem do retry (#2526).
  const [base, setBase] = useState({ files, legendaInicial });
  if (base.files !== files || base.legendaInicial !== legendaInicial) {
    setBase({ files, legendaInicial });
    setCaption(legendaInicial ?? "");
  }

  // PAR resolvido de uma vez: arquivo + URL do preview. É o que mantém
  // `noUncheckedIndexedAccess` feliz (nenhum índice cru vira `src`) e mantém a
  // ordem da fila casada com a ordem de envio.
  const itens = useMemo(
    () =>
      files.map((file) => ({
        file,
        url: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null,
      })),
    [files],
  );
  useEffect(
    () => () => {
      for (const item of itens) if (item.url) URL.revokeObjectURL(item.url);
    },
    [itens],
  );

  const capa = itens.at(0);
  if (!capa) return null;
  const demais = itens.slice(1);
  const isImage = capa.file.type.startsWith("image/");
  const isVideo = capa.file.type.startsWith("video/");
  /**
   * A fila leva legenda se ALGUM anexo dela leva (#3151). Com fila só de
   * áudio não há campo: o texto que o atendente escrevesse não teria por onde
   * sair — os adaptadores de canal mandam o áudio sem `caption`.
   */
  const levaLegenda = notaInterna || files.some(anexoLevaLegenda);
  /**
   * A saída do diálogo é UMA: sem anexo que leve legenda, o envio não leva
   * texto nenhum — o `caption` do momento só vale onde algum anexo o leva, e
   * mandá-lo junto do áudio é entregá-lo a quem o descarta.
   */
  const enviar = () => onSend(levaLegenda ? caption.trim() : "");

  const remover = (indice: number) =>
    onRemove && (
      <button
        type="button"
        onClick={() => onRemove(indice, caption.trim())}
        disabled={sending}
        aria-label={t("Remover imagem")}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <X size={12} weight="bold" aria-hidden />
      </button>
    );

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Enviar anexo")}</DialogTitle>
        </DialogHeader>
        <div className="relative flex items-center justify-center rounded-lg bg-muted/40 p-3">
          {remover(0)}
          {isImage && capa.url && (
            <img src={capa.url} alt={capa.file.name} className="max-h-64 rounded-md object-contain" />
          )}
          {isVideo && capa.url && <video src={capa.url} controls className="max-h-64 rounded-md" />}
          {!isImage && !isVideo && (
            <div className="flex items-center gap-3 py-4">
              <FileText size={28} weight="duotone" className="text-primary" aria-hidden />
              <div className="text-sm">
                <p className="font-medium">{capa.file.name}</p>
                <p className="text-xs text-muted-foreground">{formatBytes(capa.file.size)}</p>
              </div>
            </div>
          )}
        </div>
        {/*
          As demais imagens da fila (#2526): a PRIMEIRA é a capa e leva a
          legenda; estas entram em seguida, cada uma como sua mensagem, na
          MESMA ordem em que aparecem aqui — trocar a ordem na tela sem trocar
          na fila mandaria as fotos fora de ordem.
        */}
        {demais.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {demais.map((item, i) => (
              <li key={`${item.file.name}-${i}`} className="relative">
                {item.file.type.startsWith("image/") && item.url ? (
                  <img
                    src={item.url}
                    alt={item.file.name}
                    className="size-14 rounded-md border border-border object-cover"
                  />
                ) : (
                  <div className="flex size-14 items-center justify-center rounded-md border border-border bg-muted/40">
                    <FileText size={18} weight="duotone" className="text-muted-foreground" aria-hidden />
                  </div>
                )}
                {remover(i + 1)}
              </li>
            ))}
          </ul>
        )}
        {/*
          O CAMPO DE LEGENDA SÓ APARECE ONDE A LEGENDA CHEGA (#3151). Numa fila
          só de áudio ele não é renderizado: nenhum adaptador de canal manda
          `caption` em áudio, e o atendente escrevia um texto que nunca saía. Na fila MISTA
          ele continua — a legenda viaja com o primeiro anexo que a aceita.
        */}
        {levaLegenda && (
          <Input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder={t("Legenda (opcional)")}
            aria-label={t("Legenda")}
            onKeyDown={(e) => e.key === "Enter" && !sending && enviar()}
          />
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={sending}>
            {t("Cancelar")}
          </Button>
          <Button onClick={enviar} disabled={sending}>
            {t("Enviar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

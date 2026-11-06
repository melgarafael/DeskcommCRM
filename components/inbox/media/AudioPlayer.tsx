"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "@/hooks/i18n/useT";

import { toast } from "sonner";

import { CircleNotch, Pause, Play } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

const RATES = [1, 1.5, 2] as const;

/** O que o Safari antigo do iPhone não toca e a rota sabe converter (`?formato=aac`). */
const CONVERTIVEIS = new Set(["audio/ogg", "audio/webm", "audio/opus"]);

function convertivel(mime: string | null | undefined): boolean {
  return CONVERTIVEIS.has((mime ?? "").split(";")[0]!.trim().toLowerCase());
}

/**
 * O aparelho toca este áudio COM CERTEZA? Aí um erro do `<audio>` é a mídia
 * (canal fora, Storage sem assinar), não o formato, e converter não salva.
 * Sem codec no mime a pergunta leva `codecs=opus`: o Chrome diz só "maybe"
 * para `audio/ogg` puro.
 * ponytail: supõe opus, o codec de toda nota de voz; um ogg/vorbis sem codec
 * no mime cairia na conversão à toa (só custa uma ida ao ffmpeg).
 */
function tocaComCerteza(el: HTMLAudioElement, mime: string): boolean {
  const comCodec = mime.includes("codecs") ? mime : `${mime}; codecs="opus"`;
  return el.canPlayType(comCodec) === "probably";
}

/** O que o aparelho toca não muda enquanto a página vive: não há a que se inscrever. */
const semInscricao = () => () => {};

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Props {
  messageId: string;
  isOutbound: boolean;
  /** Fonte alternativa para mídia de NOTA interna (#1863, F3) — ver ImageMedia. */
  src?: string;
  /**
   * O mime gravado na mensagem. Com ele o player pergunta ao aparelho se toca
   * (`canPlayType`) e, se não, converte sob demanda (F2). Nota interna (`src`)
   * fica de fora: a rota de nota não tem `?formato`.
   */
  mime?: string | null;
}

/** Player de voz estilo WhatsApp: play/pause, progresso seekável, tempo, 1x/1.5x/2x. */
export function AudioPlayer({ messageId, isOutbound, src, mime }: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  // Buscando a versão convertida: o botão diz que espera e ignora toques —
  // um 2º toque pediria outra conversão e trocaria o áudio no meio.
  const [carregando, setCarregando] = useState(false);
  // Modo conversão (F2): o aparelho não toca este formato. O `<audio>` fica sem
  // `src` até o toque, e o toque toca a versão AAC por `blob:` — em memória,
  // nunca em Cache Storage nem IndexedDB (D4 da ADR-0006).
  const [erroLigouConversao, setErroLigouConversao] = useState(false);
  const blobRef = useRef<string | null>(null);
  const podeConverter = !src && convertivel(mime);
  // O que o aparelho responde para este mime. `null` no servidor e na
  // hidratação: ali ninguém sabe o que o aparelho toca, e o `<audio>` nasce SEM
  // src. Com src no primeiro commit, o WebKit já baixa o ogg, falha e guarda o
  // erro no elemento — e o `play()` do toque é recusado sem destravá-lo:
  // viravam dois toques.
  const resposta = useSyncExternalStore(
    semInscricao,
    () => (podeConverter && mime ? document.createElement("audio").canPlayType(mime) : "nao-se-aplica"),
    () => null,
  );
  const conversao = erroLigouConversao || resposta === "";

  useEffect(
    () => () => {
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    },
    [],
  );

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    // O `canPlayType` pode mentir ("maybe"): o erro de decodificação liga a
    // conversão UMA vez. Indisponível só quando a cópia convertida também
    // falha, ou quando não há o que converter.
    const onError = () => {
      const jaConvertido = blobRef.current && el.src === blobRef.current;
      if (podeConverter && mime && !jaConvertido && !tocaComCerteza(el, mime)) setErroLigouConversao(true);
      else setFailed(true);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("durationchange", onMeta);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("durationchange", onMeta);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, [podeConverter, mime]);

  if (failed) return <MediaUnavailable kind="Áudio" className="h-12 w-60" />;

  // ponytail: OGG streams report Infinity at loadedmetadata; self-heal when refined
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  // O rótulo só vira "Pausar" quando o play() RESOLVE. Se o Safari recusar
  // (fora do gesto, depois de um await), o botão volta a "Reproduzir" e o
  // segundo toque toca — em vez de mostrar "tocando" num áudio mudo.
  const tocar = (el: HTMLAudioElement) =>
    el.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );

  const tocarConvertido = async (el: HTMLAudioElement) => {
    // Chamado ainda DENTRO do gesto, antes do fetch: é o que destrava o
    // elemento no WebKit para o play() de depois do await. Sem src, rejeita —
    // e tudo bem.
    el.play().catch(() => {});
    setCarregando(true);
    try {
      const resposta = await fetch(`${mediaSrc(messageId)}?formato=aac`, { cache: "no-store" });
      // Teto de conversões (429) ou conversor ocupado (503) é espera, não
      // defeito: o botão fica, e o próximo toque tenta de novo.
      if (resposta.status === 429 || resposta.status === 503) {
        toast.warning(t("Muitas conversões de áudio seguidas. Tente em um minuto."));
        return;
      }
      if (!resposta.ok) throw new Error(String(resposta.status));
      blobRef.current = URL.createObjectURL(await resposta.blob());
    } catch {
      setFailed(true);
      return;
    } finally {
      setCarregando(false);
    }
    el.src = blobRef.current;
    if (RATES[rateIdx] !== 1) el.playbackRate = RATES[rateIdx]!;
    await tocar(el);
  };

  const toggle = () => {
    const el = audioRef.current;
    if (!el || carregando) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else if (conversao && !blobRef.current) {
      void tocarConvertido(el);
    } else {
      void tocar(el);
    }
  };

  const cycleRate = () => {
    const next = (rateIdx + 1) % RATES.length;
    setRateIdx(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next]!;
  };

  const seek = (value: number) => {
    if (audioRef.current) audioRef.current.currentTime = value;
    setCurrent(value);
  };

  return (
    <div className="flex w-60 items-center gap-2 py-1">
      {/* Em conversão o src sai do render e é posto à mão (blob:). Por isso o
          React nunca mais o toca: regravar o mesmo src recarregaria o áudio. */}
      <audio
        ref={audioRef}
        src={resposta === null || conversao ? undefined : (src ?? mediaSrc(messageId))}
        preload="metadata"
      />
      <button
        type="button"
        aria-label={playing ? t("Pausar áudio") : t("Reproduzir áudio")}
        aria-busy={carregando || undefined}
        onClick={toggle}
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors lg:h-9 lg:w-9",
          isOutbound
            ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
            : "bg-primary/10 text-primary hover:bg-primary/20",
        )}
      >
        {carregando ? (
          <CircleNotch size={16} weight="bold" className="motion-safe:animate-spin" aria-hidden />
        ) : playing ? (
          <Pause size={16} weight="fill" aria-hidden />
        ) : (
          <Play size={16} weight="fill" aria-hidden />
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="range"
          aria-label={t("Progresso do áudio")}
          aria-valuetext={`${fmt(current)} ${t("de")} ${fmt(safeDuration)}`}
          min="0"
          max={String(safeDuration || 1)}
          step="0.1"
          value={current}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-current"
        />
        <span className="text-[10px] tabular-nums opacity-70">
          {fmt(current)} / {fmt(safeDuration)}
        </span>
      </div>
      {/* O alvo tem 44px no toque; a pílula visível continua pequena, por dentro. */}
      <button
        type="button"
        aria-label={`${t("Velocidade de reprodução")}: ${RATES[rateIdx]}x`}
        onClick={cycleRate}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center lg:min-h-0 lg:min-w-0"
      >
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums transition-colors",
            isOutbound
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          {RATES[rateIdx]}x
        </span>
      </button>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, FileText, Sparkle, Copy, Check } from "@phosphor-icons/react";
import { useT } from "@/lib/i18n/useT";
import { cn } from "@/lib/utils";
import { mediaSrc } from "./media-utils";
import { MediaUnavailable } from "./MediaUnavailable";

const RATES = [1, 1.5, 2] as const;

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

interface Props {
  messageId: string;
  isOutbound: boolean;
  transcription?: string | null;
  summary?: string | null;
  intent?: string | null;
}

/** Player de voz WhatsApp com Transcrição e Resumo de IA nativos */
export function AudioPlayer({ messageId, isOutbound, transcription, summary, intent }: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    const onError = () => setFailed(true);
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
  }, []);

  if (failed) return <MediaUnavailable kind="Áudio" className="h-12 w-60" />;

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      void el.play();
      setPlaying(true);
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

  const handleCopy = () => {
    if (transcription) {
      navigator.clipboard.writeText(transcription);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex flex-col gap-2 py-1 max-w-sm">
      <div className="flex w-64 items-center gap-2">
        <audio ref={audioRef} src={mediaSrc(messageId)} preload="metadata" />
        <button
          type="button"
          aria-label={playing ? t("Pausar áudio") : t("Reproduzir áudio")}
          onClick={toggle}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors",
            isOutbound
              ? "bg-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/30"
              : "bg-primary/10 text-primary hover:bg-primary/20",
          )}
        >
          {playing ? (
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
        <button
          type="button"
          aria-label={`${t("Velocidade de reprodução")}: ${RATES[rateIdx]}x`}
          onClick={cycleRate}
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums transition-colors",
            isOutbound
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          {RATES[rateIdx]}x
        </button>
      </div>

      {/* Botão e Painel de Transcrição e Resumo */}
      <div className="border-t border-border/40 pt-1.5 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowTranscript(!showTranscript)}
            className="flex items-center gap-1 text-[11px] font-medium opacity-80 hover:opacity-100 transition"
          >
            <FileText size={13} weight="bold" />
            <span>{showTranscript ? "Ocultar transcrição" : "Ver transcrição"}</span>
          </button>
          
          {intent && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-primary/10 text-primary font-medium flex items-center gap-1">
              <Sparkle size={11} weight="fill" />
              {intent}
            </span>
          )}
        </div>

        {showTranscript && (
          <div className="mt-1 p-2 rounded-lg bg-background/80 text-foreground text-xs space-y-1.5 border shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="italic text-[11px] leading-relaxed">
                "{transcription || "Transcrição do áudio processada automaticamente via IA nativa."}"
              </p>
              <button
                type="button"
                onClick={handleCopy}
                className="shrink-0 p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                title="Copiar transcrição"
              >
                {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              </button>
            </div>
            {summary && (
              <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/50">
                <strong>Resumo:</strong> {summary}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { copyToClipboard } from "@/lib/clipboard";
import { Check, Copy, FileText, Pause, Play, Sparkle } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { MediaUnavailable } from "./MediaUnavailable";
import { mediaSrc } from "./media-utils";

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
  transcriptionStatus?: string | null;
  summary?: string | null;
  intent?: string | null;
}

/** Player de voz com controles, transcrição e resumo derivados no CRM. */
export function AudioPlayer({
  messageId,
  isOutbound,
  transcription,
  transcriptionStatus,
  summary,
  intent,
}: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const [showTranscription, setShowTranscription] = useState(false);
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

  const copyText = async (text: string) => {
    if (!(await copyToClipboard(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const isProcessing = transcriptionStatus === "processing" || transcriptionStatus === "pending";
  const transcriptionFailed = transcriptionStatus === "failed";

  return (
    <div className="flex w-full max-w-[320px] flex-col gap-2">
      <div className="flex w-60 items-center gap-2 py-1">
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
            onChange={(event) => seek(Number(event.target.value))}
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

      <div
        className="flex flex-col gap-1 rounded-lg border border-purple-500/20 bg-purple-500/5 p-2 text-xs"
        aria-label={t("Inteligência do áudio")}
      >
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/20 bg-purple-500/10 px-2 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
            <Sparkle className="h-3 w-3" />
            {intent || t("Áudio analisado por IA")}
          </span>
          {transcription && (
            <button
              type="button"
              onClick={() => setShowTranscription((visible) => !visible)}
              className="text-brand-600 dark:text-brand-400 ml-auto inline-flex items-center gap-1 text-[11px] hover:underline"
            >
              <FileText className="h-3.5 w-3.5" />
              {showTranscription ? t("Ocultar texto") : t("Ver transcrição")}
            </button>
          )}
        </div>

        {!transcription && (
          <p className="px-1 text-[11px] text-muted-foreground">
            {isProcessing
              ? t("Preparando transcrição…")
              : transcriptionFailed
                ? t("Não foi possível transcrever este áudio.")
                : t("Transcrição ainda não disponível.")}
          </p>
        )}

        {showTranscription && transcription && (
          <div className="mt-1 space-y-2 rounded-lg border border-border bg-surface-elevated p-2.5 text-foreground/90">
            <div className="flex items-center justify-between border-b border-border pb-1">
              <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                {t("Transcrição (IA)")}
              </span>
              <button
                type="button"
                onClick={() => void copyText(transcription)}
                className="rounded-md p-1 text-muted-foreground transition hover:bg-surface hover:text-foreground"
                title={t("Copiar transcrição")}
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </button>
            </div>
            <p className="text-xs leading-relaxed whitespace-pre-wrap">{transcription}</p>
            {summary && (
              <div className="border-t border-border pt-1.5">
                <span className="mb-0.5 block text-[10px] font-semibold text-muted-foreground">
                  {t("Resumo:")}
                </span>
                <p className="text-[11px] leading-snug text-muted-foreground">{summary}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

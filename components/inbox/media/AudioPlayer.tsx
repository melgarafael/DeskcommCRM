"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, FileText, Sparkle, Copy, Check } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
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
  transcriptionStatus?: string | null;
  summary?: string | null;
  intent?: string | null;
}

export function AudioPlayer({
  messageId,
  isOutbound,
  transcription,
  transcriptionStatus,
  summary,
  intent,
}: Props) {
  const t = useT();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);
  const [showTranscription, setShowTranscription] = useState(false);
  const [copied, setCopied] = useState(false);

  const src = mediaSrc(messageId);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration || 0);
    const onError = () => setFailed(true);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("error", onError);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("error", onError);
    };
  }, []);

  if (failed) {
    return <MediaUnavailable kind="audio" />;
  }

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => setFailed(true));
    }
  };

  const changeRate = () => {
    if (!audioRef.current) return;
    const nextIdx = (rateIdx + 1) % RATES.length;
    const nextRate = RATES[nextIdx] ?? 1;
    audioRef.current.playbackRate = nextRate;
    setRateIdx(nextIdx);
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isProcessing = transcriptionStatus === "processing" || transcriptionStatus === "pending";
  const transcriptionFailed = transcriptionStatus === "failed";

  return (
    <div className="flex flex-col gap-2 w-full max-w-[320px]">
      <audio ref={audioRef} src={src} preload="metadata" />

      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 rounded-xl border transition-colors",
          isOutbound
            ? "bg-brand-600/10 border-brand-500/20 text-brand-900 dark:text-brand-100"
            : "bg-surface-elevated border-border text-foreground"
        )}
      >
        <button
          onClick={togglePlay}
          className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 transition"
          aria-label={isPlaying ? "Pausar áudio" : "Tocar áudio"}
        >
          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>

        <div className="flex-1 flex flex-col gap-1">
          <div className="h-1.5 bg-border rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 rounded-full transition-all"
              style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
            <span>{fmt(currentTime)}</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        <button
          onClick={changeRate}
          className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-border hover:bg-surface transition"
        >
          {RATES[rateIdx]}x
        </button>
      </div>

      <div
        className="flex flex-col gap-1 rounded-lg border border-purple-500/20 bg-purple-500/5 p-2 text-xs"
        aria-label={t("Inteligência do áudio")}
      >
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
              <Sparkle className="w-3 h-3" />
              {intent || t("Áudio analisado por IA")}
            </span>
            {transcription && (
              <button
                type="button"
                onClick={() => setShowTranscription(!showTranscription)}
                className="inline-flex items-center gap-1 text-[11px] text-brand-600 dark:text-brand-400 hover:underline ml-auto"
              >
                <FileText className="w-3.5 h-3.5" />
                {showTranscription ? "Ocultar texto" : "Ver transcrição"}
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
            <div className="p-2.5 rounded-lg bg-surface-elevated border border-border text-foreground/90 space-y-2 mt-1">
              <div className="flex items-center justify-between border-b border-border pb-1">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Transcrição (IA)
                </span>
                <button
                  type="button"
                  onClick={() => copyText(transcription)}
                  className="p-1 hover:bg-surface rounded text-muted-foreground hover:text-foreground transition"
                  title="Copiar transcrição"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
              <p className="text-xs leading-relaxed whitespace-pre-wrap">{transcription}</p>
              {summary && (
                <div className="pt-1.5 border-t border-border">
                  <span className="text-[10px] font-semibold text-muted-foreground block mb-0.5">Resumo:</span>
                  <p className="text-[11px] text-muted-foreground leading-snug">{summary}</p>
                </div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

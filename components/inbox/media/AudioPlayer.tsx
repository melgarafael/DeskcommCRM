"use client";
import { useEffect, useRef, useState } from "react";

import { Pause, Play } from "@/lib/ui/icons";
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
}

/** Player de voz estilo WhatsApp: play/pause, progresso seekável, tempo, 1x/1.5x/2x. */
export function AudioPlayer({ messageId, isOutbound }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setCurrent(el.currentTime);
    const onMeta = () => setDuration(el.duration);
    const onEnded = () => setPlaying(false);
    const onError = () => setFailed(true);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
    };
  }, []);

  if (failed) return <MediaUnavailable kind="Áudio" />;

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

  return (
    <div className="flex w-60 items-center gap-2 py-1">
      <audio ref={audioRef} src={mediaSrc(messageId)} preload="metadata" />
      <button
        type="button"
        aria-label={playing ? "Pausar áudio" : "Reproduzir áudio"}
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
          aria-label="Progresso do áudio"
          min="0"
          max={String(duration || 1)}
          step="0.1"
          value={current}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1 w-full cursor-pointer accent-current"
        />
        <span className="text-[10px] tabular-nums opacity-70">
          {fmt(current)} / {fmt(duration)}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Velocidade de reprodução: ${RATES[rateIdx]}x`}
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
  );
}

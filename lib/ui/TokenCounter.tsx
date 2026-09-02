"use client";
import * as React from "react";
import { encode } from "gpt-tokenizer";

interface Props {
  text: string;
  contextWindow?: number | null;
  className?: string;
}

export function TokenCounter({ text, contextWindow, className }: Props) {
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    const t = setTimeout(() => {
      try {
        setCount(encode(text ?? "").length);
      } catch {
        setCount(null);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [text]);

  if (count === null) {
    return (
      <span className={className} aria-live="polite">
        — tokens
      </span>
    );
  }

  const ratio = contextWindow && contextWindow > 0 ? count / contextWindow : null;
  const warn = ratio !== null && ratio > 0.8;
  const danger = ratio !== null && ratio > 1;

  const tone = danger
    ? "text-destructive"
    : warn
      ? "text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";

  return (
    <span className={`${tone} ${className ?? ""}`} aria-live="polite">
      ~{count.toLocaleString("pt-PT")} tokens
      {contextWindow ? ` / ${contextWindow.toLocaleString("pt-PT")}` : ""}
      {warn && !danger ? " · próximo do limite" : ""}
      {danger ? " · acima do limite" : ""}
    </span>
  );
}

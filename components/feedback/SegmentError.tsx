"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export interface SegmentErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  segment?: string;
}

export function SegmentError({ error, reset, segment }: SegmentErrorProps) {
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = Sentry.captureException(error, {
      tags: segment ? { segment } : undefined,
    });
    setEventId(id);
  }, [error, segment]);

  const displayId = eventId ?? error.digest ?? "—";

  function copyId() {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(displayId).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">Algo deu errado</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo.
        </p>
        <div className="mt-4 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          ID: {displayId}
        </div>
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" variant="outline" onClick={copyId}>
            {copied ? "Copiado!" : "Copiar ID"}
          </Button>
          <Button type="button" onClick={() => reset()}>
            Tentar de novo
          </Button>
        </div>
      </Card>
    </main>
  );
}

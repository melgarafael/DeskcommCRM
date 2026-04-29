"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = Sentry.captureException(error);
    setEventId(id);
  }, [error]);

  const displayId = eventId ?? error.digest ?? "—";

  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          background: "#fafaf9",
          color: "#1c1917",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            background: "white",
            border: "1px solid #e7e5e4",
            borderRadius: 12,
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem", fontWeight: 600 }}>
            Algo deu errado
          </h1>
          <p style={{ color: "#57534e", margin: "0 0 1.5rem" }}>
            Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo.
          </p>
          <div
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.75rem",
              background: "#f5f5f4",
              padding: "0.5rem",
              borderRadius: 6,
              marginBottom: "1rem",
              wordBreak: "break-all",
            }}
          >
            ID: {displayId}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
            <button
              type="button"
              onClick={() => {
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  void navigator.clipboard.writeText(displayId).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }
              }}
              style={{
                padding: "0.5rem 1rem",
                border: "1px solid #d6d3d1",
                background: "white",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {copied ? "Copiado!" : "Copiar ID"}
            </button>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                padding: "0.5rem 1rem",
                border: "1px solid #1c1917",
                background: "#1c1917",
                color: "white",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Tentar de novo
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}

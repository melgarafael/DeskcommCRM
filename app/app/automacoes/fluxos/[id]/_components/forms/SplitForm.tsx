"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { splitConfigSchema } from "@/lib/followup/graph-schema";

import type { ConfigOf } from "./shared";

type Config = ConfigOf<"split">;

/** Id opaco e estável da saída: a seta referencia o id, nunca o rótulo. */
function novoId(): string {
  return `sp_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * O bloco "Dividir em %" (Automações, out/2026) — o Randomizador do ManyChat.
 * Cada contato sai por uma fatia, na proporção dos pesos; o mesmo contato
 * sempre pela mesma fatia.
 */
export function SplitForm({ config, onChange }: { config: Config; onChange: (c: Config) => void }) {
  const t = useT();
  const [erro, setErro] = useState<string | null>(null);
  const total = config.saidas.reduce((soma, s) => soma + s.peso, 0) || 1;

  const gravar = (candidato: Config) => {
    const parsed = splitConfigSchema.safeParse(candidato);
    if (!parsed.success) {
      setErro(parsed.error.issues[0]?.message ?? t("Configuração inválida."));
      return;
    }
    setErro(null);
    onChange(parsed.data);
  };

  return (
    <div className="grid gap-3" data-testid="split-form">
      <p className="text-xs text-text-muted">
        {t("Divide os contatos entre as saídas, na proporção de cada uma. Serve para testar equipes, mensagens ou funis diferentes.")}
      </p>
      <ul className="space-y-2">
        {config.saidas.map((s, i) => (
          <li key={s.id} className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`split-label-${s.id}`}>{t("Nome da saída")}</Label>
              <Input
                id={`split-label-${s.id}`}
                value={s.label}
                maxLength={40}
                onChange={(e) =>
                  gravar({
                    saidas: config.saidas.map((x, j) => (j === i ? { ...x, label: e.target.value || x.label } : x)),
                  })
                }
              />
            </div>
            <div className="w-24 space-y-1">
              <Label htmlFor={`split-peso-${s.id}`}>{t("Peso")}</Label>
              <Input
                id={`split-peso-${s.id}`}
                type="number"
                min={1}
                max={100}
                value={s.peso}
                onChange={(e) =>
                  gravar({
                    saidas: config.saidas.map((x, j) =>
                      j === i ? { ...x, peso: Math.min(100, Math.max(1, Number(e.target.value) || 1)) } : x,
                    ),
                  })
                }
              />
            </div>
            <span className="w-12 pb-2 text-right text-xs text-text-muted">{Math.round((s.peso / total) * 100)}%</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={config.saidas.length <= 2}
              onClick={() => gravar({ saidas: config.saidas.filter((_, j) => j !== i) })}
            >
              {t("Remover")}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={config.saidas.length >= 10}
        onClick={() =>
          gravar({
            saidas: [
              ...config.saidas,
              { id: novoId(), label: `${t("Caminho")} ${String.fromCharCode(65 + config.saidas.length)}`, peso: 1 },
            ],
          })
        }
      >
        {t("+ Saída")}
      </Button>
      {erro && (
        <p className="text-xs text-error-fg" role="alert">
          {erro}
        </p>
      )}
    </div>
  );
}

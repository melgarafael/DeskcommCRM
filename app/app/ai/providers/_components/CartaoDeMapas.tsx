"use client";

/**
 * O cartão "Mapas" em Provedores: a chave do Google que transforma o pino de
 * localização do WhatsApp em rua e cidade aproximadas.
 *
 * Mora aqui, e não em Credenciais, porque Credenciais é a chave da IA que
 * conversa; esta é outro provedor que o atendimento usa — e quem procura "de
 * onde o agente tira a cidade do pino" procura em Provedores (pedido de uma loja,
 * 28/09/2026).
 *
 * A chave nunca volta ao browser: a tela vê os 4 últimos caracteres. "Testar"
 * existe porque os erros comuns (API não habilitada no projeto, restrição de IP
 * sem o servidor) só aparecem numa chamada de verdade.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { MotivoDaFalha } from "@/lib/mapas/geocodificacao";

interface Estado {
  configurada: boolean;
  ultimos4: string | null;
}

type Teste = { ok: true; endereco: string } | { ok: false; motivo: MotivoDaFalha | "erro"; detalhe: string | null };

async function lerCorpo(res: Response): Promise<{ data?: unknown; error?: { message?: string } }> {
  try {
    return (await res.json()) as { data?: unknown; error?: { message?: string } };
  } catch {
    return {};
  }
}

export function CartaoDeMapas() {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [erroDeCarga, setErroDeCarga] = useState(false);
  const [chave, setChave] = useState("");
  const [ocupado, setOcupado] = useState<null | "salvar" | "testar" | "remover">(null);
  const [teste, setTeste] = useState<Teste | null>(null);

  const carregar = useCallback(async () => {
    const res = await fetch("/api/v1/ai/mapas").catch(() => null);
    if (!res || !res.ok) {
      setErroDeCarga(true);
      return;
    }
    const corpo = await lerCorpo(res);
    setEstado(corpo.data as Estado);
    setErroDeCarga(false);
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    setOcupado("salvar");
    setTeste(null);
    try {
      const res = await fetch("/api/v1/ai/mapas", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: chave.trim() }),
      });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui gravar a chave."));
        return;
      }
      setEstado(corpo.data as Estado);
      setChave("");
      toast.success(t("Chave de mapas gravada."));
    } finally {
      setOcupado(null);
    }
  }

  async function testar() {
    setOcupado("testar");
    setTeste(null);
    try {
      const res = await fetch("/api/v1/ai/mapas/testar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chave.trim() ? { api_key: chave.trim() } : {}),
      });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui testar agora."));
        return;
      }
      setTeste(corpo.data as Teste);
    } catch {
      setTeste({ ok: false, motivo: "erro", detalhe: null });
    } finally {
      setOcupado(null);
    }
  }

  async function remover() {
    setOcupado("remover");
    setTeste(null);
    try {
      const res = await fetch("/api/v1/ai/mapas", { method: "DELETE" });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui remover a chave."));
        return;
      }
      setEstado({ configurada: false, ultimos4: null });
      toast.success(t("Chave de mapas removida."));
    } finally {
      setOcupado(null);
    }
  }

  const podeTestar = Boolean(chave.trim()) || Boolean(estado?.configurada);

  // O que cada falha pede de quem configura — em frase de gente, não o status do Google.
  const explicacao: Record<MotivoDaFalha | "erro", string> = {
    api_desativada: t(
      "A Geocoding API não está habilitada no projeto desta chave. No Google Cloud: APIs e serviços › Biblioteca › Geocoding API › Ativar.",
    ),
    chave_recusada: t(
      "O Google recusou a chave. Confira se ela está inteira e se as restrições permitem a Geocoding API e o endereço IP deste servidor.",
    ),
    cota: t("O projeto do Google atingiu a cota ou está sem faturamento ativo."),
    sem_resultado: t("O Google não encontrou endereço para o ponto de teste."),
    rede: t("Não consegui falar com o Google agora. Tente de novo em instantes."),
    desconhecido: t("O Google respondeu algo inesperado."),
    erro: t("Não consegui testar agora."),
  };

  return (
    <Card className="mt-8 p-4" data-testid="cartao-de-mapas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Mapas (Google)")}</h2>
        {estado &&
          (estado.configurada ? (
            <Badge variant="secondary" data-testid="mapas-estado">
              {t("Chave gravada")} ···{estado.ultimos4}
            </Badge>
          ) : (
            <Badge variant="outline" data-testid="mapas-estado">
              {t("Sem chave")}
            </Badge>
          ))}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {t(
          "Quando o cliente manda a localização pelo WhatsApp, o sistema consulta o Google e o agente lê a rua e a cidade aproximadas — em vez de só as coordenadas. Sem chave, nada muda.",
        )}
      </p>

      {erroDeCarga && (
        <p className="mt-3 text-sm text-destructive">{t("Não consegui ler a configuração de mapas.")}</p>
      )}

      <div className="mt-4 space-y-2">
        <Label htmlFor="chave-de-mapas">
          {estado?.configurada ? t("Trocar a chave da Geocoding API") : t("Chave da Geocoding API")}
        </Label>
        <Input
          id="chave-de-mapas"
          type="password"
          autoComplete="off"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          placeholder="AIza…"
          data-testid="mapas-chave"
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "Crie a chave no Google Cloud com a Geocoding API habilitada e restrinja-a a essa API e ao endereço IP deste servidor.",
          )}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={salvar} disabled={!chave.trim() || ocupado !== null} data-testid="mapas-salvar">
          {t("Salvar chave")}
        </Button>
        <Button variant="outline" onClick={testar} disabled={!podeTestar || ocupado !== null} data-testid="mapas-testar">
          {ocupado === "testar" ? t("Testando…") : t("Testar")}
        </Button>
        {estado?.configurada && (
          <Button variant="ghost" onClick={remover} disabled={ocupado !== null} data-testid="mapas-remover">
            {t("Remover chave")}
          </Button>
        )}
      </div>

      {teste && (
        <div
          className={`mt-3 rounded-md border p-3 text-sm ${teste.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/40 bg-destructive/5"}`}
          data-testid="mapas-resultado"
        >
          {teste.ok ? (
            <p>
              {t("Funcionou. No ponto de teste, o Google respondeu:")} <strong>{teste.endereco}</strong>
            </p>
          ) : (
            <>
              <p>{explicacao[teste.motivo]}</p>
              {teste.detalhe && <p className="mt-1 text-xs text-muted-foreground">{teste.detalhe}</p>}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

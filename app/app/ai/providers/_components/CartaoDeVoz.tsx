"use client";

/**
 * O cartão "Voz e áudio" em Provedores: a chave do Google Cloud Text-to-Speech
 * que dá voz à resposta em áudio da IA.
 *
 * Mora aqui pelo mesmo motivo do cartão Mapas: não é a chave da IA que
 * conversa, é outro provedor que o atendimento usa. A chave nunca volta ao
 * browser — a tela vê `••••` e os 4 últimos caracteres — e substituir exige
 * colar a chave INTEIRA de novo. A voz de cada agente se escolhe no cartão
 * "Responder em áudio quando o cliente pedir", na tela do agente; aqui se
 * conferem as vozes disponíveis e se ouve uma amostra.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import type { VozDisponivel } from "@/lib/agent-engine/edge/voz/vozes";
import type { EstadoDaVoz } from "@/lib/ai/voz/credencial";

type Teste = { ok: true; vozes: number } | { ok: false; erro: string };

async function lerCorpo(res: Response): Promise<{ data?: unknown; error?: { message?: string } }> {
  try {
    return (await res.json()) as { data?: unknown; error?: { message?: string } };
  } catch {
    return {};
  }
}

/** O rótulo de uma voz na lista: nome e gênero (todas são Standard pt-BR). */
export function rotuloDaVoz(v: VozDisponivel, t: (s: string) => string): string {
  const genero = v.genero === "feminina" ? t("feminina") : v.genero === "masculina" ? t("masculina") : t("neutra");
  return `${v.nome} · ${genero}`;
}

/** O que cada código de erro pede de quem configura — em frase de gente. */
export function explicacaoDoErroDaVoz(codigo: string, t: (s: string) => string): string {
  if (codigo === "auth_failed_401" || codigo === "auth_failed_403") {
    return t(
      "O Google recusou a chave. Confira se ela está inteira, se a Cloud Text-to-Speech API está habilitada no projeto e se as restrições da chave permitem essa API.",
    );
  }
  if (codigo === "provider_status_429") return t("O projeto do Google atingiu a cota. Tente de novo mais tarde.");
  if (codigo === "network_error") return t("Não consegui falar com o Google agora. Tente de novo em instantes.");
  if (codigo === "sem_vozes_pt_br") return t("A chave funciona, mas o Google não devolveu vozes em português do Brasil.");
  if (codigo === "credencial_ilegivel") {
    return t("A chave gravada não pôde ser lida pelo servidor. Cole a chave de novo para substituí-la.");
  }
  return t("O Google respondeu algo inesperado. Tente de novo ou substitua a chave.");
}

export function CartaoDeVoz() {
  const t = useT();
  const [estado, setEstado] = useState<EstadoDaVoz | null>(null);
  const [erroDeCarga, setErroDeCarga] = useState(false);
  const [chave, setChave] = useState("");
  const [ocupado, setOcupado] = useState<null | "salvar" | "testar" | "remover" | "vozes" | "amostra">(null);
  const [teste, setTeste] = useState<Teste | null>(null);
  const [vozes, setVozes] = useState<VozDisponivel[] | null>(null);
  const [vozDaAmostra, setVozDaAmostra] = useState("");
  const [urlDaAmostra, setUrlDaAmostra] = useState<string | null>(null);
  const urlAnterior = useRef<string | null>(null);

  const carregar = useCallback(async () => {
    const res = await fetch("/api/v1/ai/voz").catch(() => null);
    if (!res || !res.ok) {
      setErroDeCarga(true);
      return;
    }
    const corpo = await lerCorpo(res);
    setEstado(corpo.data as EstadoDaVoz);
    setErroDeCarga(false);
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // O áudio da amostra é um blob local; solta o anterior ao trocar e ao sair.
  useEffect(() => {
    if (urlAnterior.current && urlAnterior.current !== urlDaAmostra) URL.revokeObjectURL(urlAnterior.current);
    urlAnterior.current = urlDaAmostra;
  }, [urlDaAmostra]);
  useEffect(
    () => () => {
      if (urlAnterior.current) URL.revokeObjectURL(urlAnterior.current);
    },
    [],
  );

  async function salvar() {
    setOcupado("salvar");
    setTeste(null);
    try {
      const res = await fetch("/api/v1/ai/voz", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: chave.trim() }),
      });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui gravar a chave."));
        return;
      }
      setEstado(corpo.data as EstadoDaVoz);
      setChave("");
      setVozes(null);
      toast.success(t("Chave de voz gravada. Clique em Testar para conferir."));
    } finally {
      setOcupado(null);
    }
  }

  async function testar() {
    setOcupado("testar");
    setTeste(null);
    try {
      const res = await fetch("/api/v1/ai/voz/testar", { method: "POST" });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui testar agora."));
        return;
      }
      setTeste(corpo.data as Teste);
      await carregar();
    } catch {
      setTeste({ ok: false, erro: "network_error" });
    } finally {
      setOcupado(null);
    }
  }

  async function remover() {
    setOcupado("remover");
    setTeste(null);
    try {
      const res = await fetch("/api/v1/ai/voz", { method: "DELETE" });
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui remover a chave."));
        return;
      }
      setEstado(corpo.data as EstadoDaVoz);
      setVozes(null);
      setUrlDaAmostra(null);
      toast.success(t("Chave de voz removida."));
    } finally {
      setOcupado(null);
    }
  }

  async function carregarVozes() {
    setOcupado("vozes");
    try {
      const res = await fetch("/api/v1/ai/voz/vozes");
      const corpo = await lerCorpo(res);
      if (!res.ok) {
        toast.error(corpo.error?.message ?? t("Não consegui carregar as vozes."));
        return;
      }
      const dados = corpo.data as { vozes: VozDisponivel[]; padrao: string };
      setVozes(dados.vozes);
      setVozDaAmostra((atual) => atual || dados.padrao);
    } finally {
      setOcupado(null);
    }
  }

  async function ouvirAmostra() {
    setOcupado("amostra");
    try {
      const res = await fetch("/api/v1/ai/voz/amostra", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voz: vozDaAmostra }),
      });
      if (!res.ok) {
        const corpo = await lerCorpo(res);
        toast.error(corpo.error?.message ?? t("Não consegui gerar a amostra."));
        return;
      }
      setUrlDaAmostra(URL.createObjectURL(await res.blob()));
    } finally {
      setOcupado(null);
    }
  }

  const temChave = estado?.em_uso !== null && estado?.em_uso !== undefined;

  return (
    <Card className="mt-8 p-4" data-testid="cartao-de-voz">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t("Voz e áudio (Google Cloud Text-to-Speech)")}</h2>
        {estado &&
          (estado.configurada ? (
            <Badge variant={estado.validada ? "secondary" : "outline"} data-testid="voz-estado">
              {estado.validada ? t("Chave testada") : t("Chave gravada, não testada")} {estado.mascara}
            </Badge>
          ) : (
            <Badge variant="outline" data-testid="voz-estado">
              {estado.em_uso === "instalacao" ? t("Usando a chave da instalação") : t("Não configurada")}
            </Badge>
          ))}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        {t(
          "Quando o cliente pede áudio ou diz que não consegue ler, o agente com a resposta em áudio ligada responde com nota de voz. A voz de cada agente é escolhida na tela do agente.",
        )}
      </p>

      {erroDeCarga && (
        <p className="mt-3 text-sm text-destructive">{t("Não consegui ler a configuração de voz.")}</p>
      )}

      {estado?.erro && !teste && (
        <p className="mt-3 text-sm text-destructive" data-testid="voz-erro">
          {explicacaoDoErroDaVoz(estado.erro, t)}
        </p>
      )}

      <div className="mt-4 space-y-2">
        <Label htmlFor="chave-de-voz">
          {estado?.configurada ? t("Substituir a chave (cole a chave inteira)") : t("Chave da API")}
        </Label>
        <Input
          id="chave-de-voz"
          type="password"
          autoComplete="off"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          placeholder="AIza…"
          data-testid="voz-chave"
        />
        <p className="text-xs text-muted-foreground">
          {t(
            "No Google Cloud, habilite a Cloud Text-to-Speech API, crie uma chave de API e restrinja-a a essa API. A chave fica cifrada no servidor e não é mostrada de novo.",
          )}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={salvar} disabled={!chave.trim() || ocupado !== null} data-testid="voz-salvar">
          {estado?.configurada ? t("Substituir chave") : t("Salvar chave")}
        </Button>
        <Button
          variant="outline"
          onClick={testar}
          disabled={!estado?.configurada || ocupado !== null}
          data-testid="voz-testar"
        >
          {ocupado === "testar" ? t("Testando…") : t("Testar")}
        </Button>
        {estado?.configurada && (
          <Button variant="ghost" onClick={remover} disabled={ocupado !== null} data-testid="voz-remover">
            {t("Remover chave")}
          </Button>
        )}
      </div>

      {teste && (
        <div
          className={`mt-3 rounded-md border p-3 text-sm ${teste.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/40 bg-destructive/5"}`}
          data-testid="voz-resultado"
        >
          {teste.ok ? (
            <p>
              {t("Funcionou. Vozes em português do Brasil disponíveis:")} <strong>{teste.vozes}</strong>
            </p>
          ) : (
            <p>{explicacaoDoErroDaVoz(teste.erro, t)}</p>
          )}
        </div>
      )}

      {temChave && (
        <div className="mt-5 space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={carregarVozes} disabled={ocupado !== null} data-testid="voz-carregar-vozes">
              {ocupado === "vozes" ? t("Carregando…") : t("Ver vozes disponíveis")}
            </Button>
          </div>
          {vozes && vozes.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("Nenhuma voz em português do Brasil disponível para esta chave.")}</p>
          )}
          {vozes && vozes.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="voz-da-amostra">{t("Ouvir uma voz")}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  id="voz-da-amostra"
                  className="h-9 max-w-full rounded-md border bg-background px-2 text-sm"
                  value={vozDaAmostra}
                  onChange={(e) => setVozDaAmostra(e.target.value)}
                  data-testid="voz-lista"
                >
                  {vozes.map((v) => (
                    <option key={v.nome} value={v.nome}>
                      {rotuloDaVoz(v, t)}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={ouvirAmostra} disabled={!vozDaAmostra || ocupado !== null} data-testid="voz-ouvir">
                  {ocupado === "amostra" ? t("Gerando…") : t("Ouvir amostra")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "Só vozes Standard em português do Brasil, as de menor custo. Cada amostra gera uma frase curta e consome uma pequena parcela da franquia da sua chave no Google.",
                )}
              </p>
              {urlDaAmostra && (
                <audio controls autoPlay src={urlDaAmostra} className="mt-1 w-full max-w-md" data-testid="voz-player" />
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

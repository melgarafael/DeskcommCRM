"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";

type StatusVinculo =
  | { estado: "carregando" }
  | { estado: "ausente" }
  | { estado: "ativo"; rotulo: string }
  | { estado: "quarentena"; motivo: string | null }
  | { estado: "desligado" }
  | { estado: "erro" };

interface SessaoDevice {
  user_code: string;
  verification_uri: string;
  device_auth_id: string;
  expires_in: number;
}

interface Props {
  canWrite: boolean;
  /** Seam de teste: intervalo do poll (produção: 8s). */
  intervaloPollMs?: number;
}

const TETO_POLL_MS = 270_000;

async function lerJson(res: Response): Promise<{ data?: Record<string, unknown>; error?: { code?: string } }> {
  try {
    return (await res.json()) as { data?: Record<string, unknown>; error?: { code?: string } };
  } catch {
    return {};
  }
}

function mensagemDeFalha(codigo: string | undefined, generica: string, t: (s: string) => string): string {
  if (codigo === "misconfigured") {
    return t("Assinatura ChatGPT não configurada nesta instalação. Defina o client OAuth e tente de novo.");
  }
  return t(generica);
}

/**
 * Cartão do vínculo ChatGPT (assinatura via OAuth) — o par OAuth do diálogo
 * de chave colada. A assinatura se CONECTA (device-code no browser), não se
 * cola: por isso mora num cartão próprio, lendo/escrevendo só as rotas
 * `/api/v1/ai/credentials/codex/*`, nunca `ai_provider_credentials`.
 */
export function CodexConnectCard({ canWrite, intervaloPollMs = 8_000 }: Props) {
  const t = useT();
  const [status, setStatus] = useState<StatusVinculo>({ estado: "carregando" });
  const [sessao, setSessao] = useState<SessaoDevice | null>(null);
  const [expirado, setExpirado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [falha, setFalha] = useState<string | null>(null);
  const tentativas = useRef(0);

  const carregar = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/ai/credentials/codex", { cache: "no-store" });
      const { data } = await lerJson(res);
      if (!res.ok || !data) {
        setStatus({ estado: "erro" });
        return;
      }
      const estado = data["status"];
      if (estado === "active") setStatus({ estado: "ativo", rotulo: String(data["label"] ?? "ChatGPT") });
      else if (estado === "quarantined")
        setStatus({ estado: "quarentena", motivo: (data["quarantined_reason"] as string) ?? null });
      else if (estado === "revoked") setStatus({ estado: "desligado" });
      else setStatus({ estado: "ausente" });
    } catch {
      setStatus({ estado: "erro" });
    }
  }, []);

  useEffect(() => {
    // Busca única de montagem (sem subscription): o padrão que o lint prefere
    // (sem setState em effect) exigiria react-query para um GET isolado.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar();
  }, [carregar]);

  const conectar = async () => {
    setOcupado(true);
    setFalha(null);
    setExpirado(false);
    try {
      const res = await fetch("/api/v1/ai/credentials/codex", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { data, error } = await lerJson(res);
      if (!res.ok || !data?.["user_code"]) {
        setFalha(mensagemDeFalha(error?.code, "Não consegui abrir a sessão de conexão. Tente de novo.", t));
        return;
      }
      tentativas.current = 0;
      setSessao({
        user_code: String(data["user_code"]),
        verification_uri: String(data["verification_uri"]),
        device_auth_id: String(data["device_auth_id"]),
        expires_in: Number(data["expires_in"] ?? 600),
      });
    } catch {
      setFalha(t("Não consegui abrir a sessão de conexão. Tente de novo."));
    } finally {
      setOcupado(false);
    }
  };

  const conferirAprovacao = async () => {
    if (!sessao) return;
    setOcupado(true);
    setFalha(null);
    try {
      const res = await fetch("/api/v1/ai/credentials/codex/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_auth_id: sessao.device_auth_id, user_code: sessao.user_code }),
      });
      const { data, error } = await lerJson(res);
      if (!res.ok) {
        setFalha(mensagemDeFalha(error?.code, "A verificação falhou. Tente de novo.", t));
        return;
      }
      if (data?.["conectado"]) {
        setSessao(null);
        await carregar();
        return;
      }
      tentativas.current += 1;
      if (tentativas.current * intervaloPollMs >= TETO_POLL_MS) {
        setExpirado(true);
        setSessao(null);
        return;
      }
      setFalha(t("Ainda não vi a aprovação — autorize no browser e toque de novo."));
    } catch {
      setFalha(t("A verificação falhou. Tente de novo."));
    } finally {
      setOcupado(false);
    }
  };

  const desconectar = async () => {
    setOcupado(true);
    try {
      await fetch("/api/v1/ai/credentials/codex/disconnect", { method: "POST" });
      setSessao(null);
      await carregar();
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-6" data-testid="codex-connect-card">
      <div>
        <h2 className="font-medium">{t("Assinatura ChatGPT")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Use a sua assinatura ChatGPT em vez de chave de API: você autoriza no browser e o refresh fica guardado criptografado. Áudio e base de conhecimento continuam na chave OpenAI.",
          )}
        </p>
      </div>

      {status.estado === "carregando" && <p className="text-sm text-muted-foreground">{t("Consultando vínculo…")}</p>}
      {status.estado === "erro" && (
        <p className="text-sm text-destructive">{t("Não consegui ler o vínculo. Recarregue a página.")}</p>
      )}
      {status.estado === "ativo" && (
        <p className="text-sm">
          {t("Conectado")} — {status.rotulo}
        </p>
      )}
      {status.estado === "quarentena" && (
        <p className="text-sm text-destructive">
          {t("Conexão interrompida pelo provedor. Reconecte para voltar a usar.")}
          {status.motivo ? ` (${status.motivo})` : ""}
        </p>
      )}
      {(status.estado === "ausente" || status.estado === "desligado") && (
        <p className="text-sm text-muted-foreground">{t("Nenhuma assinatura conectada.")}</p>
      )}

      {sessao && (
        <div className="flex flex-col gap-2 rounded-md border p-4">
          <p className="text-sm">{t("Digite este código na página de autorização:")}</p>
          <p className="text-2xl font-mono font-bold tracking-widest" data-testid="codex-user-code">
            {sessao.user_code}
          </p>
          <a
            className="text-sm underline"
            href={sessao.verification_uri}
            target="_blank"
            rel="noreferrer"
          >
            {t("Abrir página de autorização")}
          </a>
          {canWrite && (
            <Button onClick={() => void conferirAprovacao()} disabled={ocupado} className="w-full sm:w-auto">
              {t("Já autorizei")}
            </Button>
          )}
        </div>
      )}

      {expirado && <p className="text-sm text-destructive">{t("O código expirou. Gere outro.")}</p>}
      {falha && <p className="text-sm text-destructive">{falha}</p>}

      {canWrite && !sessao && status.estado !== "ativo" && (
        <Button onClick={() => void conectar()} disabled={ocupado} className="w-full sm:w-auto">
          {status.estado === "quarentena" ? t("Reconectar") : t("Conectar ChatGPT")}
        </Button>
      )}
      {canWrite && status.estado === "ativo" && (
        <Button onClick={() => void desconectar()} disabled={ocupado} variant="outline" className="w-full sm:w-auto">
          {t("Desconectar")}
        </Button>
      )}
    </Card>
  );
}

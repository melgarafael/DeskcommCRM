"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { VOZ_PADRAO, ehVozAceita, type VozDisponivel } from "@/lib/agent-engine/edge/voz/vozes";
import type { EstadoDaVoz } from "@/lib/ai/voz/credencial";
import { rotuloDaVoz } from "@/app/app/ai/providers/_components/CartaoDeVoz";

interface Props {
  agentId: string;
  /** `ai_agents.config.resposta_em_audio` como está no banco (pode ser undefined). */
  inicial: unknown;
  /** `ai_agents.config.voz_da_resposta_em_audio` como está no banco. */
  vozInicial?: unknown;
  disabled?: boolean;
}

async function lerDados<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return ((await res.json()) as { data: T }).data;
  } catch {
    return null;
  }
}

/**
 * Cartão "responder em áudio quando o cliente pedir" — e a voz DESTE agente.
 *
 * Ligado, o agente manda a resposta como nota de voz quando o cliente pede
 * áudio ou diz que não consegue ler (`lib/agent-engine/agent/resposta-em-audio.ts`).
 * O texto da resposta continua no CRM. A chave vem de IA › Provedores › Voz e
 * áudio (ou, de reserva, do ambiente da instalação); sem nenhuma, ligar é
 * recusado pelo servidor e a tela diz onde configurar. Desligar passa sempre.
 * Grava só `resposta_em_audio` e o NOME da voz em `ai_agents.config`. Só admin.
 */
export function RespostaEmAudio({ agentId, inicial, vozInicial, disabled }: Props) {
  const t = useT();
  const [ligado, setLigado] = useState<boolean>(inicial === true);
  const [voz, setVoz] = useState<string>(ehVozAceita(vozInicial) ? vozInicial : "");
  const [salvando, setSalvando] = useState(false);
  const [estado, setEstado] = useState<EstadoDaVoz | null>(null);
  const [vozes, setVozes] = useState<VozDisponivel[] | null>(null);

  const carregar = useCallback(async () => {
    const e = await lerDados<EstadoDaVoz>("/api/v1/ai/voz");
    setEstado(e);
    if (e?.em_uso) {
      const lista = await lerDados<{ vozes: VozDisponivel[] }>("/api/v1/ai/voz/vozes");
      setVozes(lista?.vozes ?? null);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const semChave = estado !== null && estado.em_uso === null;

  async function gravar(config: { resposta_em_audio?: boolean; voz_da_resposta_em_audio?: string | null }) {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, { config });
      return true;
    } catch (err) {
      showApiError(err);
      return false;
    } finally {
      setSalvando(false);
    }
  }

  async function alternar(valor: boolean) {
    const anterior = ligado;
    setLigado(valor);
    if (await gravar({ resposta_em_audio: valor })) {
      toast.success(valor ? t("Resposta em áudio ligada.") : t("Resposta em áudio desligada."));
    } else {
      setLigado(anterior);
    }
  }

  async function escolherVoz(nova: string) {
    const anterior = voz;
    setVoz(nova);
    if (await gravar({ voz_da_resposta_em_audio: nova === "" ? null : nova })) {
      toast.success(t("Voz do agente salva."));
    } else {
      setVoz(anterior);
    }
  }

  // A voz gravada que a lista atual não traz continua visível (não some da tela).
  const opcoes = vozes ?? [];
  const vozForaDaLista = voz !== "" && !opcoes.some((v) => v.nome === voz);

  return (
    <Card className="space-y-3 p-4" data-testid="resposta-em-audio">
      <div className="flex items-center gap-2">
        <Switch
          id="resposta_em_audio"
          checked={ligado}
          onCheckedChange={alternar}
          // Sem chave, só DESLIGAR fica disponível.
          disabled={disabled || salvando || (semChave && !ligado)}
        />
        <Label htmlFor="resposta_em_audio">{t("Responder em áudio quando o cliente pedir")}</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Quando o cliente pede áudio ou diz que não consegue ler, a resposta vai como nota de voz e o texto fica guardado na conversa. Se a voz falhar, a resposta segue em texto.",
        )}
      </p>

      {semChave && (
        <p className="text-sm text-destructive" data-testid="resposta-em-audio-sem-chave">
          {t("A voz ainda não está configurada. Cadastre e teste a chave em")}{" "}
          <Link href="/app/ai/providers" className="underline">
            {t("IA › Provedores › Voz e áudio")}
          </Link>
          .
        </p>
      )}

      {!semChave && estado !== null && (
        <div className="space-y-1">
          <Label htmlFor="voz_da_resposta_em_audio">{t("Voz deste agente")}</Label>
          <select
            id="voz_da_resposta_em_audio"
            className="h-9 w-full max-w-md rounded-md border bg-background px-2 text-sm"
            value={voz}
            onChange={(e) => void escolherVoz(e.target.value)}
            disabled={disabled || salvando}
            data-testid="resposta-em-audio-voz"
          >
            <option value="">
              {t("Padrão")} ({VOZ_PADRAO})
            </option>
            {vozForaDaLista && <option value={voz}>{voz}</option>}
            {opcoes.map((v) => (
              <option key={v.nome} value={v.nome}>
                {rotuloDaVoz(v, t)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            {t("Só vozes Standard em português do Brasil, as de menor custo. Para ouvir uma amostra, use IA › Provedores › Voz e áudio.")}
          </p>
        </div>
      )}
    </Card>
  );
}

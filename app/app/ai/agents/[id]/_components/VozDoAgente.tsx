"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface Props {
  agentId: string;
  /** `ai_agents.config.voz_voice_id` como está no banco (pode ser undefined). */
  inicial?: unknown;
  disabled?: boolean;
}

/**
 * O Radix não aceita `value=""` num `SelectItem`, e "" é justamente o estado
 * "sem voz própria". O sentinela é só da TELA: o que vai ao banco continua
 * sendo `null` (ver `escolher`).
 */
const HERDA = "__herda__";

/**
 * Cartão "Voz deste agente" na tela do AGENTE (issue #4228).
 *
 * A voz da resposta falada morava só na organização (`organizations.settings.
 * voz.voice_id`, cartão em Agente de IA → Provedores): oito agentes num número
 * falavam todos com a mesma voz, e quem dava personas diferentes precisava
 * renomear os agentes para caber numa voz só.
 *
 * Aqui a porta da escolha POR AGENTE: `ai_agents.config.voz_voice_id` (jsonb,
 * o mesmo lugar dos outros knobs por agente — sem coluna nova). A opção
 * "Voz da organização" grava `null`, que é a herança e o comportamento de
 * antes desta fatia, byte a byte. A lista vem da MESMA rota do cartão da
 * organização (`GET /api/v1/ai/voz`), então não há duas réguas de qual voz
 * existe na credencial.
 *
 * Sem credencial validada (ou sem voz nenhuma), o cartão NÃO aparece: um
 * seletor vazio prometeria uma escolha que o próximo turno não faria.
 */
export function VozDoAgente({ agentId, inicial, disabled }: Props) {
  const t = useT();
  const doAgente = typeof inicial === "string" ? inicial.trim() : "";
  const [vozDoAgente, setVozDoAgente] = useState(doAgente);
  const [vozDaOrg, setVozDaOrg] = useState("");
  const [vozes, setVozes] = useState<string[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    // A resposta pode chegar depois que a tela saiu: sem esta guarda, o setState
    // tardio lançava fora do React e virava rejeição não tratada (verify da 1.108.0).
    let vivo = true;
    void (async () => {
      try {
        const res = await apiClient.get<{
          data: { voiceId: string | null; vozesDisponiveis: string[] };
        }>("/api/v1/ai/voz");
        if (!vivo) return;
        setVozDaOrg(res.data.voiceId ?? "");
        setVozes(res.data.vozesDisponiveis ?? []);
      } catch (err) {
        // Resposta incompleta não derruba o resto do editor: sem lista, cartão fica fora.
        if (vivo) showApiError(err);
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function escolher(valor: string) {
    const anterior = vozDoAgente;
    const nova = valor === HERDA ? "" : valor;
    setVozDoAgente(nova);
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { voz_voice_id: nova === "" ? null : nova },
      });
      toast.success(
        nova === ""
          ? t("Voz deste agente: passa a usar a voz da organização.")
          : `${t("Voz deste agente salva:")} ${nova}`,
      );
    } catch (err) {
      setVozDoAgente(anterior);
      showApiError(err);
    } finally {
      setSalvando(false);
    }
  }

  if (carregando || vozes.length === 0) return null;

  // A voz já gravada entra na lista mesmo que não esteja mais na credencial
  // (voz apagada no ElevenLabs): o seletor mostra o que está SALVO em vez de
  // abrir em branco e fingir que ninguém escolheu.
  const opcoes = [...new Set([...(vozDaOrg ? [vozDaOrg] : []), ...(vozDoAgente ? [vozDoAgente] : []), ...vozes])];
  const contrato = vozDaOrg === "" ? t("Voz da organização") : `${t("Voz da organização")} (${vozDaOrg})`;

  return (
    <Card className="space-y-3 p-4">
      <div>
        <h3 className="text-sm font-medium">{t("Voz deste agente")}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            "Só vale com “Enviar nota de voz” ligado. Sem escolha própria, o agente fala com a voz da organização.",
          )}
        </p>
      </div>
      <div className="min-w-64 space-y-1">
        <Label htmlFor="voz_voice_id">{t("Qual voz este agente usa")}</Label>
        <Select
          value={vozDoAgente === "" ? HERDA : vozDoAgente}
          onValueChange={(v) => void escolher(v)}
          disabled={disabled || salvando}
        >
          <SelectTrigger id="voz_voice_id" data-testid="voz-do-agente">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={HERDA}>{contrato}</SelectItem>
            {opcoes.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </Card>
  );
}

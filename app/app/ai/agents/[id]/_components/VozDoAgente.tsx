"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  // Atualização que chega depois do desmonte não é inofensiva: o React agenda a
  // atualização e lê `window` no agendamento (resolveUpdatePriority). Com a tela
  // já fora e o ambiente do teste desmontado, isso vira `window is not defined` —
  // foi o vermelho do verify-parte (2) do #4447 e do verify-parte (3) do #4439,
  // com a pilha em `setCarregando(false)`. A guarda é do componente, não do
  // teste: quem navega antes de /api/v1/ai/voz responder faz o mesmo caminho em
  // produção.
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const carregar = useCallback(async () => {
    try {
      const res = await apiClient.get<{
        data: { voiceId: string | null; vozesDisponiveis: string[] };
      }>("/api/v1/ai/voz");
      if (!vivo.current) return;
      setVozDaOrg(res.data.voiceId ?? "");
      setVozes(res.data.vozesDisponiveis ?? []);
    } catch (err) {
      // Resposta incompleta não derruba o resto do editor: sem lista, cartão fica fora.
      if (vivo.current) showApiError(err);
    } finally {
      if (vivo.current) setCarregando(false);
    }
  }, []);

  // A resposta pode chegar depois que a tela saiu: sem a guarda do `vivo`, o
  // setState tardio lançava fora do React e virava rejeição não tratada (verify
  // da 1.108.0) — e com o ambiente do teste desmontado virava `window is not
  // defined` em `setCarregando(false)`. A guarda é do componente, não do teste:
  // quem navega antes de /api/v1/ai/voz responder faz o mesmo caminho em produção.
  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function escolher(valor: string) {
    const anterior = vozDoAgente;
    const nova = valor === HERDA ? "" : valor;
    setVozDoAgente(nova);
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/ai/agents/${agentId}`, {
        config: { voz_voice_id: nova === "" ? null : nova },
      });
      if (!vivo.current) return;
      toast.success(
        nova === ""
          ? t("Voz deste agente: passa a usar a voz da organização.")
          : `${t("Voz deste agente salva:")} ${nova}`,
      );
    } catch (err) {
      if (!vivo.current) return;
      setVozDoAgente(anterior);
      showApiError(err);
    } finally {
      if (vivo.current) setSalvando(false);
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

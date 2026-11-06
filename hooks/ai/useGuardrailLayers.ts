"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { CamadaConfiguravel } from "@/lib/agent-engine/guardrails/camadas-da-org";

/**
 * As verificações que são escolha da organização (`CAMADAS_CONFIGURAVEIS`): as que
 * consultam um modelo, e por isso são de quem paga a conta, e as que só o negócio
 * sabe se servem a ele.
 *
 * `escolha: null` significa "esta organização não escolheu", e aí vale
 * `padraoDoAmbiente`. Três estados, não dois: colapsá-los faria a tela mostrar um
 * interruptor desligado para quem tem a camada LIGADA pelo servidor.
 */
export interface CamadaDeSeguranca {
  layer: CamadaConfiguravel;
  escolha: boolean | null;
  padraoDoAmbiente: boolean;
  /** O que de fato vale hoje — é este que a tela usa para posicionar o controle. */
  efetivo: boolean;
}

/** O wrapper `ok()` do repo embrulha em `{ data }` — o hook desembrulha. */
interface Resposta {
  data: { camadas: CamadaDeSeguranca[]; podeEditar: boolean };
}

const CHAVE = ["ai", "guardrail-layers"] as const;

export function useGuardrailLayers() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<Resposta>("/api/v1/ai/guardrail-layers")).data,
  });
}

export function useSetGuardrailLayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { layer: CamadaConfiguravel; enabled: boolean }) =>
      apiClient.put("/api/v1/ai/guardrail-layers", v),
    // Sem o invalidate a tela mostraria o estado antigo depois de gravar, e o
    // usuário concluiria que o clique não pegou — o defeito que faz alguém clicar
    // duas vezes e desligar de volta o que acabou de ligar.
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface Acervo {
  guardar_historico: boolean;
  /** Só na resposta do PATCH: `false` = salvo, mas a sessão não foi reconfigurada agora. */
  aplicado?: boolean;
}

/**
 * A opção por conexão da #999: guardar o acervo do histórico do número.
 *
 * Desligada por padrão: enquanto a rota não respondeu, a tela mostra `false`,
 * que é a decisão do mantenedor. A frase embaixo é a que a issue pediu — o que
 * passa a ficar guardado, e onde. O "onde" não pode citar o transporte pelo
 * nome (doutrina de restrição de canal), então diz "o servidor do canal".
 */
export function ChannelAcervo({ channelId }: { channelId: string }) {
  const t = useT();
  const id = useId();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState(false);
  const query = useQuery({
    queryKey: ["channel-acervo", channelId],
    queryFn: () => apiClient.get<{ data: Acervo }>(`/api/v1/channel-sessions/${channelId}/acervo`),
    refetchOnWindowFocus: false,
  });
  const ligado = query.data?.data.guardar_historico ?? false;

  async function trocar(valor: boolean) {
    setBusy(true);
    setErro(false);
    try {
      const res = await apiClient.patch<{ data: Acervo }>(`/api/v1/channel-sessions/${channelId}/acervo`, { guardar_historico: valor });
      qc.setQueryData(["channel-acervo", channelId], { data: { guardar_historico: valor } });
      toast.success(res.data.aplicado === false
        ? t("Opção salva; vale na próxima reconexão do número.")
        : t("Opção de histórico salva."));
    } catch {
      setErro(true);
      void query.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Switch id={id} checked={ligado} disabled={busy || query.isFetching || query.isError} onCheckedChange={(v) => void trocar(v)} />
        <Label htmlFor={id} className="cursor-pointer text-xs font-normal">
          {t("Guardar o histórico anterior à vinculação")}
        </Label>
      </div>
      {/* Leitura que falhou não é "desligado": mostrar o default aqui afirmaria um estado que ninguém leu. */}
      {query.isError ? (
        <p role="alert" className="text-[11px] text-destructive">{t("Não foi possível ler esta opção.")}</p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {ligado
            ? t("Acervo ligado: o servidor do canal guarda as conversas deste número. Num número que já estava pareado, guarda daqui em diante; o histórico anterior (cerca de 1 ano) só chega numa vinculação nova. Ocupa disco lá e não é apagado quando o CRM anonimiza um contato.")
            : t("Acervo desligado: só as mensagens novas entram, como sempre.")}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">{t("Ligar ou desligar reinicia a conexão por alguns segundos. Desligar num número já pareado pode apagar o que o canal já guardou.")}</p>
      {erro && (
        <p role="alert" className="text-[11px] text-destructive">
          {t("Não foi possível guardar esta opção.")}
        </p>
      )}
    </div>
  );
}

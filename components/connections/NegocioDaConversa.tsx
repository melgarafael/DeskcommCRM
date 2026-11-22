"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface Negocio {
  conversa_nova_cria_negocio: boolean;
}

/**
 * O interruptor da #4670 no cartão da conexão: as conversas novas DESTE número
 * criam negócio no funil?
 *
 * Ligado é o estado de sempre, e o padrão vem do banco (`not null default
 * true`) — enquanto a rota não respondeu a tela mostra `true`, que é o que a
 * instalação antiga faz. A frase abaixo diz o que muda quando desliga, porque é
 * ali que a pessoa decide: sem ela, "não criar negócio" soa como "não atender".
 *
 * Mesma porta e mesmo desenho do `ChannelAcervo` ao lado: a opção é POR CONEXÃO,
 * a gravação é auditada no servidor e a leitura é de admin.
 */
export function NegocioDaConversa({ channelId }: { channelId: string }) {
  const t = useT();
  const id = useId();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState(false);
  const query = useQuery({
    queryKey: ["channel-negocio", channelId],
    queryFn: () => apiClient.get<{ data: Negocio }>(`/api/v1/channel-sessions/${channelId}/negocio-da-conversa`),
    refetchOnWindowFocus: false,
  });
  const ligado = query.data?.data.conversa_nova_cria_negocio ?? true;

  async function trocar(valor: boolean) {
    setBusy(true);
    setErro(false);
    try {
      await apiClient.patch<{ data: Negocio }>(`/api/v1/channel-sessions/${channelId}/negocio-da-conversa`, {
        conversa_nova_cria_negocio: valor,
      });
      qc.setQueryData(["channel-negocio", channelId], { data: { conversa_nova_cria_negocio: valor } });
      toast.success(t("Opção de negócio salva."));
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
        <Switch
          id={id}
          checked={ligado}
          disabled={busy || query.isFetching || query.isError}
          onCheckedChange={(v) => void trocar(v)}
        />
        <Label htmlFor={id} className="cursor-pointer text-xs font-normal">
          {t("Conversas novas criam negócio no funil")}
        </Label>
      </div>
      {/* Leitura que falhou não é "ligado": mostrar o padrão aqui afirmaria um estado que ninguém leu. */}
      {query.isError ? (
        <p role="alert" className="text-[11px] text-destructive">
          {t("Não foi possível ler esta opção.")}
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {ligado
            ? t("Ligado: cada conversa nova neste número abre um card no funil.")
            : t("Desligado: a conversa chega, o contato nasce, a IA atende — só o card não nasce. Criar o negócio à mão continua igual.")}
        </p>
      )}
      {erro && (
        <p role="alert" className="text-[11px] text-destructive">
          {t("Não foi possível guardar esta opção.")}
        </p>
      )}
    </div>
  );
}

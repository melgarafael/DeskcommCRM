"use client";

import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

import { useNegocioDaConversa } from "./NegocioDaConversa";

interface Etapa {
  id: string;
  name: string;
}
interface Funil {
  id: string;
  name: string;
  is_default: boolean;
  etapas: Etapa[];
}
interface Entrada {
  entry_pipeline_id: string | null;
  entry_stage_id: string | null;
  funis: Funil[];
}

/** O valor do Select para "usar o funil padrão" e "a etapa de entrada do funil". */
const PADRAO = "__padrao__";

/**
 * FUNIL DE ENTRADA DO NÚMERO (migration 9430): onde a conversa nova DESTE
 * número vira negócio. Sem escolha, vale o funil padrão da organização — e o
 * cartão diz isso em vez de mostrar um campo vazio.
 *
 * `criaNegocio` (#5142) é o interruptor ao lado: desligado, nada nasce no funil
 * e a frase acima seria mentira. O seletor CONTINUA na tela, desabilitado — é
 * ali que o admin vê onde a escolha mora e edita quando religar o interruptor;
 * esconder apagaria o mapa da configuração. Ausente ou `true`, a tela é a de
 * antes: as telas sem o interruptor (Canal Parceiro, Redes Sociais) não passam
 * nada e não mudam.
 */
export function FunilDeEntradaDoNumero({
  channelId,
  criaNegocio,
}: {
  channelId: string;
  criaNegocio?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const semEfeito = criaNegocio === false;
  const query = useQuery({
    queryKey: ["channel-entrada", channelId],
    queryFn: () => apiClient.get<{ data: Entrada }>(`/api/v1/channel-sessions/${channelId}/entrada`),
    retry: false,
  });
  // Resposta sem a lista (servidor antigo, rota substituída) conta como "ainda não
  // carregou": nunca quebra o cartão inteiro da conexão.
  const entrada = Array.isArray(query.data?.data?.funis) ? query.data.data : undefined;
  // Sem permissão (não é administrador) ou rota indisponível: o cartão some, como
  // as outras ações que só o administrador vê.
  if (query.isError) return null;

  const funil = entrada?.funis.find((f) => f.id === entrada.entry_pipeline_id) ?? null;
  const etapa = funil?.etapas.find((e) => e.id === entrada?.entry_stage_id) ?? null;
  const padrao = entrada?.funis.find((f) => f.is_default) ?? null;

  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-xs text-muted-foreground" data-testid={`funil-de-entrada-${channelId}`}>
        {semEfeito
          ? t("Sem efeito enquanto a opção acima estiver desligada")
          : !entrada
            ? t("Carregando…")
            : funil
              ? `${t("Contatos novos entram no funil")} ${funil.name}${etapa ? ` · ${etapa.name}` : ""}`
              : padrao
                ? `${t("Contatos novos entram no funil padrão")} (${padrao.name})`
                : t("Contatos novos entram no funil padrão")}
      </p>
      <Button variant="outline" size="sm" disabled={!entrada || semEfeito} onClick={() => setOpen(true)}>
        {t("Funil de entrada")}
      </Button>
      {open && entrada && (
        <FormularioDeEntrada
          channelId={channelId}
          inicial={entrada}
          onClose={() => setOpen(false)}
          onSaved={() => void query.refetch()}
        />
      )}
    </div>
  );
}

/**
 * O seletor no cartão da conexão, onde o interruptor existe (#5142): lê o mesmo
 * cache do `NegocioDaConversa` e repassa o estado. Mesma chave e mesma consulta
 * = um GET só; a troca do interruptor chega aqui pelo cache, sem prop drilling
 * por uma lista que renderiza um cartão por número (hook não pode entrar no
 * `map`).
 */
export function FunilDeEntradaDoCartao({ channelId }: { channelId: string }) {
  const { ligado } = useNegocioDaConversa(channelId);
  return <FunilDeEntradaDoNumero channelId={channelId} criaNegocio={ligado} />;
}

function FormularioDeEntrada({
  channelId,
  inicial,
  onClose,
  onSaved,
}: {
  channelId: string;
  inicial: Entrada;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const id = useId();
  const qc = useQueryClient();
  const [funilId, setFunilId] = useState(inicial.entry_pipeline_id ?? PADRAO);
  const [etapaId, setEtapaId] = useState(inicial.entry_stage_id ?? PADRAO);
  const [saving, setSaving] = useState(false);
  const etapas = inicial.funis.find((f) => f.id === funilId)?.etapas ?? [];

  async function salvar() {
    setSaving(true);
    try {
      const pipeline_id = funilId === PADRAO ? null : funilId;
      const stage_id = pipeline_id && etapaId !== PADRAO ? etapaId : null;
      await apiClient.patch(`/api/v1/channel-sessions/${channelId}/entrada`, { pipeline_id, stage_id });
      await qc.invalidateQueries({ queryKey: ["channel-entrada", channelId] });
      toast.success(t("Funil de entrada atualizado."));
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Não foi possível salvar o funil de entrada."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Funil de entrada deste número")}</DialogTitle>
          <DialogDescription>
            {t(
              "Quando alguém escreve pela primeira vez para este número, o negócio nasce no funil escolhido. Contatos que já têm negócio aberto não mudam de funil.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-funil`}>{t("Funil")}</Label>
            <Select
              value={funilId}
              onValueChange={(v) => {
                setFunilId(v);
                setEtapaId(PADRAO);
              }}
            >
              <SelectTrigger id={`${id}-funil`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PADRAO}>{t("Funil padrão da empresa")}</SelectItem>
                {inicial.funis.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {funilId !== PADRAO && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-etapa`}>{t("Etapa")}</Label>
              <Select value={etapaId} onValueChange={setEtapaId}>
                <SelectTrigger id={`${id}-etapa`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PADRAO}>{t("Etapa de entrada do funil")}</SelectItem>
                  {etapas.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {t(
              "Quem já é cliente e campanhas com funil próprio seguem as regras deles. Se o funil escolhido for arquivado, os contatos voltam a entrar no funil padrão.",
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("Cancelar")}
          </Button>
          <Button onClick={() => void salvar()} disabled={saving}>
            {saving ? t("Salvando…") : t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

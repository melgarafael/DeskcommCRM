"use client";

import * as React from "react";
import { toast } from "sonner";

import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { usePipelines, useWebhookSources } from "@/hooks/webhooks/useWebhookSources";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import type { CustomFieldDef } from "@/lib/schemas/settings";
import {
  TIPOS_CADASTRAVEIS_DA_CAPTACAO,
  chaveCadastravel,
  comNovoCampo,
  rotuloSugerido,
  tipoSugerido,
  type TipoCadastravel,
} from "@/lib/webhooks/campo-da-captacao";

type Traduz = (texto: string) => string;

/** O rótulo de cada tipo na tela. Cada texto é literal dentro de `t()` para o guarda de tradução enxergá-lo. */
function rotuloDoTipo(tipo: TipoCadastravel, t: Traduz): string {
  switch (tipo) {
    case "text":
      return t("Texto");
    case "textarea":
      return t("Texto longo");
    case "number":
      return t("Número");
    case "date":
      return t("Data");
    case "email":
      return t("E-mail");
    case "phone":
      return t("Telefone");
    case "url":
      return t("Link");
    case "boolean":
      return t("Sim/Não");
  }
}

export interface CampoDoFunilDaCaptacao {
  /** Só é `true` quando há funil legível e a fonte ainda existe — sem isso não se oferece o botão. */
  pronto: boolean;
  /** As definições do funil da fonte, para dar rótulo ao que já está cadastrado. */
  definicoes: CustomFieldDef[];
  cadastrar: (chave: string, rotulo: string, tipo: TipoCadastravel) => Promise<boolean>;
}

/**
 * O funil de destino da fonte que recebeu a captação, lido de `usePipelines`
 * (rota de `manager`: quem não tem o papel fica com `pronto: false` e não vê o
 * botão; quem tem mas não administra leva a recusa da server action).
 */
export function useCampoDoFunilDaCaptacao(webhookSourceId: string | null): CampoDoFunilDaCaptacao {
  const t = useT();
  const fontes = useWebhookSources();
  const funis = usePipelines();
  const refetchFunis = funis.refetch;

  const pipelineId =
    fontes.data?.data.find((f) => f.id === webhookSourceId)?.default_pipeline_id ?? null;
  const funil = pipelineId ? funis.data?.data.find((p) => p.id === pipelineId) : undefined;
  const definicoes = React.useMemo(() => camposDoFunil(funil?.settings ?? null), [funil]);

  const cadastrar = React.useCallback(
    async (chave: string, rotulo: string, tipo: TipoCadastravel): Promise<boolean> => {
      if (!pipelineId) return false;
      // `fields` é regravado INTEIRO pela server action: a base do acréscimo tem de ser a
      // leitura de agora, não a do cache de 60 s, ou o campo que outro admin cadastrou há
      // pouco some sem aviso.
      const fresco = await refetchFunis();
      const atual = fresco.data?.data.find((p) => p.id === pipelineId);
      if (!atual) {
        toast.error(t("Não foi possível ler o funil desta fonte."));
        return false;
      }
      const novo = comNovoCampo(camposDoFunil(atual.settings), chave, rotulo, tipo);
      if (!novo.ok) {
        toast.error(mensagemDoMotivo(novo.motivo, t));
        return false;
      }
      const r = await updatePipelineConfig(pipelineId, { fields: novo.fields });
      if (!r.ok) {
        toast.error(
          t("Não foi possível cadastrar o campo. Só quem administra o funil pode fazer isso."),
        );
        return false;
      }
      toast.success(
        t("Campo cadastrado. Ele já aparece no card do lead e pode ser usado nas mensagens."),
      );
      await refetchFunis();
      return true;
    },
    [pipelineId, refetchFunis, t],
  );

  return { pronto: Boolean(funil), definicoes, cadastrar };
}

function mensagemDoMotivo(
  motivo: "chave_invalida" | "ja_cadastrado" | "limite" | "rotulo_vazio",
  t: Traduz,
): string {
  switch (motivo) {
    case "chave_invalida":
      return t(
        "Este nome de campo não pode ser cadastrado aqui. Cadastre em Configurações › Funis.",
      );
    case "ja_cadastrado":
      return t("Esse campo já está cadastrado.");
    case "limite":
      return t("O funil já tem o máximo de campos.");
    case "rotulo_vazio":
      return t("Dê um rótulo ao campo.");
  }
}

/**
 * "Cadastrar como campo do lead" — o botão e o formulário de duas perguntas (como
 * a pessoa chama o campo e de que tipo ele é), sugeridas a partir do que chegou.
 */
export function CadastrarCampo({
  chave,
  valor,
  cadastrar,
}: {
  chave: string;
  valor: unknown;
  cadastrar: CampoDoFunilDaCaptacao["cadastrar"];
}) {
  const t = useT();
  const [aberto, setAberto] = React.useState(false);
  const [rotulo, setRotulo] = React.useState(() => rotuloSugerido(chave));
  const [tipo, setTipo] = React.useState<TipoCadastravel>(() => tipoSugerido(valor));
  const [salvando, setSalvando] = React.useState(false);

  // Nome de campo que a API recusaria (hífen, espaço, colchete…) não tem como virar
  // definição: em vez de um botão que sempre falha, a tela diz o que fazer.
  if (!chaveCadastravel(chave)) return null;

  if (!aberto) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mt-1"
        onClick={() => setAberto(true)}
      >
        {t("Cadastrar como campo do lead")}
      </Button>
    );
  }

  const salvar = async () => {
    setSalvando(true);
    try {
      if (await cadastrar(chave, rotulo, tipo)) setAberto(false);
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded-sm border border-border p-2">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground" htmlFor={`rotulo-${chave}`}>
          {t("Rótulo")}
        </Label>
        <Input
          id={`rotulo-${chave}`}
          value={rotulo}
          maxLength={80}
          onChange={(e) => setRotulo(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t("Tipo")}</Label>
        <Select value={tipo} onValueChange={(v) => setTipo(v as TipoCadastravel)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIPOS_CADASTRAVEIS_DA_CAPTACAO.map((t1) => (
              <SelectItem key={t1} value={t1}>
                {rotuloDoTipo(t1, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={salvando} onClick={salvar}>
          {t("Salvar")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={salvando}
          onClick={() => setAberto(false)}
        >
          {t("Cancelar")}
        </Button>
      </div>
    </div>
  );
}

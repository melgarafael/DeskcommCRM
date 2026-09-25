"use client";
/**
 * Editar o rascunho (Spec 12 §6).
 *
 * ═══ Por que esta tela é obrigatória, e não um luxo ═══
 *
 * Sem ela, um erro de digitação no texto não tinha conserto: a API aceitava o
 * PATCH, mas nenhuma tela o oferecia, e duplicar não resolvia — a cópia também
 * não podia ser editada. O caminho real era recriar a campanha do zero, com o
 * público e o ritmo de novo. Medido em produção, no dia em que a feature subiu.
 *
 * ═══ O que esta tela NÃO faz ═══
 *
 * Não edita campanha que já foi preparada. Depois do snapshot, cada destinatário
 * carrega o texto congelado com que vai receber, e trocar a campanha ali faria a
 * tela mostrar uma coisa e a fila enviar outra. Para mexer no conteúdo é preciso
 * voltar ao rascunho — e isso só vale enquanto nada saiu. O RITMO é a exceção, e
 * ele se edita na própria tela de detalhe, com a campanha em pé.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useCampanha, useEditarCampanha, usePreviaDaAudiencia } from "@/hooks/campanhas/useCampanhas";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { useAgentesPublicados, useEtapas, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";
import { DESCRICAO_DA_VARIAVEL, VARIAVEIS_DA_CAMPANHA } from "@/lib/campanhas/renderizador";

export function EditarCampanha({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const campanha = useCampanha(id);
  const canais = useChannelSessions();
  const salvar = useEditarCampanha(id);
  const previa = usePreviaDaAudiencia();

  const [nome, setNome] = useState("");
  const [canal, setCanal] = useState("");
  const [baseLegal, setBaseLegal] = useState<"consent" | "legitimate_interest">("consent");
  const [liaRef, setLiaRef] = useState("");
  const [comAlgumaTag, setComAlgumaTag] = useState("");
  const [semTags, setSemTags] = useState("");
  const [semInteracao, setSemInteracao] = useState("");
  const [limite, setLimite] = useState("100");
  const [texto, setTexto] = useState("");
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [agente, setAgente] = useState("");
  const [carregado, setCarregado] = useState(false);

  const funis = useFunis();
  const etapas = useEtapas(funil || null);
  const agentes = useAgentesPublicados();

  // Uma carga só: depois disso quem manda é o que a pessoa está digitando. Sem
  // a trava, o `refetchInterval` do detalhe apagaria a edição em andamento.
  useEffect(() => {
    const c = campanha.data;
    if (!c || carregado) return;
    const f = (c.audience_filter ?? {}) as Record<string, unknown>;
    setNome(c.name);
    setCanal(c.channel_session_id);
    setBaseLegal(c.base_legal === "legitimate_interest" ? "legitimate_interest" : "consent");
    setLiaRef(c.lia_ref ?? "");
    setComAlgumaTag(juntar(f.com_alguma_tag));
    setSemTags(juntar(f.sem_tags));
    setSemInteracao(f.sem_interacao_ha_dias == null ? "" : String(f.sem_interacao_ha_dias));
    setLimite(f.limite == null ? "100" : String(f.limite));
    setTexto(c.message_body ?? "");
    setFunil(c.pipeline_id ?? "");
    setEtapa(c.stage_id ?? "");
    setAgente(c.agent_id ?? "");
    setCarregado(true);
  }, [campanha.data, carregado]);

  const filtro = useMemo(
    () => ({
      com_alguma_tag: listar(comAlgumaTag),
      sem_tags: listar(semTags),
      sem_interacao_ha_dias: semInteracao ? Number(semInteracao) : null,
      limite: Number(limite) || 100,
    }),
    [comAlgumaTag, semTags, semInteracao, limite],
  );

  const temCriterio =
    filtro.com_alguma_tag.length > 0 ||
    filtro.sem_tags.length > 0 ||
    filtro.sem_interacao_ha_dias !== null;

  if (campanha.isLoading || !carregado) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const c = campanha.data;
  if (!c) {
    return (
      <div className="p-6">
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">{t("Não foi possível carregar a campanha.")}</p>
        </Card>
      </div>
    );
  }

  if (c.status !== "draft") {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t("Editar campanha")}</h1>
        <Card className="space-y-3 p-4">
          <p className="text-sm">
            {t(
              "Esta campanha já foi preparada: cada pessoa da lista tem o texto que vai receber guardado. Para mudar o texto ou o público, volte a campanha para rascunho — isso descarta a lista montada.",
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("O ritmo você ajusta na própria tela da campanha, sem descartar nada.")}
          </p>
          <Button variant="outline" onClick={() => router.push(`/app/campaigns/${id}`)}>
            {t("Voltar para a campanha")}
          </Button>
        </Card>
      </div>
    );
  }

  const podeSalvar =
    nome.trim() !== "" &&
    canal !== "" &&
    texto.trim() !== "" &&
    temCriterio &&
    (baseLegal !== "legitimate_interest" || liaRef.trim() !== "");

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Editar campanha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Enquanto é rascunho, tudo muda. Depois de preparada, só o ritmo.")}
        </p>
      </header>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Informações")}</h2>
        <div className="space-y-2">
          <Label htmlFor="e-nome">{t("Nome da campanha")}</Label>
          <Input id="e-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="e-canal">{t("Enviar pelo número")}</Label>
          <select
            id="e-canal"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
          >
            {(canais.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {channelLabel(s, t)}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Base legal do envio")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="e-base-legal"
              checked={baseLegal === "consent"}
              onChange={() => setBaseLegal("consent")}
            />
            {t("Consentimento — estas pessoas pediram para receber")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="e-base-legal"
              checked={baseLegal === "legitimate_interest"}
              onChange={() => setBaseLegal("legitimate_interest")}
            />
            {t("Interesse legítimo — com avaliação (LIA) registrada")}
          </label>
          {baseLegal === "legitimate_interest" && (
            <div className="space-y-2">
              <Label htmlFor="e-lia">{t("Referência da avaliação (LIA)")}</Label>
              <Input id="e-lia" value={liaRef} onChange={(e) => setLiaRef(e.target.value)} />
            </div>
          )}
        </fieldset>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Público")}</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="e-com-tags">{t("Com alguma destas etiquetas")}</Label>
            <Input
              id="e-com-tags"
              value={comAlgumaTag}
              onChange={(e) => setComAlgumaTag(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-sem-tags">{t("Sem nenhuma destas etiquetas")}</Label>
            <Input
              id="e-sem-tags"
              value={semTags}
              onChange={(e) => setSemTags(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-silencio">{t("Sem falar com a gente há (dias)")}</Label>
            <Input
              id="e-silencio"
              type="number"
              min={1}
              value={semInteracao}
              onChange={(e) => setSemInteracao(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-limite">{t("Máximo de contatos nesta campanha")}</Label>
            <Input
              id="e-limite"
              type="number"
              min={1}
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={!temCriterio || previa.isPending}
            onClick={() => previa.mutate({ audience_filter: filtro, message_body: texto, campaign_id: id })}
          >
            {previa.isPending ? t("Contando…") : t("Ver quantas pessoas")}
          </Button>
          {previa.data && (
            <p className="text-sm">
              <strong>{previa.data.elegiveis}</strong> {t("podem receber")}
              {previa.data.excluidos > 0 ? ` · ${previa.data.excluidos} ${t("ficam de fora")}` : ""}
            </p>
          )}
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Quem responder")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Em branco, tudo segue como hoje: o card nasce no funil do número e quem atende é o agente publicado nele.")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="e-funil">{t("Vira card no funil")}</Label>
            <select
              id="e-funil"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={funil}
              onChange={(ev) => {
                setFunil(ev.target.value);
                setEtapa("");
              }}
            >
              <option value="">{t("Funil do número (padrão)")}</option>
              {(funis.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-etapa">{t("Na etapa")}</Label>
            <select
              id="e-etapa"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={etapa}
              onChange={(ev) => setEtapa(ev.target.value)}
              disabled={!funil}
            >
              <option value="">{t("Primeira etapa do funil")}</option>
              {(etapas.data ?? [])
                .filter((x) => !x.is_won && !x.is_lost)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="e-agente">{t("Quem atende a resposta")}</Label>
          <select
            id="e-agente"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={agente}
            onChange={(ev) => setAgente(ev.target.value)}
          >
            <option value="">{t("Agente publicado no número (padrão)")}</option>
            {(agentes.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Mensagem")}</h2>
        <Textarea
          rows={6}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          aria-label={t("Texto da mensagem")}
        />
        <ul className="space-y-1 text-sm text-muted-foreground">
          {VARIAVEIS_DA_CAMPANHA.map((v) => (
            <li key={v}>
              <button
                type="button"
                className="rounded-md bg-surface-elevated px-1 font-mono text-xs"
                onClick={() => setTexto((atual) => `${atual}{{${v}}}`)}
              >
                {`{{${v}}}`}
              </button>{" "}
              — {t(DESCRICAO_DA_VARIAVEL[v])}
            </li>
          ))}
        </ul>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push(`/app/campaigns/${id}`)}>
          {t("Cancelar")}
        </Button>
        <Button
          disabled={!podeSalvar || salvar.isPending}
          onClick={async () => {
            await salvar.mutateAsync({
              name: nome.trim(),
              channel_session_id: canal,
              message_body: texto.trim(),
              base_legal: baseLegal,
              lia_ref: liaRef.trim() || null,
              audience_filter: filtro,
              pipeline_id: funil || null,
              stage_id: etapa || null,
              agent_id: agente || null,
            });
            router.push(`/app/campaigns/${id}`);
          }}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar alterações")}
        </Button>
      </div>
    </div>
  );
}

function listar(bruto: string): string[] {
  return bruto
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function juntar(valor: unknown): string {
  return Array.isArray(valor) ? valor.filter((v) => typeof v === "string").join(", ") : "";
}

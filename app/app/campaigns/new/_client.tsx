"use client";
/**
 * Criar campanha (PRD §8).
 *
 * ═══ Por que SEÇÕES e não um wizard de cinco passos ═══
 *
 * O PRD recomenda o wizard; a ordem das perguntas aqui é a mesma dele
 * (Informações → Público → Mensagem → Entrega), mas numa página só. O wizard
 * acrescentaria estado de passo, navegação entre passos e rascunho parcial
 * gravado a cada etapa — máquina para um formulário que cabe numa tela. O que
 * ele daria de útil, que é não deixar apertar "enviar" antes de conferir, já
 * existe: criar uma campanha cria um RASCUNHO, e preparar/testar/iniciar são
 * ações da tela de detalhe, cada uma com sua confirmação.
 *
 * A prévia do público fica ao lado do filtro, e não depois: o número que o
 * operador precisa ver antes de apertar é "quantas pessoas isto pega".
 */
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCriarCampanha, usePreviaDaAudiencia } from "@/hooks/campanhas/useCampanhas";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import {
  useAgentesPublicados,
  useEtapas,
  useFunis,
} from "@/hooks/campanhas/useDestinoDaCampanha";
import { VARIAVEIS_DA_CAMPANHA, DESCRICAO_DA_VARIAVEL } from "@/lib/campanhas/renderizador";

export function NovaCampanha() {
  const t = useT();
  const router = useRouter();
  const canais = useChannelSessions();
  const criar = useCriarCampanha();
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
  const [intervalo, setIntervalo] = useState("");
  const [janelaInicio, setJanelaInicio] = useState("");
  const [janelaFim, setJanelaFim] = useState("");
  const [tetoDiario, setTetoDiario] = useState("");
  const [tetoHorario, setTetoHorario] = useState("");
  const [extras, setExtras] = useState<string[]>([]);
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [agente, setAgente] = useState("");
  const [funilDoPublico, setFunilDoPublico] = useState("");
  const [etapaDoPublico, setEtapaDoPublico] = useState("");

  const funis = useFunis();
  const etapas = useEtapas(funil || null);
  const etapasDoPublico = useEtapas(funilDoPublico || null);
  const agentes = useAgentesPublicados();

  const filtro = useMemo(
    () => ({
      com_alguma_tag: listar(comAlgumaTag),
      sem_tags: listar(semTags),
      sem_interacao_ha_dias: semInteracao ? Number(semInteracao) : null,
      funis: funilDoPublico ? [funilDoPublico] : [],
      etapas: etapaDoPublico ? [etapaDoPublico] : [],
      limite: Number(limite) || 100,
    }),
    [comAlgumaTag, semTags, semInteracao, funilDoPublico, etapaDoPublico, limite],
  );

  const temCriterio =
    filtro.com_alguma_tag.length > 0 ||
    filtro.sem_tags.length > 0 ||
    filtro.funis.length > 0 ||
    filtro.etapas.length > 0 ||
    filtro.sem_interacao_ha_dias !== null;

  const podeSalvar =
    nome.trim() !== "" &&
    canal !== "" &&
    texto.trim() !== "" &&
    temCriterio &&
    (baseLegal !== "legitimate_interest" || liaRef.trim() !== "");

  async function salvar() {
    const criada = await criar.mutateAsync({
      name: nome.trim(),
      channel_session_id: canal,
      message_body: texto.trim(),
      base_legal: baseLegal,
      lia_ref: liaRef.trim() || null,
      audience_filter: filtro,
      intervalo_segundos: intervalo ? Number(intervalo) : null,
      janela_inicio_hora: janelaInicio ? Number(janelaInicio) : null,
      janela_fim_hora: janelaFim ? Number(janelaFim) : null,
      teto_diario: tetoDiario ? Number(tetoDiario) : null,
      teto_horario: tetoHorario ? Number(tetoHorario) : null,
      channel_session_ids: extras,
      pipeline_id: funil || null,
      stage_id: etapa || null,
      agent_id: agente || null,
    });
    router.push(`/app/campaigns/${criada.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Nova campanha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Isto cria um rascunho. Nada é enviado antes de você preparar a lista e iniciar.")}
        </p>
      </header>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Informações")}</h2>
        <div className="space-y-2">
          <Label htmlFor="nome">{t("Nome da campanha")}</Label>
          <Input
            id="nome"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder={t("Ex.: Reativação de clientes parados")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="canal">{t("Enviar pelo número")}</Label>
          <select
            id="canal"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
          >
            <option value="">{t("Escolha um número")}</option>
            {(canais.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {channelLabel(c, t)}
              </option>
            ))}
          </select>
          {canais.data?.length === 0 && (
            <p className="text-sm text-warning-fg">
              {t("Nenhum número conectado. Conecte um em Conexões antes de criar a campanha.")}
            </p>
          )}
        </div>

        {(canais.data ?? []).length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Falar também por estes números")}</legend>
            <p className="text-sm text-muted-foreground">
              {t(
                "A campanha reveza entre os números marcados, escolhendo a cada envio o que tem mais folga no teto do dia. Quem já conversa com você por um deles recebe por esse mesmo, para não chegar de um número desconhecido.",
              )}
            </p>
            {(canais.data ?? [])
              .filter((c) => c.id !== canal)
              .map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={extras.includes(c.id)}
                    onChange={(e) =>
                      setExtras((atual) =>
                        e.target.checked ? [...atual, c.id] : atual.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {channelLabel(c, t)}
                </label>
              ))}
            {extras.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Atenção: o intervalo e os tetos da CAMPANHA somam todos os números. Para o rodízio aumentar o volume, deixe o ritmo da campanha em branco e cada número usa o dele.",
                )}
              </p>
            )}
          </fieldset>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Base legal do envio")}</legend>
          <p className="text-sm text-muted-foreground">
            {t(
              "Quem recebe pode perguntar por que recebeu, e a resposta precisa existir antes do envio.",
            )}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="base-legal"
              value="consent"
              checked={baseLegal === "consent"}
              onChange={() => setBaseLegal("consent")}
            />
            {t("Consentimento — estas pessoas pediram para receber")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="base-legal"
              value="legitimate_interest"
              checked={baseLegal === "legitimate_interest"}
              onChange={() => setBaseLegal("legitimate_interest")}
            />
            {t("Interesse legítimo — com avaliação (LIA) registrada")}
          </label>
          {baseLegal === "legitimate_interest" && (
            <div className="space-y-2">
              <Label htmlFor="lia">{t("Referência da avaliação (LIA)")}</Label>
              <Input
                id="lia"
                value={liaRef}
                onChange={(e) => setLiaRef(e.target.value)}
                placeholder={t("Ex.: LIA-2026-01")}
              />
            </div>
          )}
        </fieldset>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Público")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Escolha pelo menos um critério — uma lista sem recorte ninguém confere antes de apertar.")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="com-tags">{t("Com alguma destas etiquetas")}</Label>
            <Input
              id="com-tags"
              value={comAlgumaTag}
              onChange={(e) => setComAlgumaTag(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sem-tags">{t("Sem nenhuma destas etiquetas")}</Label>
            <Input
              id="sem-tags"
              value={semTags}
              onChange={(e) => setSemTags(e.target.value)}
              placeholder={t("separe por vírgula")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="silencio">{t("Sem falar com a gente há (dias)")}</Label>
            <Input
              id="silencio"
              type="number"
              min={1}
              value={semInteracao}
              onChange={(e) => setSemInteracao(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pub-funil">{t("Com negócio no funil")}</Label>
            <select
              id="pub-funil"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={funilDoPublico}
              onChange={(e) => {
                setFunilDoPublico(e.target.value);
                setEtapaDoPublico("");
              }}
            >
              <option value="">{t("Qualquer um")}</option>
              {(funis.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pub-etapa">{t("Na etapa")}</Label>
            <select
              id="pub-etapa"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={etapaDoPublico}
              onChange={(e) => setEtapaDoPublico(e.target.value)}
              disabled={!funilDoPublico}
            >
              <option value="">{t("Qualquer etapa")}</option>
              {(etapasDoPublico.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="limite">{t("Máximo de contatos nesta campanha")}</Label>
            <Input
              id="limite"
              type="number"
              min={1}
              max={5000}
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
            onClick={() =>
              previa.mutate({ audience_filter: filtro, message_body: texto })
            }
          >
            {previa.isPending ? t("Contando…") : t("Ver quantas pessoas")}
          </Button>
          {previa.data && (
            <p className="text-sm">
              <strong>{previa.data.elegiveis}</strong> {t("podem receber")}
              {previa.data.excluidos > 0
                ? ` · ${previa.data.excluidos} ${t("ficam de fora")}`
                : ""}
            </p>
          )}
        </div>
        {previa.data && previa.data.excluidos > 0 && (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {Object.entries(previa.data.motivos).map(([motivo, quantos]) => (
              <li key={motivo}>
                {quantos} — {t(previa.data!.legenda[motivo] ?? motivo)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Mensagem")}</h2>
        <Textarea
          rows={6}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder={t("Escreva como você falaria com uma pessoa só.")}
          aria-label={t("Texto da mensagem")}
        />
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>{t("Você pode usar:")}</p>
          <ul className="space-y-1">
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
          <p>
            {t(
              "Quem não tiver o dado que a mensagem usa fica de fora, com o motivo na lista — mensagem com buraco não sai.",
            )}
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Quem responder")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Em branco, tudo segue como hoje: o card nasce no funil do número e quem atende é o agente publicado nele.")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="funil">{t("Vira card no funil")}</Label>
            <select
              id="funil"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={funil}
              onChange={(e) => {
                setFunil(e.target.value);
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
            <Label htmlFor="etapa">{t("Na etapa")}</Label>
            <select
              id="etapa"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={etapa}
              onChange={(e) => setEtapa(e.target.value)}
              disabled={!funil}
            >
              <option value="">{t("Primeira etapa do funil")}</option>
              {(etapas.data ?? [])
                .filter((e) => !e.is_won && !e.is_lost)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agente">{t("Quem atende a resposta")}</Label>
          <select
            id="agente"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={agente}
            onChange={(e) => setAgente(e.target.value)}
          >
            <option value="">{t("Agente publicado no número (padrão)")}</option>
            {(agentes.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground">
            {t("Vale só para conversas que nascem desta campanha: quem já falava com você continua com quem o atendia. Quem aborda precisa saber dizer de onde veio o contato — essa resposta tem de estar no material do agente escolhido.")}
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Ritmo desta campanha")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Em branco, vale o ritmo do número (Conexões › Proteção de envio). O que você puser aqui só pode deixar mais devagar.",
          )}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="intervalo">{t("Intervalo mínimo entre mensagens (segundos)")}</Label>
            <Input
              id="intervalo"
              type="number"
              min={1}
              value={intervalo}
              onChange={(e) => setIntervalo(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="teto">{t("Máximo por dia")}</Label>
            <Input
              id="teto"
              type="number"
              min={1}
              value={tetoDiario}
              onChange={(e) => setTetoDiario(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="teto-hora">{t("Máximo por hora")}</Label>
            <Input
              id="teto-hora"
              type="number"
              min={1}
              value={tetoHorario}
              onChange={(e) => setTetoHorario(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="janela-inicio">{t("Enviar só a partir das (hora)")}</Label>
            <Input
              id="janela-inicio"
              type="number"
              min={0}
              max={23}
              value={janelaInicio}
              onChange={(e) => setJanelaInicio(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="janela-fim">{t("Parar de enviar às (hora)")}</Label>
            <Input
              id="janela-fim"
              type="number"
              min={1}
              max={24}
              value={janelaFim}
              onChange={(e) => setJanelaFim(e.target.value)}
            />
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/app/campaigns")}>
          {t("Cancelar")}
        </Button>
        <Button disabled={!podeSalvar || criar.isPending} onClick={() => void salvar()}>
          {criar.isPending ? t("Salvando…") : t("Salvar rascunho")}
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

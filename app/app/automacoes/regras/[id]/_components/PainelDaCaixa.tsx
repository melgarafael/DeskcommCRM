"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { usePipelineStages, usePipelines, useWebhookSources } from "@/hooks/webhooks/useWebhookSources";
import { acoesQueFechamLaco, MENSAGEM_DO_LACO_DE_LEAD, TRIGGER_EVENTS } from "@/lib/schemas/webhooks";
import { DIAS_MAX, DIAS_MIN, GATILHO_DE_DATA_DO_FUNIL } from "@/lib/automation/gatilho-de-data-do-funil";
import {
  DIRECOES_DO_SILENCIO,
  GATILHO_ETAPA_PARADA,
  GATILHO_SILENCIO,
  type DirecaoDoSilencio,
} from "@/lib/automation/gatilhos-de-tempo";
import {
  MAXIMO_DE_CONDICOES,
  type AcaoDaRegra,
  type DadosDasCondicoes,
  type DadosDoGatilho,
  type LinhaDeCondicao,
  type Percurso,
  type ProblemaDoDesenho,
  type TelaDoGatilho,
} from "@/lib/automation/desenho-da-regra";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { ActionConfigForm, type ActionItem } from "@/app/app/webhooks/_components/ActionConfigForm";
import { CURATED_FIELDS, OP_LABELS, type Op } from "@/app/app/webhooks/_components/RuleEditor";
import { ACTION_LABELS, TRIGGER_LABELS, type ActionType, type TriggerEvent } from "@/app/app/webhooks/_components/labels";

import { VISUAL_DAS_CONDICOES, VISUAL_DO_GATILHO, visualDaAcao, type VisualDaCaixa } from "./visual";

const QUALQUER_FONTE = "__qualquer_fonte__";

function Cabecalho({ visual, titulo, etapa }: { visual: VisualDaCaixa; titulo: string; etapa?: string }) {
  const Icone = visual.icon;
  return (
    <div className="flex items-start gap-2">
      <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", visual.chipClassName)}>
        <Icone size={16} aria-hidden />
      </span>
      <div className="min-w-0">
        {etapa ? <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{etapa}</p> : null}
        <h2 className="text-base font-semibold text-text">{titulo}</h2>
      </div>
    </div>
  );
}

function Problemas({ lista }: { lista?: ProblemaDoDesenho[] }) {
  const t = useT();
  if (!lista || lista.length === 0) return null;
  return (
    <div role="alert" className="rounded-md border border-error/40 bg-error-bg p-3 text-sm text-error-fg">
      <p className="font-medium">{t("Para salvar, corrija:")}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {lista.map((p) => (
          <li key={p.mensagem}>{t(p.mensagem)}</li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────────────────── gatilho ───────────────────────── */

export function PainelDoGatilho({
  dados,
  etapa,
  onEvento,
  onTela,
}: {
  dados: DadosDoGatilho;
  etapa?: string;
  onEvento: (evento: string) => void;
  onTela: (tela: TelaDoGatilho) => void;
}) {
  const t = useT();
  const { data: funisRes } = usePipelines();
  const { data: fontesRes } = useWebhookSources();
  const funis = funisRes?.data ?? [];
  const fontes = fontesRes?.data ?? [];
  const evento = dados.evento;
  const tela = dados.tela;
  const camposDeData = camposDoFunil(funis.find((p) => p.id === tela.data.pipeline_id)?.settings ?? null).filter(
    (c) => c.type === "date",
  );
  const valorDaFonte = tela.fonte ?? QUALQUER_FONTE;

  return (
    <div className="space-y-4">
      <Cabecalho visual={VISUAL_DO_GATILHO} titulo={t("Gatilho")} etapa={etapa} />
      <Problemas lista={dados.problemas} />
      <div className="space-y-1">
        <Label>{t("O que dispara a automação")}</Label>
        <Select value={evento} onValueChange={onEvento}>
          <SelectTrigger aria-label={t("O que dispara a automação")}>
            <SelectValue placeholder={t("Escolha o gatilho")} />
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_EVENTS.map((ev) => (
              <SelectItem key={ev} value={ev}>
                {t(TRIGGER_LABELS[ev])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-text-muted">
          {t("Trocar o gatilho limpa as condições, como no editor em lista: cada gatilho tem os seus campos.")}
        </p>
      </div>

      {evento === "lead.created" ? (
        <div className="space-y-1">
          <Label>{t("Fonte do formulário")}</Label>
          <Select
            value={valorDaFonte}
            onValueChange={(v) => onTela({ ...tela, fonte: v === QUALQUER_FONTE ? null : v })}
          >
            <SelectTrigger aria-label={t("Fonte do formulário")}>
              <SelectValue placeholder={t("Qualquer fonte")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={QUALQUER_FONTE}>{t("Qualquer fonte")}</SelectItem>
              {tela.fonte && !fontes.some((f) => f.id === tela.fonte) ? (
                <SelectItem value={tela.fonte}>{t("Fonte removida")}</SelectItem>
              ) : null}
              {fontes.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted">
            {t("Escolha uma fonte para limitar esta automação a um formulário. Qualquer fonte mantém o comportamento geral.")}
          </p>
        </div>
      ) : null}

      {evento === GATILHO_DE_DATA_DO_FUNIL ? (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            {t(
              "O aviso sai no dia em que faltarem N dias para a data, uma vez por negócio. Para avisar DEPOIS da data, use N negativo — -60 confirma a entrega 60 dias após o casamento.",
            )}
          </p>
          <div className="space-y-1">
            <Label>{t("Funil do campo")}</Label>
            <Select
              value={tela.data.pipeline_id}
              onValueChange={(v) => onTela({ ...tela, data: { ...tela.data, pipeline_id: v, campo: "" } })}
            >
              <SelectTrigger aria-label={t("Funil do campo")}>
                <SelectValue placeholder={t("Escolha o funil")} />
              </SelectTrigger>
              <SelectContent>
                {funis.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("Campo de data")}</Label>
            <Select
              value={tela.data.campo}
              onValueChange={(v) => onTela({ ...tela, data: { ...tela.data, campo: v } })}
              disabled={camposDeData.length === 0}
            >
              <SelectTrigger aria-label={t("Campo de data")}>
                <SelectValue placeholder={t("Escolha o campo")} />
              </SelectTrigger>
              <SelectContent>
                {camposDeData.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tela.data.pipeline_id && camposDeData.length === 0 ? (
              <p className="text-xs text-text-muted">
                {t(
                  "Este funil ainda não tem campo de data. Cadastre um em Funis → Campos personalizados para poder escolhê-lo aqui.",
                )}
              </p>
            ) : null}
          </div>
          <div className="w-40 space-y-1">
            <Label htmlFor="designer-dias-da-data">{t("Faltam N dias")}</Label>
            <Input
              id="designer-dias-da-data"
              type="number"
              inputMode="numeric"
              min={DIAS_MIN}
              max={DIAS_MAX}
              value={tela.data.dias}
              onChange={(e) => onTela({ ...tela, data: { ...tela.data, dias: e.target.value } })}
            />
          </div>
        </div>
      ) : null}

      {evento === GATILHO_SILENCIO || evento === GATILHO_ETAPA_PARADA ? (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            {evento === GATILHO_SILENCIO
              ? t(
                  "O lembrete sai quando se passarem N dias sem mensagem na direção escolhida. Chegando mensagem nova, o relógio zera — e um novo silêncio de N dias gera outro lembrete. Nada é enviado ao cliente.",
                )
              : t(
                  "O lembrete sai quando se passarem N dias com o card na mesma etapa. Mudando a etapa, o relógio zera. Nada é enviado ao cliente.",
                )}
          </p>
          <div className="w-40 space-y-1">
            <Label htmlFor="designer-dias-do-tempo">{t("Depois de N dias")}</Label>
            <Input
              id="designer-dias-do-tempo"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              value={tela.tempo.dias}
              onChange={(e) => onTela({ ...tela, tempo: { ...tela.tempo, dias: e.target.value } })}
            />
          </div>
          {evento === GATILHO_SILENCIO ? (
            <div className="space-y-1">
              <Label>{t("Silêncio de")}</Label>
              <Select
                value={tela.tempo.direcao}
                onValueChange={(v) => onTela({ ...tela, tempo: { ...tela.tempo, direcao: v as DirecaoDoSilencio } })}
              >
                <SelectTrigger aria-label={t("Silêncio de")}>
                  <SelectValue placeholder={t("De quem é o silêncio")} />
                </SelectTrigger>
                <SelectContent>
                  {DIRECOES_DO_SILENCIO.map((d) => (
                    <SelectItem key={d} value={d}>
                      {t(
                        d === "da_equipe"
                          ? "Da equipe (nós não falamos)"
                          : d === "do_cliente"
                            ? "Do cliente (ele não respondeu)"
                            : "De qualquer um",
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={tela.tempo.proteger_pela_agenda}
              onChange={(e) => onTela({ ...tela, tempo: { ...tela.tempo, proteger_pela_agenda: e.target.checked } })}
            />
            {t("Não gerar lembrete quando o cliente tiver compromisso marcado")}
          </label>
        </div>
      ) : null}

      {acoesQueFechamLaco(evento, [{ type: "assign_owner" }]).length > 0 ? (
        <p className="rounded-md border border-border bg-muted p-3 text-xs text-text-muted">{t(MENSAGEM_DO_LACO_DE_LEAD)}</p>
      ) : null}
    </div>
  );
}

/* ───────────────────────── condições ───────────────────────── */

export function PainelDasCondicoes({
  dados,
  evento,
  etapa,
  onLinhas,
}: {
  dados: DadosDasCondicoes;
  evento: string;
  etapa?: string;
  onLinhas: (linhas: LinhaDeCondicao[]) => void;
}) {
  const t = useT();
  const { data: funisRes } = usePipelines();
  const padrao = funisRes?.data?.find((p) => p.is_default) ?? funisRes?.data?.[0] ?? null;
  const { data: quadro } = usePipelineStages(padrao?.id ?? null);
  const etapas = quadro?.data?.stages ?? [];
  const campos = evento ? (CURATED_FIELDS[evento as TriggerEvent] ?? []) : [];
  const linhas = dados.linhas;
  const mudar = (i: number, patch: Partial<LinhaDeCondicao>) =>
    onLinhas(linhas.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="space-y-4">
      <Cabecalho visual={VISUAL_DAS_CONDICOES} titulo={t("Condições")} etapa={etapa} />
      <Problemas lista={dados.problemas} />
      <p className="text-sm text-text-muted">
        {t("Todas as condições precisam valer para as ações rodarem. Se alguma não valer, nada acontece.")}
      </p>
      {!evento ? (
        <p className="text-sm text-text-muted">{t("Escolha o gatilho primeiro: cada gatilho tem os seus campos.")}</p>
      ) : null}
      {linhas.map((linha, i) => {
        // Linha nova começa na lista; só cai no modo avançado sozinha quando o
        // campo gravado não está na lista curada — a mesma regra do editor em lista.
        const avancado = linha.avancado ?? (linha.field !== "" && !campos.some((c) => c.value === linha.field));
        const curado = campos.find((c) => c.value === linha.field);
        return (
          <div key={i} className="space-y-2 rounded-md border border-border p-3" data-testid={`condicao-${i}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">{`${t("Condição")} ${i + 1}`}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onLinhas(linhas.filter((_, j) => j !== i))}
                aria-label={t("Remover condição")}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
            {avancado ? (
              <Input
                value={linha.field}
                onChange={(e) => mudar(i, { field: e.target.value })}
                placeholder={t("ex: lead.custom_fields.minha_chave")}
                aria-label={t("Campo")}
              />
            ) : (
              <Select
                value={linha.field}
                onValueChange={(v) => mudar(i, { field: v, op: campos.find((c) => c.value === v)?.op ?? "eq" })}
              >
                <SelectTrigger aria-label={t("Campo")}>
                  <SelectValue placeholder={t("Campo")} />
                </SelectTrigger>
                <SelectContent>
                  {campos.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {t(c.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="flex gap-2">
              <Select value={linha.op} onValueChange={(v) => mudar(i, { op: v as Op })}>
                <SelectTrigger className="w-32" aria-label={t("Operador")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OP_LABELS) as Op[]).map((op) => (
                    <SelectItem key={op} value={op}>
                      {t(curado?.lista && op === "contains" ? "tem a tag" : OP_LABELS[op])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {curado?.kind === "stage" && !avancado ? (
                <Select value={linha.value} onValueChange={(v) => mudar(i, { value: v })}>
                  <SelectTrigger className="flex-1" aria-label={t("Etapa")}>
                    <SelectValue placeholder={t("Etapa")} />
                  </SelectTrigger>
                  <SelectContent>
                    {etapas.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="flex-1"
                  value={linha.value}
                  onChange={(e) => mudar(i, { value: e.target.value })}
                  placeholder={t("Valor")}
                  aria-label={t("Valor")}
                />
              )}
            </div>
            <button
              type="button"
              className="text-xs text-text-muted underline underline-offset-4"
              onClick={() => mudar(i, { avancado: !avancado, ...(avancado && !curado ? { field: "" } : {}) })}
            >
              {avancado ? t("usar campo da lista") : t("usar campo avançado")}
            </button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onLinhas([...linhas, { field: "", op: "eq", value: "" }])}
        disabled={!evento || linhas.length >= MAXIMO_DE_CONDICOES}
      >
        <Plus size={14} aria-hidden /> {t("Adicionar condição")}
      </Button>
      <p className="text-xs text-text-muted">
        {t("Linhas sem campo ou sem valor são descartadas ao salvar, como no editor em lista. No máximo 10.")}
      </p>
    </div>
  );
}

/* ───────────────────────── ação ───────────────────────── */

export function PainelDaAcao({
  acao,
  problemas,
  etapa,
  evento,
  onAcao,
}: {
  acao: AcaoDaRegra;
  problemas?: ProblemaDoDesenho[];
  etapa?: string;
  evento: string;
  onAcao: (acao: AcaoDaRegra) => void;
}) {
  const t = useT();
  const visual = visualDaAcao(acao.type);
  if (acao.type === "ai_decide") {
    const opcoes = Array.isArray(acao.config.opcoes)
      ? (acao.config.opcoes as Array<{ id?: unknown; rotulo?: unknown; acao?: { type?: unknown } | null }>)
      : [];
    return (
      <div className="space-y-4">
        <Cabecalho visual={visual} titulo={t("A IA decide")} etapa={etapa} />
        <Problemas lista={problemas} />
        <p className="rounded-md border border-border bg-muted p-3 text-sm text-text-muted">
          {t(
            "Este passo foi criado pela API e hoje não tem tela de edição. O designer mostra, mantém a posição dele na fila e grava de volta sem mudar nada.",
          )}
        </p>
        {typeof acao.config.instrucao === "string" ? (
          <div className="space-y-1">
            <Label>{t("Instrução para a IA")}</Label>
            <p className="whitespace-pre-wrap break-words text-sm text-text">{acao.config.instrucao}</p>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label>{t("Opções")}</Label>
          <ul className="space-y-1 text-sm">
            {opcoes.map((o, i) => (
              <li key={i} className="rounded-md border border-border px-3 py-2">
                <span className="font-medium text-text">{typeof o.rotulo === "string" ? o.rotulo : "—"}</span>
                <span className="text-text-muted">
                  {` → ${typeof o.acao?.type === "string" ? t(ACTION_LABELS[o.acao.type as ActionType] ?? o.acao.type) : "—"}`}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  const conhecida = acao.type in ACTION_LABELS;
  return (
    <div className="space-y-4">
      <Cabecalho
        visual={visual}
        titulo={conhecida ? t(ACTION_LABELS[acao.type as ActionType]) : acao.type}
        etapa={etapa}
      />
      <Problemas lista={problemas} />
      {acoesQueFechamLaco(evento, [acao]).length > 0 ? (
        <p role="alert" className="rounded-md border border-error/40 bg-error-bg p-3 text-sm text-error-fg">
          {t(MENSAGEM_DO_LACO_DE_LEAD)}
        </p>
      ) : null}
      {conhecida ? (
        <ActionConfigForm
          action={acao as unknown as ActionItem}
          onChange={(next) => onAcao(next as unknown as AcaoDaRegra)}
        />
      ) : (
        <p className="text-sm text-text-muted">
          {t("Esta ação não existe nesta instalação. Exclua a caixa ou escolha outra ação.")}
        </p>
      )}
    </div>
  );
}

/* ───────────────────────── ligação e resumo ───────────────────────── */

export function PainelDaLigacao({ origem, destino, onExcluir }: { origem: string; destino: string; onExcluir: () => void }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-text">{t("Ligação")}</h2>
      <p className="text-sm text-text">
        {`${t("De")} “${origem}” ${t("para")} “${destino}”.`}
      </p>
      <p className="text-xs text-text-muted">
        {t("Para trocar o destino, arraste a bolinha de saída até outra caixa. Para tirar, exclua a ligação.")}
      </p>
      <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={onExcluir}>
        <Trash size={14} aria-hidden className="mr-1" />
        {t("Excluir ligação")}
      </Button>
    </div>
  );
}

export function ResumoDaAutomacao({
  percurso,
  evento,
  problemasGerais,
  nova,
  tituloDaAcao,
}: {
  percurso: Percurso;
  evento: string;
  problemasGerais: ProblemaDoDesenho[];
  nova: boolean;
  tituloDaAcao: (acao: AcaoDaRegra) => string;
}) {
  const t = useT();
  const condicoes =
    percurso.condicoes?.data.kind === "condicoes"
      ? percurso.condicoes.data.linhas.filter((l) => l.field.trim() && l.value.trim()).length
      : 0;
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-text">{t("Como esta automação roda")}</h2>
      <Problemas lista={problemasGerais} />
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Quando")}</dt>
          <dd className="text-text">{evento ? t(TRIGGER_LABELS[evento as TriggerEvent] ?? evento) : t("Escolha o gatilho")}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Se")}</dt>
          <dd className="text-text">
            {condicoes === 0
              ? t("Sem condições: roda em todo evento.")
              : `${condicoes} ${condicoes === 1 ? t("condição") : t("condições")}, ${t("todas precisam valer")}`}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{t("Então")}</dt>
          <dd>
            {percurso.acoes.length === 0 ? (
              <span className="text-text-muted">{t("Nenhuma ação ligada.")}</span>
            ) : (
              <ol className="list-decimal space-y-0.5 pl-5 text-text">
                {percurso.acoes.map((c) => (
                  <li key={c.id}>{c.data.kind === "acao" ? tituloDaAcao(c.data.acao) : ""}</li>
                ))}
              </ol>
            )}
          </dd>
        </div>
      </dl>
      <p className="rounded-md border border-border bg-muted p-3 text-xs text-text-muted">
        {t(
          "O desenho vira a mesma regra que o editor em lista grava: o gatilho, as condições e as ações na ordem das ligações. A posição das caixas não é gravada; ao abrir, o designer organiza sozinho.",
        )}
      </p>
      {nova ? <p className="text-xs text-text-muted">{t("A automação nasce pausada. Revise e ligue quando estiver pronta.")}</p> : null}
      <p className="text-xs text-text-muted">
        {t("Clique numa caixa para configurar. Na paleta, clicar põe a caixa logo depois da selecionada, já ligada.")}
      </p>
    </div>
  );
}

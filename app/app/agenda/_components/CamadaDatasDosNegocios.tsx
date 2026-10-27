"use client";

import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import type {
  FunilComDatas,
  ItemDeDataDoNegocio,
  JanelaDeDias,
} from "@/lib/agenda/datas-dos-negocios";
import { cn } from "@/lib/utils";

/**
 * A camada "Datas dos negócios" da Agenda (#3221).
 *
 * ─── O que ela é, e o que ela NÃO é ────────────────────────────────────────
 *
 * Um espelho das datas que já moram nos negócios: o embarque no dia do
 * embarque, o retorno no dia do retorno. **Só leitura** — clicar num item leva
 * ao negócio no funil (o `?lead=` que o quadro já entende), e é lá que a data
 * muda. Nenhum gesto daqui cria, move ou altera negócio, e por isso nenhum
 * item ocupa horário livre, aparece em `crm_find_free_slots` ou manda lembrete:
 * a Agenda continua respondendo "o que está marcado" com os compromissos, e
 * esta camada acrescenta "quem embarca e quem volta" ao lado.
 *
 * ─── Desligada por padrão, e por que isso é o desenho ──────────────────────
 *
 * A decisão (a) da issue — quais campos entram por padrão — é do mantenedor e
 * está aberta. Enquanto ela não volta, o default conservador é NENHUM: a
 * camada nasce desligada, e ligada não escolhe campo por heurística de nome
 * (`data_inicio`, `data_fim`) — pede a escolha na tela. Quem não quer a camada
 * não paga por ela: desligada, o componente não busca nada e não desenha item
 * nenhum, só o próprio interruptor.
 *
 * ─── Onde o recorte vem ────────────────────────────────────────────────────
 *
 * `janela` chega em DIAS de calendário do fuso da organização (calculada por
 * quem já sabe o fuso e a âncora da grade). Este componente nunca converte
 * instante em dia: essa conta mora num lugar só, e duas réguas de data no mesmo
 * produto divergem no dia em que uma for corrigida.
 */

/**
 * Valor sentinela do "sem segundo campo".
 *
 * `SelectItem` com `value=""` não existe (o Radix recusa): a ausência precisa de
 * um código próprio, que nunca é a chave de um campo real — `customFieldSchema`
 * exige chave começando por letra, e este começa por hífen. Mesmo motivo (e
 * mesma forma) do `SEM_INTERVALO` do Calendário do funil.
 */
const SEM_SEGUNDO_CAMPO = "-sem-segundo-campo";

interface Props {
  /** Os funis que declaram campo de data — descobertos no servidor. Vazio = a camada nem aparece. */
  funis: FunilComDatas[];
  /** O recorte desenhado na grade, em `YYYY-MM-DD` do fuso da organização. */
  janela: JanelaDeDias;
}

/** `YYYY-MM-DD` → `Date` no calendário local, ao meio-dia. */
function diaLocal(chave: string): Date {
  const [ano, mes, dia] = chave.split("-").map(Number);
  // Meio-dia, e não meia-noite: um `Date` de meia-noite local está a três horas
  // do dia anterior em UTC, e qualquer formatação que passe por UTC voltaria um
  // dia atrás. Ao meio-dia sobra folga para os dois lados.
  return new Date(ano!, mes! - 1, dia!, 12, 0, 0);
}

export function CamadaDatasDosNegocios({ funis, janela }: Props) {
  const t = useT();
  const tag = useTagDeIdioma();

  const [ligada, setLigada] = React.useState(false);
  const [funilEscolhido, setFunilEscolhido] = React.useState<string | null>(null);
  const [campoEscolhido, setCampoEscolhido] = React.useState<string | null>(null);
  const [campoFimEscolhido, setCampoFimEscolhido] = React.useState<string | null>(null);
  const [itens, setItens] = React.useState<ItemDeDataDoNegocio[] | null>(null);
  const [truncado, setTruncado] = React.useState(false);
  const [erro, setErro] = React.useState<"campo_nao_e_data" | "geral" | null>(null);
  const [carregando, setCarregando] = React.useState(false);

  /**
   * Derivados, não sincronizados por efeito — a mesma regra do Calendário do
   * funil (`components/kanban/CalendarioDoFunil.tsx`): o funil e o campo
   * escolhidos só valem se AINDA existem. É o que faz a decisão (c) — campo
   * renomeado ou removido — cair no estado "escolha o campo" em vez de numa
   * grade vazia sem explicação.
   */
  const funil = funis.find((f) => f.id === funilEscolhido) ?? funis[0] ?? null;
  const campo = funil && campoEscolhido && funil.campos.some((c) => c.key === campoEscolhido)
    ? campoEscolhido
    : null;
  const campoFim =
    campo && campoFimEscolhido && campoFimEscolhido !== campo &&
    (funil?.campos.some((c) => c.key === campoFimEscolhido) ?? false)
      ? campoFimEscolhido
      : null;

  const funilId = ligada ? (funil?.id ?? null) : null;
  const campoDaBusca = funilId ? campo : null;

  /**
   * A consulta depende de PRIMITIVOS, e não de um objeto montado no render.
   *
   * `{ funil, campo, campoFim }` é um objeto novo a cada render: como dependência
   * de efeito ele reabre a busca em toda repintura, `setItens` repinta, e o
   * ciclo não termina. As quatro strings abaixo mudam quando — e só quando —
   * muda a pergunta.
   */
  const chaveDaConsulta = campoDaBusca
    ? `${funilId}|${campoDaBusca}|${campoFim ?? ""}|${janela.de}|${janela.ate}`
    : null;

  React.useEffect(() => {
    if (!chaveDaConsulta || !funilId || !campoDaBusca) {
      setItens(null);
      setTruncado(false);
      setCarregando(false);
      // O aviso de campo que sumiu SOBREVIVE a este ramo: é justamente ele que
      // zerou a escolha, e apagá-lo aqui faria o motivo sumir no mesmo instante
      // em que apareceu. Escolher outro campo limpa (`setErro(null)` lá embaixo).
      setErro((atual) => (atual === "campo_nao_e_data" ? atual : null));
      return;
    }

    const controle = new AbortController();
    const parametros = new URLSearchParams({
      pipeline_id: funilId,
      campo: campoDaBusca,
      de: janela.de,
      ate: janela.ate,
    });
    if (campoFim) parametros.set("campo_fim", campoFim);

    setCarregando(true);
    setErro(null);
    fetch(`/api/v1/agenda/datas-dos-negocios?${parametros.toString()}`, {
      signal: controle.signal,
    })
      .then(async (resposta) => {
        const corpo = (await resposta.json()) as {
          data?: { itens: ItemDeDataDoNegocio[]; truncado: boolean };
          error?: { code?: string };
        };
        if (!resposta.ok || !corpo.data) {
          // `campo_nao_e_data` tem tratamento próprio (decisão (c) da issue): o
          // campo que a pessoa escolheu deixou de existir no funil — renomeado
          // ou apagado. A escolha é ESQUECIDA, e a camada volta ao estado
          // "escolha o campo" com o motivo à vista; insistir nela repetiria o
          // 422 a cada repintura, e uma grade vazia sem explicação é
          // indistinguível de "ninguém embarca neste período".
          const campoSumiu = corpo.error?.code === "campo_nao_e_data";
          setErro(campoSumiu ? "campo_nao_e_data" : "geral");
          if (campoSumiu) setCampoEscolhido(null);
          setItens(null);
          setTruncado(false);
          return;
        }
        setItens(corpo.data.itens);
        setTruncado(corpo.data.truncado);
      })
      .catch((falha: unknown) => {
        if (falha instanceof Error && falha.name === "AbortError") return;
        setErro("geral");
        setItens(null);
      })
      .finally(() => {
        if (!controle.signal.aborted) setCarregando(false);
      });

    return () => controle.abort();
  }, [chaveDaConsulta, funilId, campoDaBusca, campoFim, janela.de, janela.ate]);

  // Sem funil com campo de data não há camada a oferecer: a tela fica EXATAMENTE
  // como era antes desta entrega — nem o interruptor aparece.
  if (funis.length === 0) return null;

  const campos = funil?.campos ?? [];
  const porDia = new Map<string, ItemDeDataDoNegocio[]>();
  for (const item of itens ?? []) {
    const doDia = porDia.get(item.dia);
    if (doDia) doDia.push(item);
    else porDia.set(item.dia, [item]);
  }

  return (
    <section
      data-testid="camada-datas-dos-negocios"
      data-camada={ligada ? "ligada" : "desligada"}
      className="rounded-lg border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            data-testid="camada-datas-alternar"
            aria-pressed={ligada}
            onClick={() => setLigada((atual) => !atual)}
            className={cn(
              "min-h-11 rounded-md px-3 py-1 text-xs font-medium transition-colors lg:min-h-0",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
              ligada
                ? "bg-accent text-accent-foreground"
                : "text-text-muted hover:bg-surface-elevated hover:text-text",
            )}
          >
            {t("Datas dos negócios")}
          </button>
          {ligada ? (
            <span className="text-xs text-text-muted">
              {t("Só leitura: para mudar a data, abra o negócio.")}
            </span>
          ) : null}
        </div>

        {ligada ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={funil?.id ?? undefined}
              onValueChange={(valor) => {
                // Funil novo, campos novos: manter a escolha anterior apontaria
                // para uma chave que o outro funil não declara.
                setFunilEscolhido(valor);
                setCampoEscolhido(null);
                setCampoFimEscolhido(null);
              }}
            >
              <SelectTrigger
                aria-label={t("Funil das datas")}
                data-testid="camada-datas-funil"
                className="h-9 w-auto text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {funis.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={campo ?? ""}
              onValueChange={(valor) => {
                setCampoEscolhido(valor);
                if (valor === campoFimEscolhido) setCampoFimEscolhido(null);
              }}
            >
              <SelectTrigger
                aria-label={t("Campo de data do negócio")}
                data-testid="camada-datas-campo"
                className="h-9 w-auto text-xs"
              >
                <SelectValue placeholder={t("Escolha o campo de data")} />
              </SelectTrigger>
              <SelectContent>
                {campos.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {campo ? (
              <Select
                value={campoFim ?? SEM_SEGUNDO_CAMPO}
                onValueChange={(valor) =>
                  setCampoFimEscolhido(valor === SEM_SEGUNDO_CAMPO ? null : valor)
                }
              >
                <SelectTrigger
                  aria-label={t("Segundo campo de data")}
                  data-testid="camada-datas-campo-fim"
                  className="h-9 w-auto text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_SEGUNDO_CAMPO}>{t("Sem segundo campo")}</SelectItem>
                  {campos
                    .filter((c) => c.key !== campo)
                    .map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        ) : null}
      </div>

      {ligada ? (
        <div data-testid="camada-datas-itens" className="max-h-64 overflow-y-auto border-t px-3 py-2">
          {erro === "campo_nao_e_data" ? (
            <p data-testid="camada-datas-erro" className="text-xs text-text-muted">
              {t("Este campo de data não existe mais neste funil.")}
            </p>
          ) : erro === "geral" ? (
            <p data-testid="camada-datas-erro" className="text-xs text-danger">
              {t("Não foi possível carregar as datas dos negócios.")}
            </p>
          ) : !campo ? (
            <p data-testid="camada-datas-aviso" className="text-xs text-text-muted">
              {t("Escolha o campo de data para ver os negócios na agenda.")}
            </p>
          ) : carregando && itens === null ? (
            <p className="text-xs text-text-muted">{t("Carregando…")}</p>
          ) : porDia.size === 0 ? (
            <p data-testid="camada-datas-vazio" className="text-xs text-text-muted">
              {t("Nenhum negócio com esse campo de data neste período.")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {Array.from(porDia.entries()).map(([dia, doDia]) => (
                <li key={dia} data-testid={`camada-datas-dia-${dia}`}>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    {new Intl.DateTimeFormat(tag, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    }).format(diaLocal(dia))}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {doDia.map((item) => (
                      <li key={`${item.negocio.id}-${item.dia}`}>
                        {/* Só leitura: o clique ABRE o negócio no funil; não
                            move nada. É o `?lead=` que o quadro já entende. */}
                        <a
                          data-testid={`camada-datas-item-${item.negocio.id}`}
                          href={`/app/pipelines/${item.negocio.funilId}?lead=${item.negocio.id}`}
                          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-xs hover:bg-surface-elevated"
                        >
                          <span className="font-medium">{item.negocio.titulo}</span>
                          <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                            {item.rotulos.join(" · ")}
                          </span>
                          <span className="text-text-muted">
                            {item.negocio.funilNome}
                            {item.negocio.etapaNome ? ` · ${item.negocio.etapaNome}` : ""}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {truncado ? (
            <p data-testid="camada-datas-truncado" className="mt-2 text-xs text-text-muted">
              {t("Há mais negócios do que cabe aqui. Estreite o período ou o funil.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

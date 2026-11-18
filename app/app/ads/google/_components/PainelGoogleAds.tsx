"use client";

import { Fragment, useMemo, useState } from "react";

import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import {
  Buildings,
  CalendarBlank,
  CaretDown,
  CaretRight,
  ChartBar,
  CheckCircle,
  Gauge,
  Kanban,
  MagnifyingGlass,
} from "@/lib/ui/icons";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

type Dimensao = "campanha" | "grupo" | "anuncio" | "palavraChave";
const niveis = {
  campanha: { plural: "Campanhas", singular: "Campanha", sem: "Campanha não informada" },
  grupo: { plural: "Grupos de anúncios", singular: "Grupo", sem: "Grupo não informado" },
  anuncio: { plural: "Anúncios", singular: "Anúncio", sem: "Anúncio não informado" },
  palavraChave: {
    plural: "Palavras-chave",
    singular: "Palavra-chave",
    sem: "Palavra-chave não informada",
  },
} as const;
const dimensoes: Dimensao[] = ["campanha", "grupo", "anuncio", "palavraChave"];
const ausente = "sem-conta";
const formatadores = new Map<string, Intl.NumberFormat>();
const porPagina = 10;

interface Totais {
  negocios: number;
  ganhos: number;
  perdidos: number;
  valores: Map<string, number>;
  semMoeda: boolean;
}

function somar(linhas: LinhaPainelGoogle[]): Totais {
  const totais: Totais = {
    negocios: 0,
    ganhos: 0,
    perdidos: 0,
    valores: new Map(),
    semMoeda: false,
  };
  for (const linha of linhas) {
    totais.negocios += linha.negocios;
    totais.ganhos += linha.ganhos;
    totais.perdidos += linha.perdidos;
    if (linha.ganhos && linha.moeda && /^[A-Z]{3}$/.test(linha.moeda)) {
      totais.valores.set(
        linha.moeda,
        (totais.valores.get(linha.moeda) ?? 0) + linha.valorGanhoCentavos,
      );
    } else if (linha.ganhos) {
      totais.semMoeda = true;
    }
  }
  return totais;
}

function dinheiro(totais: Totais, locale: string, t: (texto: string) => string) {
  const valores = [...totais.valores]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([moeda, centavos]) => {
      const chave = locale + "/" + moeda;
      let formato = formatadores.get(chave);
      if (!formato) {
        formato = new Intl.NumberFormat(locale, {
          style: "currency",
          currency: moeda,
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
        formatadores.set(chave, formato);
      }
      return formato.format(centavos / 100);
    });
  if (totais.semMoeda) valores.push(t("Moeda não informada"));
  return valores.join(" · ") || "—";
}

function taxa(totais: Totais, porcentagem: Intl.NumberFormat) {
  return totais.negocios ? porcentagem.format(totais.ganhos / totais.negocios) : "—";
}

function identificador(linha: LinhaPainelGoogle, nivel: Dimensao) {
  if (nivel === "campanha") return linha.campanhaId;
  if (nivel === "grupo") return linha.grupoId;
  if (nivel === "anuncio") return linha.anuncioId;
  return null;
}

function tituloDoNivel(linha: LinhaPainelGoogle, nivel: Dimensao, t: (texto: string) => string) {
  const id = identificador(linha, nivel);
  return linha[nivel] || (id ? `${t(niveis[nivel].singular)} ${id}` : t(niveis[nivel].sem));
}

function origem(linha: LinhaPainelGoogle, nivel: Dimensao) {
  const partes: (string | null)[] = [linha.conta];
  for (const item of dimensoes) {
    if (nivel === "palavraChave" && item === "anuncio") continue;
    const id = identificador(linha, item);
    partes.push(id ? `id:${id}` : linha[item] ? `nome:${linha[item]}` : null);
    if (item === nivel) break;
  }
  return JSON.stringify(partes);
}

function agrupar(
  linhas: LinhaPainelGoogle[],
  nivel: Dimensao,
  locale: string,
  t: (texto: string) => string,
) {
  const grupos = new Map<string, LinhaPainelGoogle[]>();
  for (const linha of linhas) {
    const chave = origem(linha, nivel);
    const grupo = grupos.get(chave);
    if (grupo) grupo.push(linha);
    else grupos.set(chave, [linha]);
  }
  return [...grupos]
    .map(([chave, itens]) => {
      const linha = itens.find((item) => !!item[nivel]) ?? itens[0]!;
      return { chave, linha, titulo: tituloDoNivel(linha, nivel, t), totais: somar(itens) };
    })
    .sort(
      (a, b) =>
        b.totais.negocios - a.totais.negocios ||
        b.totais.ganhos - a.totais.ganhos ||
        a.titulo.localeCompare(b.titulo, locale),
    );
}

function inicioEm(hoje: string, dias: number) {
  const data = new Date(hoje + "T00:00:00Z");
  data.setUTCDate(data.getUTCDate() - dias + 1);
  return data.toISOString().slice(0, 10);
}

interface Props {
  linhas: LinhaPainelGoogle[];
  hoje: string;
  nomesDasContas?: Record<string, string>;
}

export function PainelGoogleAds({ linhas, hoje, nomesDasContas }: Props) {
  const t = useT();
  const locale = useTagDeIdioma();
  const porcentagem = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const numero = new Intl.NumberFormat(locale);
  const dataCurta = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const [dias, setDias] = useState(30);
  const [conta, setConta] = useState("");
  const [nivel, setNivel] = useState<Dimensao>("campanha");
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState<string | null>(null);
  const [pagina, setPagina] = useState(1);
  const inicio = inicioEm(hoje, dias);
  const contas = useMemo(
    () => [...new Set(linhas.map((l) => l.conta ?? ausente))].sort(),
    [linhas],
  );
  const filtradas = useMemo(
    () =>
      linhas.filter(
        (l) => l.dia >= inicio && l.dia <= hoje && (!conta || (l.conta ?? ausente) === conta),
      ),
    [linhas, inicio, hoje, conta],
  );
  const total = useMemo(() => somar(filtradas), [filtradas]);
  const emAberto = total.negocios - total.ganhos - total.perdidos;
  const campanhas = useMemo(
    () => agrupar(filtradas, "campanha", locale, t),
    [filtradas, locale, t],
  );
  const grupos = useMemo(
    () => (nivel === "campanha" ? campanhas : agrupar(filtradas, nivel, locale, t)),
    [filtradas, nivel, campanhas, locale, t],
  );
  const nomeConta = (id: string | null) =>
    id && id !== ausente
      ? nomesDasContas?.[id] || id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")
      : t("Conta não informada");
  const normalizar = (valor: string) =>
    valor
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase(locale);
  const termo = normalizar(busca.trim());
  const visiveis = grupos.filter(
    ({ titulo, linha }) =>
      !termo ||
      normalizar(
        [
          titulo,
          nomeConta(linha.conta),
          linha.conta,
          identificador(linha, nivel),
          linha.campanha,
          linha.grupo,
        ].join(" "),
      ).includes(termo),
  );
  const paginas = Math.max(1, Math.ceil(visiveis.length / porPagina));
  const situacoes = [
    { nome: t("Ganhos"), valor: total.ganhos, classe: "bg-success" },
    { nome: t("Em aberto"), valor: emAberto, classe: "bg-info" },
    { nome: t("Perdidos"), valor: total.perdidos, classe: "bg-border-strong" },
  ];
  function voltarAoInicio() {
    setPagina(1);
    setAberto(null);
  }
  const periodo = dataCurta.formatRange(
    new Date(inicio + "T00:00:00Z"),
    new Date(hoje + "T00:00:00Z"),
  ).replace(/[\u2009\u202F]/g, " ");

  return (
    <section
      className="grid w-full min-w-0 gap-3 text-sm leading-[1.45] text-text tabular-nums sm:gap-[18px] [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-2 [&_:focus-visible]:outline-accent [&_button]:cursor-pointer"
      data-superficie="clara"
      aria-label={t("Resultados no CRM")}
    >
      <header className="flex flex-col items-start justify-between gap-4 min-[851px]:flex-row min-[851px]:items-end [&_h2]:text-[23px] [&_h2]:leading-tight [&_h2]:font-semibold [&_h2]:tracking-tight [&_p]:mt-1 [&_p]:text-[13px] [&_p]:text-muted-foreground">
        <div>
          <h2>{t("Resultados no CRM")}</h2>
          <p>{t("Negócios criados a partir de anúncios do Google.")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 [&_label]:grid [&_label]:gap-1 [&_label>span:first-child]:text-[11px] [&_label>span:first-child]:font-semibold [&_label>span:first-child]:text-muted-foreground">
          <label>
            <span>{t("Conta de anúncios")}</span>
            <span className="relative flex min-h-9 items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-muted-foreground [&_svg]:pointer-events-none [&_svg]:absolute [&_svg:last-child]:right-2.5">
              <Buildings size={17} aria-hidden />
              <select
                className="-mx-2.5 max-w-[17em] cursor-pointer appearance-none border-0 bg-transparent py-2 pr-6 pl-8 text-[13px] text-text"
                value={conta}
                onChange={(e) => {
                  setConta(e.target.value);
                  voltarAoInicio();
                }}
                aria-label={t("Conta de anúncios")}
              >
                <option value="">{t("Todas as contas")}</option>
                {contas.map((c) => (
                  <option key={c} value={c}>
                    {nomeConta(c)}
                  </option>
                ))}
              </select>
              <CaretDown size={12} aria-hidden />
            </span>
          </label>
          <label>
            <span>{t("Período de criação")}</span>
            <span className="relative flex min-h-9 items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-muted-foreground [&_svg]:pointer-events-none [&_svg]:absolute [&_svg:last-child]:right-2.5">
              <CalendarBlank size={17} aria-hidden />
              <select
                className="-mx-2.5 max-w-[17em] cursor-pointer appearance-none border-0 bg-transparent py-2 pr-6 pl-8 text-[13px] text-text"
                value={dias}
                onChange={(e) => {
                  setDias(Number(e.target.value));
                  voltarAoInicio();
                }}
                aria-label={t("Período de criação")}
              >
                {[7, 30, 90].map((n) => (
                  <option key={n} value={n}>
                    {t("Últimos {n} dias").replace("{n}", String(n))}
                  </option>
                ))}
              </select>
              <CaretDown size={12} aria-hidden />
            </span>
          </label>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
        {[
          {
            nome: t("Negócios atribuídos"),
            valor: total.negocios,
            nota: t("Criados no período"),
            Icone: Kanban,
          },
          {
            nome: t("Negócios ganhos"),
            valor: total.ganhos,
            nota: t("Marcados como ganhos"),
            Icone: CheckCircle,
          },
          {
            nome: t("Taxa de ganho"),
            valor: taxa(total, porcentagem),
            nota: t("Ganhos ÷ atribuídos"),
            Icone: Gauge,
          },
          {
            nome: t("Valor ganho"),
            valor: dinheiro(total, locale, t),
            nota: t("Valor dos ganhos no CRM"),
            Icone: ChartBar,
          },
        ].map(({ nome, valor, nota, Icone }) => (
          <div
            className="min-w-0 rounded-xl border border-border bg-surface p-[13px] first:border-accent/30 first:bg-accent-soft sm:px-[18px] sm:pt-[15px] sm:pb-[14px] [&_small]:text-xs [&_small]:text-muted-foreground [&_strong]:mt-2 [&_strong]:mb-1 [&_strong]:block [&_strong]:text-[clamp(21px,2.4vw,32px)] [&_strong]:leading-tight [&_strong]:font-semibold [&_strong]:tracking-tight [&_strong]:wrap-anywhere [&_svg]:shrink-0 [&_svg]:text-accent [&>div]:flex [&>div]:items-center [&>div]:justify-between [&>div]:gap-2 [&>div]:text-[13px] [&>div]:font-semibold"
            key={nome}
          >
            <div>
              <span>{nome}</span>
              <Icone size={19} aria-hidden />
            </div>
            <strong>{typeof valor === "number" ? numero.format(valor) : valor}</strong>
            <small>{nota}</small>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2.5 min-[851px]:grid-cols-[minmax(0,1.55fr)_minmax(270px,1fr)] sm:grid-cols-[minmax(0,1.2fr)_minmax(235px,1fr)] sm:gap-3">
        <section className="min-w-0 rounded-xl border border-border bg-surface p-[13px] sm:px-5 sm:py-[18px] [&_h2]:text-base [&_h2]:leading-snug [&_h2]:font-semibold [&_h2]:tracking-tight">
          <div className="flex items-center justify-between gap-4 [&_p]:mt-1 [&_p]:text-[13px] [&_p]:text-muted-foreground [&>svg]:text-accent">
            <div>
              <h2>{t("Campanhas com mais negócios")}</h2>
              <p>{t("Até quatro campanhas, por volume de negócios atribuídos.")}</p>
            </div>
            <ChartBar size={21} aria-hidden />
          </div>
          {campanhas.length ? (
            <ol className="mt-4 grid list-none gap-[11px] p-0 [&_li]:min-w-0">
              {campanhas.slice(0, 4).map((c) => (
                <li key={c.chave}>
                  <div className="flex items-center justify-between gap-1.5 text-[13px] [&_b]:font-semibold [&_b]:wrap-anywhere [&_small]:text-[11px] [&_small]:text-muted-foreground [&_strong]:font-semibold [&_strong]:wrap-anywhere [&>div]:flex [&>div]:flex-wrap [&>div]:items-baseline [&>div]:gap-2 [&>div]:leading-tight">
                    <div>
                      <b>{c.titulo}</b>
                      <small>{nomeConta(c.linha.conta)}</small>
                    </div>
                    <strong>{numero.format(c.totais.negocios)}</strong>
                  </div>
                  <div
                    className="mt-1 h-1.5 overflow-hidden rounded-sm bg-surface-elevated [&>span]:block [&>span]:h-full [&>span]:bg-accent"
                    aria-hidden
                  >
                    <span
                      style={{
                        width: `${(100 * c.totais.negocios) / campanhas[0]!.totais.negocios}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="px-3.5 py-6 text-center text-muted-foreground">
              {t("Nenhuma campanha com negócios neste período.")}
            </p>
          )}
        </section>
        <section className="min-w-0 rounded-xl border border-border bg-surface p-[13px] sm:px-5 sm:py-[18px] [&_h2]:text-base [&_h2]:leading-snug [&_h2]:font-semibold [&_h2]:tracking-tight">
          <div className="flex items-center justify-between gap-4 [&_p]:mt-1 [&_p]:text-[13px] [&_p]:text-muted-foreground [&>svg]:text-accent">
            <div>
              <h2>{t("Situação dos negócios")}</h2>
              <p>{t("Resultado atual dos negócios criados no período.")}</p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-start gap-3 min-[851px]:gap-[clamp(12px,2.2vw,28px)] sm:mt-6 sm:mb-2 sm:justify-center [&_i]:size-[9px] [&_i]:shrink-0 [&_i]:rounded-sm [&_li]:flex [&_li]:items-center [&_li]:gap-2 [&_li]:text-[13px] [&_li]:whitespace-nowrap [&_li_b]:ml-auto [&_ul]:grid [&_ul]:max-w-[190px] [&_ul]:flex-1 [&_ul]:list-none [&_ul]:gap-2.5 [&_ul]:p-0">
            <div
              className="grid aspect-square w-[clamp(83px,8vw,116px)] shrink-0 place-items-center rounded-full [&_b]:text-2xl [&_b]:leading-none [&_b]:tracking-tight [&_span]:mt-0.5 [&_span]:text-[10px] [&_span]:text-muted-foreground [&>div]:flex [&>div]:aspect-square [&>div]:w-[74%] [&>div]:flex-col [&>div]:items-center [&>div]:justify-center [&>div]:rounded-full [&>div]:bg-surface"
              aria-hidden
              style={{
                background: total.negocios
                  ? `conic-gradient(var(--color-success) 0 ${(100 * total.ganhos) / total.negocios}%, var(--color-info) 0 ${(100 * (total.ganhos + emAberto)) / total.negocios}%, var(--color-border-strong) 0)`
                  : "var(--color-surface-elevated)",
              }}
            >
              <div>
                <b>{numero.format(total.negocios)}</b>
                <span>{t("negócios")}</span>
              </div>
            </div>
            <ul>
              {situacoes.map((s) => (
                <li key={s.nome}>
                  <i className={s.classe} />
                  <span>{s.nome}</span>
                  <b>{numero.format(s.valor)}</b>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
      <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface [&_h2]:text-base [&_h2]:leading-snug [&_h2]:font-semibold [&_h2]:tracking-tight">
        <div className="flex flex-col items-start justify-between gap-2.5 p-3.5 sm:flex-row sm:items-center sm:gap-4 sm:px-5 sm:pt-[18px] sm:pb-3.5 [&_p]:mt-1 [&_p]:text-[13px] [&_p]:text-muted-foreground">
          <div>
            <h2>{t("Origem dos negócios")}</h2>
            <p>{t("Abra uma linha para conferir de onde vieram os resultados.")}</p>
          </div>
          <label className="relative flex min-h-[33px] items-center gap-2 rounded-md border border-border-strong bg-surface px-2.5 text-muted-foreground [&_input]:w-[145px] [&_input]:min-w-0 [&_input]:border-0 [&_input]:bg-transparent [&_input]:py-1 [&_input]:text-[13px] [&_input]:text-text [&_input::placeholder]:text-muted-foreground">
            <MagnifyingGlass size={16} aria-hidden />
            <input
              aria-label={t("Buscar na tabela")}
              placeholder={t("Buscar na tabela")}
              type="search"
              value={busca}
              onChange={(e) => {
                setBusca(e.target.value);
                voltarAoInicio();
              }}
            />
          </label>
        </div>
        <div
          className="flex gap-3 overflow-x-auto border-b border-border px-3.5 sm:gap-4 sm:px-5"
          role="group"
          aria-label={t("Agrupar resultados por")}
        >
          {dimensoes.map((d) => (
            <button
              key={d}
              type="button"
              className="border-b-2 border-transparent bg-transparent pt-2 pb-2.5 text-[13px] whitespace-nowrap text-muted-foreground hover:text-accent aria-pressed:border-accent aria-pressed:font-semibold aria-pressed:text-accent"
              aria-pressed={d === nivel}
              onClick={() => {
                setNivel(d);
                setBusca("");
                voltarAoInicio();
              }}
            >
              {t(niveis[d].plural)}
            </button>
          ))}
        </div>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full border-collapse text-[13px] max-sm:min-w-[550px] [&_td]:align-middle [&_td:not([colspan])]:px-4 [&_td:not([colspan])]:py-2.5 [&_td:not([colspan])]:text-right [&_th]:px-4 [&_th]:py-2.5 [&_th]:align-middle [&_th:first-child]:text-left [&_tr:not(:last-child)>*]:border-b [&_tr:not(:last-child)>*]:border-border [&_tr>*:last-child]:pr-5">
            <thead className="bg-surface-elevated text-muted-foreground [&_th]:text-right [&_th]:text-[11px] [&_th]:font-semibold [&_th]:whitespace-nowrap [&_th:first-child]:pl-[22px]">
              <tr>
                <th scope="col">{t(niveis[nivel].singular)}</th>
                <th scope="col">{t("Negócios")}</th>
                <th scope="col">{t("Ganhos")}</th>
                <th scope="col">{t("Taxa de ganho")}</th>
                <th scope="col">{t("Valor ganho")}</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.slice((pagina - 1) * porPagina, pagina * porPagina).map((g) => {
                const expandida = aberto === g.chave;
                const contexto = [nomeConta(g.linha.conta)];
                if (nivel !== "campanha") contexto.push(tituloDoNivel(g.linha, "campanha", t));
                if (nivel === "anuncio" || nivel === "palavraChave")
                  contexto.push(tituloDoNivel(g.linha, "grupo", t));
                const id = identificador(g.linha, nivel);
                return (
                  <Fragment key={g.chave}>
                    <tr className={expandida ? "bg-accent-soft" : undefined}>
                      <th scope="row">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 border-0 bg-transparent p-0 text-left text-[13px] hover:text-accent [&_b]:block [&_b]:font-semibold [&_b]:wrap-anywhere [&_small]:mt-0.5 [&_small]:block [&_small]:text-[11px] [&_small]:font-normal [&_small]:wrap-anywhere [&_small]:text-muted-foreground [&_svg]:shrink-0 [&_svg]:text-accent"
                          aria-expanded={expandida}
                          onClick={() => setAberto(expandida ? null : g.chave)}
                        >
                          {expandida ? (
                            <CaretDown size={14} aria-hidden />
                          ) : (
                            <CaretRight size={14} aria-hidden />
                          )}
                          <span>
                            <b>{g.titulo}</b>
                            <small>
                              {contexto.join(" · ")}
                              {id && g.linha[nivel] ? ` · ID ${id}` : ""}
                            </small>
                          </span>
                        </button>
                      </th>
                      <td>{numero.format(g.totais.negocios)}</td>
                      <td>{numero.format(g.totais.ganhos)}</td>
                      <td>{taxa(g.totais, porcentagem)}</td>
                      <td>{dinheiro(g.totais, locale, t)}</td>
                    </tr>
                    {expandida && (
                      <tr>
                        <td
                          colSpan={5}
                          className="bg-accent-soft px-5 pt-3 pb-4 pl-[38px] text-left [&_dd]:font-semibold [&_dl]:flex [&_dl]:flex-wrap [&_dl]:gap-[22px] [&_dt]:text-xs [&_dt]:text-muted-foreground"
                        >
                          <dl>
                            <div>
                              <dt>{t("Conta Google Ads")}</dt>
                              <dd>
                                {nomeConta(g.linha.conta)}
                                {g.linha.conta && nomesDasContas?.[g.linha.conta]
                                  ? ` · ${g.linha.conta}`
                                  : ""}
                              </dd>
                            </div>
                            <div>
                              <dt>
                                {nivel === "palavraChave"
                                  ? t("Palavra-chave recebida no link")
                                  : t("Identificador no link")}
                              </dt>
                              <dd>
                                {nivel === "palavraChave"
                                  ? g.linha.palavraChave || t("Não informado")
                                  : (id ?? t("Não informado"))}
                              </dd>
                            </div>
                            <div>
                              <dt>{t("Situação no CRM")}</dt>
                              <dd>
                                {numero.format(g.totais.ganhos)} {t("ganhos")} ·{" "}
                                {numero.format(
                                  g.totais.negocios - g.totais.ganhos - g.totais.perdidos,
                                )}{" "}
                                {t("em aberto")} · {numero.format(g.totais.perdidos)}{" "}
                                {t("perdidos")}
                              </dd>
                            </div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!visiveis.length && (
                <tr>
                  <td colSpan={5} className="px-3.5 py-6 text-center text-muted-foreground">
                    {busca
                      ? t("Nenhum resultado para esta busca.")
                      : t("Nenhum negócio atribuído ao Google Ads nesta conta e período.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-5 py-2.5 text-[11px] text-muted-foreground [&_button]:rounded-md [&_button]:border [&_button]:border-border [&_button]:bg-surface [&_button]:px-2 [&_button]:py-1 [&_button]:text-text [&_button:disabled]:cursor-default [&_button:disabled]:opacity-45 [&>div]:flex [&>div]:items-center [&>div]:gap-2.5">
          <span>
            {periodo} · {visiveis.length} {visiveis.length === 1 ? t("resultado") : t("resultados")}
          </span>
          {paginas > 1 && (
            <div>
              <button
                type="button"
                disabled={pagina === 1}
                onClick={() => {
                  setPagina(pagina - 1);
                  setAberto(null);
                }}
              >
                {t("Anterior")}
              </button>
              <span>
                {t("{atual} de {total}")
                  .replace("{atual}", numero.format(pagina))
                  .replace("{total}", numero.format(paginas))}
              </span>
              <button
                type="button"
                disabled={pagina >= paginas}
                onClick={() => {
                  setPagina(pagina + 1);
                  setAberto(null);
                }}
              >
                {t("Próxima")}
              </button>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

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
import styles from "./PainelGoogleAds.module.css";

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

function agrupar(linhas: LinhaPainelGoogle[], nivel: Dimensao, locale: string, t: (texto: string) => string) {
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
  const dataCurta = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
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
  const campanhas = useMemo(() => agrupar(filtradas, "campanha", locale, t), [filtradas, locale, t]);
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
    { nome: t("Ganhos"), valor: total.ganhos, classe: styles.ganho },
    { nome: t("Em aberto"), valor: emAberto, classe: styles.aberto },
    { nome: t("Perdidos"), valor: total.perdidos, classe: styles.perdido },
  ];
  function voltarAoInicio() {
    setPagina(1);
    setAberto(null);
  }
  const periodo = dataCurta.formatRange(
    new Date(inicio + "T00:00:00Z"),
    new Date(hoje + "T00:00:00Z"),
  );

  return (
    <section className={styles.painel} data-superficie="clara" aria-label={t("Resultados no CRM")}>
      <header className={styles.topo}>
        <div>
          <h2>{t("Resultados no CRM")}</h2>
          <p>{t("Negócios criados a partir de anúncios do Google.")}</p>
        </div>
        <div className={styles.filtros}>
          <label>
            <span>{t("Conta de anúncios")}</span>
            <span className={styles.select}>
              <Buildings size={17} aria-hidden />
              <select
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
            <span className={styles.select}>
              <CalendarBlank size={17} aria-hidden />
              <select
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
      <div className={styles.metricas}>
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
          { nome: t("Taxa de ganho"), valor: taxa(total, porcentagem), nota: t("Ganhos ÷ atribuídos"), Icone: Gauge },
          {
            nome: t("Valor ganho"),
            valor: dinheiro(total, locale, t),
            nota: t("Valor dos ganhos no CRM"),
            Icone: ChartBar,
          },
        ].map(({ nome, valor, nota, Icone }) => (
          <div className={styles.metrica} key={nome}>
            <div>
              <span>{nome}</span>
              <Icone size={19} aria-hidden />
            </div>
            <strong>{typeof valor === "number" ? numero.format(valor) : valor}</strong>
            <small>{nota}</small>
          </div>
        ))}
      </div>
      <div className={styles.resumo}>
        <section className={styles.card}>
          <div className={styles.cardCabecalho}>
            <div>
              <h2>{t("Campanhas com mais negócios")}</h2>
              <p>{t("Até quatro campanhas, por volume de negócios atribuídos.")}</p>
            </div>
            <ChartBar size={21} aria-hidden />
          </div>
          {campanhas.length ? (
            <ol className={styles.ranking}>
              {campanhas.slice(0, 4).map((c) => (
                <li key={c.chave}>
                  <div className={styles.tituloBarra}>
                    <div>
                      <b>{c.titulo}</b>
                      <small>{nomeConta(c.linha.conta)}</small>
                    </div>
                    <strong>{numero.format(c.totais.negocios)}</strong>
                  </div>
                  <div className={styles.trilho} aria-hidden>
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
            <p className={styles.vazio}>{t("Nenhuma campanha com negócios neste período.")}</p>
          )}
        </section>
        <section className={styles.card}>
          <div className={styles.cardCabecalho}>
            <div>
              <h2>{t("Situação dos negócios")}</h2>
              <p>{t("Resultado atual dos negócios criados no período.")}</p>
            </div>
          </div>
          <div className={styles.funil}>
            <div
              className={styles.disco}
              aria-hidden
              style={{
                background: total.negocios
                  ? `conic-gradient(var(--ads-teal) 0 ${(100 * total.ganhos) / total.negocios}%, var(--ads-blue) 0 ${(100 * (total.ganhos + emAberto)) / total.negocios}%, var(--ads-gray) 0)`
                  : "var(--ads-fundo)",
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
      <section className={styles.tabelaCard}>
        <div className={styles.tabelaCabecalho}>
          <div>
            <h2>{t("Origem dos negócios")}</h2>
            <p>{t("Abra uma linha para conferir de onde vieram os resultados.")}</p>
          </div>
          <label className={styles.busca}>
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
        <div className={styles.abas} role="group" aria-label={t("Agrupar resultados por")}>
          {dimensoes.map((d) => (
            <button
              key={d}
              type="button"
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
        <div className={styles.rolagem}>
          <table>
            <thead>
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
                    <tr className={expandida ? styles.ativa : undefined}>
                      <th scope="row">
                        <button
                          type="button"
                          className={styles.expandir}
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
                        <td colSpan={5} className={styles.detalhe}>
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
                                {numero.format(g.totais.negocios - g.totais.ganhos - g.totais.perdidos)} {t("em aberto")} ·{" "}
                                {numero.format(g.totais.perdidos)} {t("perdidos")}
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
                  <td colSpan={5} className={styles.vazio}>
                    {busca
                      ? t("Nenhum resultado para esta busca.")
                      : t("Nenhum negócio atribuído ao Google Ads nesta conta e período.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className={styles.rodape}>
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
                {t("{atual} de {total}").replace("{atual}", numero.format(pagina)).replace("{total}", numero.format(paginas))}
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

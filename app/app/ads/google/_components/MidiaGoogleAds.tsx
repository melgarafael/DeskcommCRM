"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CampanhaGoogle } from "@/lib/plataformas-de-anuncio/google/api-google-ads";
import type { LinhaPainelGoogle } from "@/lib/plataformas-de-anuncio/google/painel";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import styles from "./MidiaGoogleAds.module.css";

export type ResumoMidiaGoogle =
  | { ok: true; contaId: string; campanhas: CampanhaGoogle[] }
  | { ok: false; detalhe: string; abrirConfiguracoes?: boolean };

type Periodo = { de: string; ate: string };
type Props = {
  hoje: string;
  carregar: (periodo: Periodo) => Promise<ResumoMidiaGoogle>;
  atribuicao?: { linhas: LinhaPainelGoogle[]; fuso: string };
};

const statusCampanha: Record<string, string> = { ENABLED: "Ativa", PAUSED: "Pausada" };

function moedaFormatada(locale: string, valor: number, moeda?: string) {
  return moeda
    ? new Intl.NumberFormat(locale, { style: "currency", currency: moeda }).format(valor)
    : "—";
}

function ganhosDasCampanhas(atribuicao: Props["atribuicao"], contaId: string | undefined, fuso: string | undefined, de: string, ate: string) {
  const ganhos = new Map<string, number>();
  if (!atribuicao || !contaId || !fuso || fuso !== atribuicao.fuso) return ganhos;
  for (const linha of atribuicao.linhas) {
    if (linha.conta === contaId && linha.campanhaId && linha.dia >= de && linha.dia <= ate) {
      ganhos.set(linha.campanhaId, (ganhos.get(linha.campanhaId) ?? 0) + linha.ganhos);
    }
  }
  return ganhos;
}

export function MidiaGoogleAds({ hoje, carregar, atribuicao }: Props) {
  const t = useT();
  const locale = useTagDeIdioma();
  const numero = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const data = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" });
  const [dias, setDias] = useState(30);
  const [revisao, setRevisao] = useState(0);
  const [retorno, setRetorno] = useState<{ chave: string; dados: ResumoMidiaGoogle } | null>(null);
  const inicio = new Date(hoje + "T12:00:00Z");
  inicio.setUTCDate(inicio.getUTCDate() - dias + 1);
  const de = inicio.toISOString().slice(0, 10);
  const chave = [de, hoje, revisao].join("/");
  const resultado = retorno?.chave === chave ? retorno.dados : undefined;

  useEffect(() => {
    let vigente = true;
    async function ler() {
      let dados: ResumoMidiaGoogle;
      try {
        dados = await carregar({ de, ate: hoje });
      } catch {
        dados = { ok: false, detalhe: "A consulta ao Google Ads falhou. Tente atualizar em instantes." };
      }
      if (vigente) setRetorno({ chave, dados });
    }
    void ler();
    return () => { vigente = false; };
  }, [carregar, de, hoje, chave]);

  const campanhas = resultado?.ok ? resultado.campanhas : [];
  const totais = campanhas.reduce(
    (acc, c) => ({
      custo: acc.custo + c.custo, cliques: acc.cliques + c.cliques,
      impressoes: acc.impressoes + c.impressoes, conversoes: acc.conversoes + c.conversoes,
    }),
    { custo: 0, cliques: 0, impressoes: 0, conversoes: 0 },
  );
  const moeda = campanhas[0]?.moeda;
  const fuso = campanhas[0]?.fuso;
  const contaId = resultado?.ok ? resultado.contaId : undefined;
  const ganhosPorCampanha = ganhosDasCampanhas(atribuicao, contaId, fuso, de, hoje);

  return (
    <section className={styles.painel} aria-label={t("Desempenho das campanhas no Google")}>
      <div className={styles.cabecalho}>
        <div>
          <h2>{t("Desempenho das campanhas")}</h2>
          <p>{t("Investimento e resultados informados pelo Google para a conta conectada.")}</p>
        </div>
        <div className={styles.controles}>
          <label>
            <span>{t("Período")}</span>
            <select value={dias} onChange={(e) => setDias(Number(e.target.value))}>
              {[7, 30, 90].map((d) => <option value={d} key={d}>{t("Últimos {n} dias").replace("{n}", String(d))}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => setRevisao((r) => r + 1)} disabled={!resultado}>{t("Atualizar")}</button>
        </div>
      </div>
      {!resultado && <p className={styles.aviso} role="status">{t("Consultando a conta do Google Ads…")}</p>}
      {resultado && !resultado.ok && <p className={styles.aviso} role="alert">
        {t(resultado.detalhe)}
        {resultado.abrirConfiguracoes === true && <> <Link href="/app/settings/conversoes">{t("Abrir configurações de conversões")}</Link></>}
        {resultado.abrirConfiguracoes === false && <> {t("Peça a um administrador da organização que revise a conexão do Google Ads em Configurações → Conversões.")}</>}
      </p>}
      {resultado?.ok && <>
        <div className={styles.contexto}>
          <strong>{t("Conta")} {resultado.contaId.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3")}</strong>
          <span>{data.formatRange(new Date(de + "T00:00:00Z"), new Date(hoje + "T00:00:00Z"))}</span>
          {fuso && <span>{t("Fuso da conta")} · {fuso}</span>}
        </div>
        {campanhas.length === 0 ? (
          <p className={styles.aviso}>{t("O Google não retornou campanhas para esta conta no período selecionado.")}</p>
        ) : <>
          <dl className={styles.indicadores}>
            {[
              [t("Investimento"), moedaFormatada(locale, totais.custo, moeda)],
              [t("Impressões"), numero.format(totais.impressoes)],
              [t("Cliques"), numero.format(totais.cliques)],
              [t("Conversões do Google"), numero.format(totais.conversoes)],
            ].map(([rotulo, valor]) => (
              <div key={rotulo}><dt>{rotulo}</dt><dd>{valor}</dd></div>
            ))}
          </dl>
          <div className={styles.quadro}>
            <div className={styles.tituloTabela}>
              <h3>{t("Campanhas por investimento")}</h3>
              <span>{campanhas.length} {campanhas.length === 1 ? t("campanha") : t("campanhas")}</span>
            </div>
            <div className={styles.rolagem} tabIndex={0} role="region" aria-label={t("Tabela de campanhas do Google")}>
              <table>
                <thead><tr>
                  <th scope="col">{t("Campanha")}</th><th scope="col">{t("Investimento")}</th><th scope="col">{t("Ganhos no CRM")}</th>
                  <th scope="col">{t("Custo por ganho")}</th><th scope="col">{t("Cliques")}</th><th scope="col">{t("Impressões")}</th>
                  <th scope="col">{t("Custo por clique")}</th><th scope="col">{t("Conversões do Google")}</th>
                </tr></thead>
                <tbody>
                  {campanhas.map((c) => {
                    const ganhos = c.fuso === fuso ? ganhosPorCampanha.get(c.id) : undefined;
                    return (
                    <tr key={c.id}>
                      <th scope="row"><strong>{c.nome || c.id}</strong><small>{t(statusCampanha[c.status] ?? c.status)} · ID {c.id}</small></th>
                      <td>{moedaFormatada(locale, c.custo, c.moeda)}</td>
                      <td>{ganhos === undefined ? "—" : numero.format(ganhos)}</td>
                      <td>{ganhos ? moedaFormatada(locale, c.custo / ganhos, c.moeda) : "—"}</td>
                      <td>{numero.format(c.cliques)}</td><td>{numero.format(c.impressoes)}</td>
                      <td>{c.cliques > 0 ? moedaFormatada(locale, c.custo / c.cliques, c.moeda) : "—"}</td>
                      <td>{numero.format(c.conversoes)}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <p className={styles.nota}>{t("O custo por ganho divide o investimento pelos negócios criados no período e hoje marcados como ganhos no CRM. A comparação exige os mesmos IDs de conta e campanha e o mesmo fuso. O traço indica que faltam dados para calcular.")}</p>
          <p className={styles.nota}>{t("As conversões seguem as ações configuradas nesta conta do Google Ads. Os totais somam as campanhas exibidas, excluindo as removidas.")}{campanhas.length === 200 ? " " + t("O relatório atingiu o limite das 200 campanhas de maior investimento.") : ""}{!moeda ? " " + t("O Google não informou a moeda da conta.") : ""}</p>
        </>}
      </>}
    </section>
  );
}

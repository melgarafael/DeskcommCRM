/**
 * Aba "Histórico de envios" de Configurações › Conversões (0436).
 *
 * Server Component: os filtros são um formulário GET — a URL é o estado, dá
 * para voltar, recarregar e mandar o link para quem vai conferir. Cada linha
 * abre (`<details>`) com o que se procura no gerenciador da plataforma: o ID
 * do evento (o mesmo em todas as tentativas), o protocolo e a ação.
 */
import { formatCentsBRL } from "@/lib/money";
import {
  PERIODOS,
  rotuloDoEvento,
  situacaoDaLinha,
  TAMANHO_DA_PAGINA,
  type FiltrosDoHistorico,
  type LinhaDoHistorico,
  type Situacao,
} from "@/lib/conversoes/historico";
import { MOTIVO_LEGIVEL } from "@/lib/conversoes/estado-da-conexao";
import type { RegraDeConversaoGoogle } from "@/lib/conversoes/regras-google";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { ReprocessarConversao } from "./_reprocessar";

const ROTULO_DO_PERIODO: Record<(typeof PERIODOS)[number], string> = {
  hoje: "Hoje",
  "24h": "Últimas 24h",
  "7d": "7 dias",
  "30d": "30 dias",
  tudo: "Todo o período",
};

const ROTULO_DA_SITUACAO: Record<Situacao, string> = {
  todas: "Todos os status",
  entregue: "Entregues",
  falha: "Falhas",
  aguardando: "Aguardando",
  nao_enviado: "Não enviados",
};

const ESTILO_DA_SITUACAO: Record<Exclude<Situacao, "todas">, string> = {
  entregue: "border-emerald-500/40 bg-emerald-500/10",
  falha: "border-destructive/40 bg-destructive/10",
  aguardando: "border-sky-500/40 bg-sky-500/10",
  nao_enviado: "border-amber-500/40 bg-amber-500/10",
};

const ROTULO_CURTO: Record<Exclude<Situacao, "todas">, string> = {
  entregue: "Entregue",
  falha: "Falhou",
  aguardando: "Aguardando",
  nao_enviado: "Não enviado",
};

export function HistoricoDeEnvios({
  linhas,
  total,
  filtros,
  regras,
  idioma,
}: {
  linhas: LinhaDoHistorico[];
  total: number;
  filtros: FiltrosDoHistorico;
  /** O nome de cada evento de etapa (Google e Meta), para o filtro e a tabela. */
  regras: Pick<RegraDeConversaoGoogle, "eventName" | "label">[];
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const paginas = Math.max(1, Math.ceil(total / TAMANHO_DA_PAGINA));
  const eventos = [
    { valor: "Purchase", rotulo: "Compra" },
    ...regras.map((r) => ({ valor: r.eventName, rotulo: r.label })),
  ];
  const link = (pagina: number) => {
    const p = new URLSearchParams({
      aba: "historico",
      periodo: filtros.periodo,
      situacao: filtros.situacao,
      ...(filtros.evento ? { evento: filtros.evento } : {}),
      ...(filtros.plataforma ? { plataforma: filtros.plataforma } : {}),
      ...(filtros.busca ? { busca: filtros.busca } : {}),
      pagina: String(pagina),
    });
    return `?${p.toString()}`;
  };

  return (
    <section className="flex flex-col gap-4" data-testid="historico-de-envios">
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-4">
        <input type="hidden" name="aba" value="historico" />
        <label className="flex flex-col gap-1 text-xs">
          {t("Período")}
          <select
            name="periodo"
            defaultValue={filtros.periodo}
            className="rounded-md border bg-background p-2 text-sm"
          >
            {PERIODOS.map((p) => (
              <option key={p} value={p}>
                {t(ROTULO_DO_PERIODO[p])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("Status")}
          <select
            name="situacao"
            defaultValue={filtros.situacao}
            className="rounded-md border bg-background p-2 text-sm"
          >
            {(Object.keys(ROTULO_DA_SITUACAO) as Situacao[]).map((s) => (
              <option key={s} value={s}>
                {t(ROTULO_DA_SITUACAO[s])}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("Evento")}
          <select
            name="evento"
            defaultValue={filtros.evento}
            className="rounded-md border bg-background p-2 text-sm"
          >
            <option value="">{t("Todos os eventos")}</option>
            {eventos.map((e) => (
              <option key={e.valor} value={e.valor}>
                {t(e.rotulo)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          {t("Plataforma")}
          <select
            name="plataforma"
            defaultValue={filtros.plataforma}
            className="rounded-md border bg-background p-2 text-sm"
          >
            <option value="">{t("Todas")}</option>
            <option value="google_ads">Google Ads</option>
            <option value="meta_ads">Meta Ads</option>
          </select>
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
          {t("Buscar por negócio")}
          <input
            name="busca"
            defaultValue={filtros.busca}
            placeholder={t("Nome do negócio")}
            className="rounded-md border bg-background p-2 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          {t("Filtrar")}
        </button>
      </form>

      <p className="text-sm text-muted-foreground" data-testid="historico-total">
        {total} {t(total === 1 ? "envio" : "envios")}
      </p>

      {linhas.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          {t("Nenhum envio com estes filtros.")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {linhas.map((l) => {
            const situacao = situacaoDaLinha(l.status, l.motivo) as Exclude<Situacao, "todas">;
            return (
              <li key={l.id}>
                <details className="group">
                  <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 p-3 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {t(rotuloDoEvento(l.evento, regras))}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {l.plataforma === "google_ads"
                            ? "Google Ads"
                            : l.plataforma === "meta_ads"
                              ? "Meta Ads"
                              : l.plataforma}
                        </span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {l.tituloDoLead ?? t("(sem título)")} ·{" "}
                        {new Date(l.tentadoEm).toLocaleString(idioma)}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${ESTILO_DA_SITUACAO[situacao]}`}
                    >
                      {t(ROTULO_CURTO[situacao])}
                    </span>
                  </summary>
                  <div className="flex flex-col gap-2 border-t bg-muted/30 p-3 text-xs">
                    {l.motivo && <p>{t(MOTIVO_LEGIVEL[l.motivo] ?? l.motivo)}</p>}
                    {l.detalhe && <p className="text-muted-foreground">{l.detalhe}</p>}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <dt className="text-muted-foreground">{t("ID do evento")}</dt>
                      <dd className="font-mono break-all">{l.eventoId ?? "—"}</dd>
                      {l.protocolo && (
                        <>
                          <dt className="text-muted-foreground">{t("Protocolo")}</dt>
                          <dd className="font-mono break-all">{l.protocolo}</dd>
                        </>
                      )}
                      {l.acaoGoogle && (
                        <>
                          <dt className="text-muted-foreground">{t("Ação de conversão")}</dt>
                          <dd className="font-mono">{l.acaoGoogle}</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">{t("Valor")}</dt>
                      <dd>
                        {l.valorCentavos === null
                          ? t("sem valor")
                          : formatCentsBRL(l.valorCentavos)}
                      </dd>
                      {l.ocorridoEm && (
                        <>
                          <dt className="text-muted-foreground">{t("Aconteceu em")}</dt>
                          <dd>{new Date(l.ocorridoEm).toLocaleString(idioma)}</dd>
                        </>
                      )}
                    </dl>
                    <div className="flex flex-wrap gap-2">
                      <a
                        className="underline underline-offset-2"
                        href={`/app/kanban?lead=${l.leadId}`}
                      >
                        {t("Abrir negócio")}
                      </a>
                      {situacao !== "entregue" && (
                        <ReprocessarConversao leadId={l.leadId} idioma={idioma} evento={l.evento} />
                      )}
                    </div>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}

      {paginas > 1 && (
        <nav className="flex items-center justify-between text-sm">
          {filtros.pagina > 1 ? <a href={link(filtros.pagina - 1)}>{t("Anterior")}</a> : <span />}
          <span className="text-muted-foreground">
            {t("Página")} {filtros.pagina} {t("de")} {paginas}
          </span>
          {filtros.pagina < paginas ? (
            <a href={link(filtros.pagina + 1)}>{t("Próxima")}</a>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  );
}

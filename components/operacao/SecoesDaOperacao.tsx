"use client";
/**
 * As seções da Operação do dia — o MESMO desenho na tela ao vivo (`/app/operacao`)
 * e no relatório congelado (`/app/operacao/relatorios/[dia]`).
 *
 * Só apresenta: recebe o `OperacaoDoDia` e o instante contra o qual a espera é
 * medida (agora, na tela ao vivo; a hora da geração, no relatório). Campo vazio
 * diz "não registrado" — nunca some, nunca vira zero.
 */
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { kindLabel } from "@/lib/ai/agent-inbox-copy";
import { rotuloDoEstadoDoCanal } from "@/lib/channels/estado";
import { ROTULO_DO_COMANDO } from "@/lib/inbox/comando-da-conversa";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";
import { corteDoDia, duracaoCurta, horaCurtaNoFuso, minutosDeEspera } from "@/lib/operacao/regras";
import { nomeDaRede, valorFormatado } from "@/lib/operacao/texto-do-relatorio";
import type {
  ContagemPorCanal,
  ContatoDaLinha,
  LinhaDeConversa,
  LinhaDeNegocio,
  OperacaoDoDia,
} from "@/lib/operacao/tipos";

const linkDaConversa = (id: string) => `/app/inbox?id=${encodeURIComponent(id)}`;

/**
 * Campo pessoal na tela: `undefined` é "a leitura ao vivo falhou" (`hidratar`),
 * `null` é "o banco respondeu e não há". Os dois NUNCA se confundem: uma falha
 * do banco não pode aparecer como contato apagado.
 */
function usePessoal() {
  const t = useT();
  return (v: string | null | undefined, vazio?: string) =>
    v === undefined ? t("não foi possível ler agora") : (v ?? vazio ?? t("não registrado"));
}

function Contato({ c }: { c: ContatoDaLinha }) {
  const t = useT();
  const pessoal = usePessoal();
  return (
    <div className="min-w-0">
      <div className="truncate font-medium">{pessoal(c.nome, t("Sem nome"))}</div>
      <div className="truncate text-xs text-text-muted">
        {c.nome === undefined
          ? t("não foi possível ler agora")
          : [c.telefone, c.identidade].filter(Boolean).join(" · ") || t("não registrado")}
      </div>
    </div>
  );
}

function Contador({ titulo, explicacao, c }: { titulo: string; explicacao: string; c: ContagemPorCanal }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-border bg-surface p-4" data-testid="operacao-contador">
      <div className="text-sm font-semibold">{titulo}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{c.total}</div>
      <div className="mt-1 text-xs text-text-muted">
        WhatsApp {c.whatsapp} · Instagram {c.instagram} · {t("outros")} {c.outros}
      </div>
      <p className="mt-2 text-xs text-text-muted">{explicacao}</p>
    </div>
  );
}

function Secao({ titulo, quantidade, children, id }: { titulo: string; quantidade: number; children: React.ReactNode; id: string }) {
  return (
    <section className="rounded-lg border border-border bg-surface" data-testid={`operacao-secao-${id}`}>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{titulo}</h2>
        <span className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs font-semibold text-text-muted">{quantidade}</span>
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function TabelaDeConversas({
  linhas,
  referencia,
  fuso,
  comProdutos = false,
}: {
  linhas: LinhaDeConversa[];
  referencia: Date;
  fuso: string;
  comProdutos?: boolean;
}) {
  const t = useT();
  const pessoal = usePessoal();
  const nr = t("não registrado");
  if (linhas.length === 0) return <p className="px-4 py-6 text-center text-sm text-text-muted">{t("Nada nesta seção.")}</p>;
  return (
    <table className="w-full min-w-[56rem] text-sm">
      <thead className="text-left text-xs text-text-muted">
        <tr className="border-b border-border">
          <th className="px-3 py-2 font-medium">{t("Contato")}</th>
          <th className="px-3 py-2 font-medium">{t("Canal")}</th>
          <th className="px-3 py-2 font-medium">{comProdutos ? t("Produtos") : t("Resumo")}</th>
          <th className="px-3 py-2 font-medium">{t("Situação")}</th>
          <th className="px-3 py-2 font-medium">{t("Próxima ação")}</th>
          <th className="px-3 py-2 font-medium">{t("Responsável")}</th>
          <th className="px-3 py-2 font-medium">{t("Última atividade")}</th>
          <th className="px-3 py-2 font-medium">{t("Esperando")}</th>
          <th className="px-3 py-2 font-medium" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {linhas.map((l) => {
          const espera = minutosDeEspera(l.esperando_desde, referencia);
          return (
            <tr key={l.conversation_id} className="align-top" data-testid="operacao-linha">
              <td className="max-w-[14rem] px-3 py-2">
                <Contato c={l.contato} />
              </td>
              <td className="px-3 py-2">
                <div>{nomeDaRede(l.canal)}</div>
                <div className="text-xs text-text-muted">{l.numero ?? nr}</div>
              </td>
              <td className="max-w-[22rem] px-3 py-2">
                {comProdutos && (
                  <div className="mb-1">
                    <div>
                      <span className="text-xs text-text-muted">{t("Produtos")}: </span>
                      {l.produtos && l.produtos.encontrados.length > 0 ? l.produtos.encontrados.join(", ") : nr}
                    </div>
                    {l.produtos?.termos !== undefined && (
                      <div className="text-xs text-text-muted">
                        {t("buscou")}:{" "}
                        {l.produtos.termos.length > 0 ? l.produtos.termos.map((x) => `"${x}"`).join(", ") : nr}
                      </div>
                    )}
                  </div>
                )}
                <p className="line-clamp-3 text-xs">
                  {l.resumo_origem === "passagem" && <span className="font-semibold">{t("Passagem")}: </span>}
                  {pessoal(l.resumo)}
                </p>
              </td>
              <td className="px-3 py-2 text-xs">
                {l.comando && l.comando in ROTULO_DO_COMANDO
                  ? t(ROTULO_DO_COMANDO[l.comando as keyof typeof ROTULO_DO_COMANDO])
                  : l.status}
                {l.motivo_codigo && <div className="text-text-muted">{l.motivo_codigo}</div>}
              </td>
              <td className="px-3 py-2 text-xs">
                {l.proxima_acao ? (
                  <>
                    <div>{pessoal(l.proxima_acao.titulo)}</div>
                    {l.proxima_acao.vence_em && (
                      <div className="text-text-muted">
                        {t("vence")} {l.proxima_acao.vence_em.slice(0, 10)}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-text-muted">{nr}</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs">
                {l.responsavel_tipo === "ia" ? t("IA") : pessoal(l.responsavel)}
              </td>
              <td className="px-3 py-2 text-xs tabular-nums">
                {l.ultima_atividade_em ? horaCurtaNoFuso(l.ultima_atividade_em, fuso) : nr}
              </td>
              <td className={`px-3 py-2 text-xs tabular-nums ${espera !== null && espera >= 30 ? "font-semibold text-red-500" : ""}`}>
                {espera !== null ? duracaoCurta(espera) : "—"}
              </td>
              <td className="px-3 py-2 text-xs">
                <Link href={linkDaConversa(l.conversation_id)} className="text-primary underline-offset-2 hover:underline">
                  {t("Abrir conversa")}
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TabelaDeNegocios({ linhas, perdidos = false }: { linhas: LinhaDeNegocio[]; perdidos?: boolean }) {
  const t = useT();
  const idioma = useIdioma();
  const pessoal = usePessoal();
  const nr = t("não registrado");
  if (linhas.length === 0) return <p className="px-4 py-6 text-center text-sm text-text-muted">{t("Nada nesta seção.")}</p>;
  return (
    <table className="w-full min-w-[48rem] text-sm">
      <thead className="text-left text-xs text-text-muted">
        <tr className="border-b border-border">
          <th className="px-3 py-2 font-medium">{t("Negócio")}</th>
          <th className="px-3 py-2 font-medium">{t("Contato")}</th>
          <th className="px-3 py-2 font-medium">{t("Etapa")}</th>
          <th className="px-3 py-2 font-medium">{t("Valor")}</th>
          {perdidos && <th className="px-3 py-2 font-medium">{t("Motivo da perda")}</th>}
          <th className="px-3 py-2 font-medium">{t("Responsável")}</th>
          <th className="px-3 py-2 font-medium" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {linhas.map((n) => (
          <tr key={n.lead_id} className="align-top">
            <td className="max-w-[16rem] px-3 py-2">
              <Link href={`/app/leads/${n.lead_id}`} className="font-medium hover:underline">
                {pessoal(n.titulo)}
              </Link>
            </td>
            <td className="max-w-[14rem] px-3 py-2">
              <Contato c={n.contato} />
            </td>
            <td className="px-3 py-2 text-xs">{n.etapa ?? nr}</td>
            <td className="px-3 py-2 text-xs tabular-nums">{valorFormatado(n.valor_cents, n.moeda, idioma) ?? nr}</td>
            {perdidos && <td className="px-3 py-2 text-xs">{pessoal(n.motivo_da_perda)}</td>}
            <td className="px-3 py-2 text-xs">{pessoal(n.responsavel)}</td>
            <td className="px-3 py-2 text-xs">
              {n.conversation_id ? (
                <Link href={linkDaConversa(n.conversation_id)} className="text-primary hover:underline">
                  {t("Abrir conversa")}
                </Link>
              ) : (
                <span className="text-text-muted">{t("Sem conversa")}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * `modo` diz de onde vem a leitura: a tela ao vivo ("agora") ou um relatório
 * guardado ("no momento da geração"). O CORTE do dia é declarado na tela
 * (`corteDoDia`): "de 00:00 até HH:MM" numa leitura dentro do dia, "dia
 * inteiro" numa leitura feita depois dele — e, aí, as seções de ESTADO DO
 * MOMENTO não aparecem, porque o estado de agora não é o daquele dia.
 */
export function SecoesDaOperacao({
  operacao,
  referencia,
  modo = "ao_vivo",
}: {
  operacao: OperacaoDoDia;
  referencia: string;
  modo?: "ao_vivo" | "relatorio";
}) {
  const t = useT();
  const agora = new Date(referencia);
  const fuso = operacao.fuso;
  const f = operacao.falhas;
  const nr = t("não registrado");
  const tag = (s: string) => `#${s}`;
  const corte = corteDoDia(operacao);
  const doMomento = modo === "ao_vivo" ? t("agora") : t("no momento da geração");
  const notaDoMomento = (
    <p className="px-4 py-6 text-center text-sm text-text-muted" data-testid="operacao-so-hoje">
      {t("Estado do momento — só no dia de hoje.")}
    </p>
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted" data-testid="operacao-corte">
        {corte.diaInteiro
          ? `${operacao.dia} · ${t("dia inteiro")}`
          : `${operacao.dia} · ${t("de 00:00 até")} ${horaCurtaNoFuso(corte.ate, fuso)}`}{" "}
        ({fuso})
      </p>
      {operacao.leitura_falhou && operacao.leitura_falhou.length > 0 && (
        <p className="text-sm text-red-500" role="alert" data-testid="operacao-leitura-falhou">
          {t("Não foi possível ler agora os nomes e resumos deste relatório. Os números e os links continuam valendo.")}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Contador
          titulo={t("Conversas novas no dia")}
          explicacao={t("A primeira mensagem do cliente nesta conversa chegou neste dia.")}
          c={operacao.contadores.novas}
        />
        <Contador
          titulo={t("Conversas com mensagem do cliente no dia")}
          explicacao={t("Novas ou antigas: o cliente escreveu pelo menos uma vez neste dia.")}
          c={operacao.contadores.com_entrada}
        />
      </div>

      {operacao.truncado.length > 0 && (
        <p className="text-xs text-text-muted">
          {t("Algumas listas chegaram ao limite de linhas e não estão inteiras")}: {operacao.truncado.join(", ")}
        </p>
      )}

      <Secao id="aguardando" titulo={`${t("Aguardando uma pessoa")} (${doMomento})`} quantidade={operacao.aguardando.length}>
        {corte.estadoDoMomento ? (
          <TabelaDeConversas linhas={operacao.aguardando} referencia={agora} fuso={fuso} />
        ) : (
          notaDoMomento
        )}
      </Secao>
      <Secao id="projetos" titulo={`${t("Projetos grandes")} (${tag(operacao.tags.projeto)})`} quantidade={operacao.projetos.length}>
        <TabelaDeConversas linhas={operacao.projetos} referencia={agora} fuso={fuso} />
      </Secao>
      <Secao
        id="reclamacoes"
        titulo={`${t("Reclamações e urgentes")} (${tag(operacao.tags.reclamacao)} · ${tag(operacao.tags.urgente)})`}
        quantidade={operacao.reclamacoes.length}
      >
        <TabelaDeConversas linhas={operacao.reclamacoes} referencia={agora} fuso={fuso} />
      </Secao>
      <Secao id="produtos" titulo={`${t("Pedidos de produto")} (${tag(operacao.tags.produto)})`} quantidade={operacao.produtos.length}>
        <TabelaDeConversas linhas={operacao.produtos} referencia={agora} fuso={fuso} comProdutos />
      </Secao>

      <Secao id="ganhos" titulo={t("Negócios ganhos")} quantidade={operacao.funil.ganhos.length}>
        <TabelaDeNegocios linhas={operacao.funil.ganhos} />
      </Secao>
      <Secao id="perdidos" titulo={t("Negócios perdidos")} quantidade={operacao.funil.perdidos.length}>
        <TabelaDeNegocios linhas={operacao.funil.perdidos} perdidos />
      </Secao>
      <Secao id="em-proposta" titulo={`${t("Negócios em proposta")} (${doMomento})`} quantidade={operacao.funil.em_proposta.length}>
        {corte.estadoDoMomento ? <TabelaDeNegocios linhas={operacao.funil.em_proposta} /> : notaDoMomento}
      </Secao>
      <p className="text-xs text-text-muted">
        {t("Negócios que mudaram de etapa no dia")}:{" "}
        {operacao.funil.mudaram_de_etapa === null ? nr : operacao.funil.mudaram_de_etapa}
      </p>

      <Secao
        id="falhas"
        titulo={t("Falhas de operação")}
        quantidade={f.mensagens.length + f.execucoes_da_ia.length + f.canais.length + f.avisos.length}
      >
        <div className="grid grid-cols-1 gap-4 p-4 text-sm md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-text-muted">
              {corte.estadoDoMomento ? t("Mensagens com falha ou presas") : t("Mensagens com falha")} ({f.mensagens.length})
            </h3>
            <ul className="space-y-1">
              {f.mensagens.length === 0 && <li className="text-xs text-text-muted">{t("Nenhuma.")}</li>}
              {f.mensagens.map((m) => (
                <li key={m.message_id} className="text-xs">
                  <Link href={linkDaConversa(m.conversation_id)} className="hover:underline">
                    {m.contato.nome === undefined ? t("não foi possível ler agora") : (m.contato.nome ?? m.contato.telefone ?? m.contato.identidade ?? t("Sem nome"))}
                  </Link>{" "}
                  · {m.status === "sending" ? t("presa em envio") : t("falhou")} · {m.codigo ?? m.erro ?? nr} ·{" "}
                  {horaCurtaNoFuso(m.quando, fuso)}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-text-muted">
              {t("Erros da IA")} ({f.execucoes_da_ia.length})
            </h3>
            <ul className="space-y-1">
              {f.execucoes_da_ia.length === 0 && <li className="text-xs text-text-muted">{t("Nenhuma.")}</li>}
              {f.execucoes_da_ia.map((r) => (
                <li key={r.run_id} className="text-xs">
                  {r.conversation_id ? (
                    <Link href={linkDaConversa(r.conversation_id)} className="hover:underline">
                      {r.contato.nome === undefined ? t("não foi possível ler agora") : (r.contato.nome ?? r.contato.telefone ?? t("Sem nome"))}
                    </Link>
                  ) : (
                    (r.contato.nome === undefined ? t("não foi possível ler agora") : (r.contato.nome ?? t("Sem nome")))
                  )}{" "}
                  · {r.codigo ?? r.erro ?? nr} · {horaCurtaNoFuso(r.quando, fuso)}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-text-muted">
              {t("Canais fora do ar")} ({doMomento}) ({f.canais.length})
            </h3>
            {!corte.estadoDoMomento && notaDoMomento}
            <ul className="space-y-1">
              {corte.estadoDoMomento && f.canais.length === 0 && <li className="text-xs text-text-muted">{t("Nenhum.")}</li>}
              {f.canais.map((c) => (
                <li key={c.channel_session_id} className="text-xs">
                  <Link href="/app/connections" className="hover:underline">
                    {c.numero ?? nr}
                  </Link>{" "}
                  · {c.provedor} · {rotuloDoEstadoDoCanal(c.status, t)}
                  {c.motivo ? ` · ${c.motivo}` : ""}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-text-muted">
              {t("Avisos abertos na Central")} ({doMomento}) ({f.avisos.length})
            </h3>
            {!corte.estadoDoMomento && notaDoMomento}
            <ul className="space-y-1">
              {corte.estadoDoMomento && f.avisos.length === 0 && <li className="text-xs text-text-muted">{t("Nenhum.")}</li>}
              {f.avisos.map((a) => (
                <li key={a.id} className="text-xs">
                  {kindLabel(a.kind, t)} · {horaCurtaNoFuso(a.quando, fuso)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Secao>
    </div>
  );
}

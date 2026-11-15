/**
 * O RELATÓRIO DIÁRIO EM TEXTO PURO — o que se cola num e-mail, num grupo da
 * equipe ou se lê no celular, com o link ABSOLUTO de cada conversa.
 *
 * Pura: recebe o conteúdo congelado, o idioma da organização e a URL pública
 * da instalação (`NEXT_PUBLIC_APP_URL`). Nenhum número aqui é calculado de
 * novo — o texto diz o mesmo que a tela do relatório, palavra por palavra.
 *
 * Campo vazio sai como "não registrado", nunca omitido em silêncio: quem lê o
 * relatório precisa distinguir "não tem" de "ninguém anotou".
 */
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { duracaoCurta, horaCurtaNoFuso, minutosDeEspera } from "./regras";
import type { ContagemPorCanal, ContatoDaLinha, LinhaDeConversa, LinhaDeNegocio, OperacaoDoDia } from "./tipos";

export function linkDaConversa(baseUrl: string, conversationId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/app/inbox?id=${encodeURIComponent(conversationId)}`;
}

export function linkDoNegocio(baseUrl: string, leadId: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/app/leads/${encodeURIComponent(leadId)}`;
}

/** O nome do canal como a equipe fala. */
export function nomeDoCanal(canal: string): string {
  switch (canal) {
    case "whatsapp":
      return "WhatsApp";
    case "instagram":
      return "Instagram";
    case "facebook":
      return "Facebook";
    case "telegram":
      return "Telegram";
    default:
      return canal;
  }
}

/** Valor em moeda, só quando registrado. `null` = o chamador escreve "não registrado". */
export function valorFormatado(cents: number | null, moeda: string | null, idioma: Idioma): string | null {
  if (cents === null || !moeda) return null;
  try {
    return new Intl.NumberFormat(idioma, { style: "currency", currency: moeda }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${moeda}`;
  }
}

export function identificacaoDoContato(c: ContatoDaLinha, t: (s: string) => string): string {
  const partes = [c.nome ?? t("Sem nome"), c.telefone, c.identidade].filter((p): p is string => !!p);
  return partes.join(" · ");
}

export function textoDoRelatorio(
  conteudo: OperacaoDoDia,
  opcoes: { idioma: Idioma; baseUrl: string; geradoEm: Date },
): string {
  const t = (s: string) => traduzir(s, opcoes.idioma);
  const nr = t("não registrado");
  const { baseUrl, geradoEm } = opcoes;
  const fuso = conteudo.fuso;
  const linhas: string[] = [];

  const porCanal = (c: ContagemPorCanal) =>
    `${c.total} (WhatsApp ${c.whatsapp} · Instagram ${c.instagram} · ${t("outros")} ${c.outros})`;

  linhas.push(`${t("Operação do dia")} — ${conteudo.dia} (${fuso})`);
  linhas.push(`${t("Gerado às")} ${horaCurtaNoFuso(geradoEm, fuso)}`);
  linhas.push("");
  linhas.push(`${t("Conversas novas no dia (primeira mensagem do cliente)")}: ${porCanal(conteudo.contadores.novas)}`);
  linhas.push(`${t("Conversas com mensagem do cliente no dia")}: ${porCanal(conteudo.contadores.com_entrada)}`);

  const linhaDeConversa = (l: LinhaDeConversa, comProdutos: boolean) => {
    const espera = minutosDeEspera(l.esperando_desde, geradoEm);
    const cabeca = [
      identificacaoDoContato(l.contato, t),
      `${nomeDoCanal(l.canal)}${l.numero ? ` (${l.numero})` : ""}`,
      espera !== null ? `${t("esperando há")} ${duracaoCurta(espera)}` : null,
      `${t("responsável")}: ${l.responsavel_tipo === "ia" ? t("IA") : (l.responsavel ?? nr)}`,
      `${t("próxima ação")}: ${l.proxima_acao ? l.proxima_acao.titulo + (l.proxima_acao.vence_em ? ` (${t("vence")} ${l.proxima_acao.vence_em.slice(0, 10)})` : "") : nr}`,
      l.ultima_atividade_em ? `${t("última atividade")} ${horaCurtaNoFuso(l.ultima_atividade_em, fuso)}` : null,
    ].filter((p): p is string => !!p);
    const out = [`- ${cabeca.join(" · ")}`];
    if (comProdutos) {
      const pedidos = l.produtos;
      const encontrados = pedidos && pedidos.encontrados.length > 0 ? pedidos.encontrados.join(", ") : nr;
      const termos = pedidos && pedidos.termos.length > 0 ? pedidos.termos.map((x) => `"${x}"`).join(", ") : nr;
      out.push(`  ${t("Produtos")}: ${encontrados} · ${t("buscou")}: ${termos}`);
    }
    out.push(`  ${t("Resumo")}: ${l.resumo ?? nr}`);
    out.push(`  ${linkDaConversa(baseUrl, l.conversation_id)}`);
    return out;
  };

  const secao = (titulo: string, itens: LinhaDeConversa[], comProdutos = false) => {
    linhas.push("");
    linhas.push(`${titulo} (${itens.length})`);
    if (itens.length === 0) linhas.push(`- ${t("nenhuma")}`);
    for (const l of itens) linhas.push(...linhaDeConversa(l, comProdutos));
  };

  secao(t("Aguardando uma pessoa"), conteudo.aguardando);
  secao(t("Projetos grandes"), conteudo.projetos);
  secao(t("Reclamações e urgentes"), conteudo.reclamacoes);
  secao(t("Pedidos de produto"), conteudo.produtos, true);

  const linhaDeNegocio = (n: LinhaDeNegocio) => {
    const valor = valorFormatado(n.valor_cents, n.moeda, opcoes.idioma) ?? nr;
    const partes = [
      n.titulo,
      identificacaoDoContato(n.contato, t),
      `${t("etapa")}: ${n.etapa ?? nr}`,
      `${t("valor")}: ${valor}`,
      n.status === "lost" ? `${t("motivo")}: ${n.motivo_da_perda ?? nr}` : null,
      `${t("responsável")}: ${n.responsavel ?? nr}`,
    ].filter((p): p is string => !!p);
    return [
      `- ${partes.join(" · ")}`,
      `  ${n.conversation_id ? linkDaConversa(baseUrl, n.conversation_id) : linkDoNegocio(baseUrl, n.lead_id)}`,
    ];
  };
  const secaoDeNegocios = (titulo: string, itens: LinhaDeNegocio[]) => {
    linhas.push("");
    linhas.push(`${titulo} (${itens.length})`);
    if (itens.length === 0) linhas.push(`- ${t("nenhum")}`);
    for (const n of itens) linhas.push(...linhaDeNegocio(n));
  };
  secaoDeNegocios(t("Negócios ganhos"), conteudo.funil.ganhos);
  secaoDeNegocios(t("Negócios perdidos"), conteudo.funil.perdidos);
  secaoDeNegocios(t("Negócios em proposta"), conteudo.funil.em_proposta);
  linhas.push(
    `${t("Negócios que mudaram de etapa no dia")}: ${conteudo.funil.mudaram_de_etapa === null ? nr : conteudo.funil.mudaram_de_etapa}`,
  );

  const f = conteudo.falhas;
  linhas.push("");
  linhas.push(t("Falhas de operação"));
  linhas.push(`- ${t("Mensagens com falha ou presas")}: ${f.mensagens.length}`);
  for (const m of f.mensagens.slice(0, 20)) {
    linhas.push(
      `  · ${identificacaoDoContato(m.contato, t)} · ${m.status === "sending" ? t("presa em envio") : t("falhou")} · ${m.codigo ?? m.erro ?? nr} · ${linkDaConversa(baseUrl, m.conversation_id)}`,
    );
  }
  linhas.push(`- ${t("Erros da IA")}: ${f.execucoes_da_ia.length}`);
  for (const r of f.execucoes_da_ia.slice(0, 20)) {
    linhas.push(
      `  · ${identificacaoDoContato(r.contato, t)} · ${r.codigo ?? r.erro ?? nr}${r.conversation_id ? ` · ${linkDaConversa(baseUrl, r.conversation_id)}` : ""}`,
    );
  }
  linhas.push(`- ${t("Canais fora do ar agora")}: ${f.canais.length}`);
  for (const c of f.canais) linhas.push(`  · ${c.numero ?? nr} · ${c.provedor} · ${c.status}${c.motivo ? ` · ${c.motivo}` : ""}`);
  linhas.push(`- ${t("Avisos abertos na Central")}: ${f.avisos.length}`);
  for (const a of f.avisos.slice(0, 20)) linhas.push(`  · ${a.titulo}`);

  if (conteudo.truncado.length > 0) {
    linhas.push("");
    linhas.push(`${t("Listas cortadas no limite de linhas")}: ${conteudo.truncado.join(", ")}`);
  }
  return linhas.join("\n");
}

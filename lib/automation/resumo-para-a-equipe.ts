/**
 * O RESUMO DO LEAD PARA A EQUIPE — função PURA, montada NO MOMENTO DO DISPARO.
 *
 * ─── O defeito que esta peça fecha (#2642) ─────────────────────────────────
 *
 * O único caminho que hoje avisa a equipe é o aviso de caso
 * (`lib/escalacao/texto-do-aviso.ts`): texto FIXO, primeiro nome só, e ele
 * nasce quando o caso ABRE — nunca quando o negócio vira ganho. Quem fecha a
 * venda não recebe nada. Este módulo é o corpo da ação `notify_team`: um
 * resumo LIDO DO MUNDO AGORA (não um template gravado na regra), com a
 * pontuação do lead e o motivo, do jeito que o histórico da conversa já os
 * escreve.
 *
 * ─── Por que PURA ──────────────────────────────────────────────────────────
 *
 * Nada aqui fala com banco, chama modelo ou conhece canal. Quem lê o banco é
 * `carregaResumoDaEquipe` (mesma forma de `texto-do-aviso` × `aviso-ao-suporte`):
 * receber fatos e devolver texto é o que torna o conteúdo testável sem rede.
 *
 * ─── A pontuação e o motivo juntos, sempre ─────────────────────────────────
 *
 * `crm_lead_scores` grava o número E a frase que o explica na MESMA linha
 * (`ai_probability` + `ai_probability_reason` — "score sem razão não é gravado"
 * é constraint do banco). Imprimir só o número daria à equipe um oráculo: o
 * closer que discorda não tem o que apontar. Por isso os dois saem na mesma
 * linha, e o mesmo vale para o `won_reason` do negócio: o motivo do ganho é o
 * dado que a pergunta "por que vendeu?" responde.
 *
 * ─── O que é DADO, e portanto passa pela limpeza ───────────────────────────
 *
 * `title`, `description`, o motivo do ganho, os compromissos e as objeções são
 * escritos pelo MODELO a partir do que o lead disse. Saiem por
 * `sanitizarTextoDoLead` — a mesma régua do aviso de caso —, porque esta
 * mensagem vai para o WhatsApp de uma pessoa da equipe ASSINADA pelo nome da
 * empresa: sem a limpeza, um link de phishing ou um CPF do cliente sairiam de
 * graça dentro dela. Rótulos e dados cadastrais (telefone, valor, pontuação)
 * não passam pela limpeza: são coluna de banco, não fala de terceiro.
 *
 * ─── Linha sem conteúdo não aparece ────────────────────────────────────────
 *
 * `Pontuação: ` vazio AFIRMARIA que há pontuação e que ela é nada. Omissão é a
 * verdade disponível (a mesma decisão de `texto-do-aviso.ts`).
 */
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { primeiroNome } from "@/lib/escalacao/texto-do-aviso";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  TETOS_DO_TEXTO_DO_LEAD,
  sanitizarTextoDoLead,
} from "@/lib/escalacao/sanitizar-texto-do-lead";
import { formatarMoeda } from "@/lib/propostas/moeda";

/** O que o motor já hidratou em `ctx.context` — a linha de `crm_leads`. */
export interface LeadDoResumo {
  title?: string | null;
  description?: string | null;
  status?: string | null;
  value_cents?: number | null;
  currency?: string | null;
  won_reason?: string | null;
}

/** O contato do negócio, se houver. */
export interface ContatoDoResumo {
  name?: string | null;
  display_name?: string | null;
  phone_number?: string | null;
}

/** `crm_lead_scores` — o número e a frase que o explica, juntos. */
export interface PontuacaoDoResumo {
  probabilidade: number | null;
  motivo: string | null;
}

/**
 * A passagem para o humano: o MESMO trio que `blocoDoCheckpoint` do briefing
 * escreve (`Compromissos:`, `Objeções:`, `Próxima ação:`). Vem de
 * `lead_checkpoints` — é o que a conversa combinou com o cliente, e é ele que
 * o closer precisa ler antes de ligar.
 */
export interface PassagemDoResumo {
  compromissos: string[];
  objecoes: string[];
  proximaAcao: string | null;
}

export interface EntradaDoResumo {
  idioma: Idioma;
  /** `rule.name` — o nome que o operador deu à regra que disparou. */
  regra: string;
  lead: LeadDoResumo;
  contato?: ContatoDoResumo | null;
  pontuacao?: PontuacaoDoResumo | null;
  passagem?: PassagemDoResumo | null;
}

/** Lista não vazia vira linha; vazia não imprime cabeçalho órfão.
 *
 * O título chega JÁ TRADUZIDO de quem chama (`t("Compromissos")`): a chave do
 * dicionário é literal em cada sítio, e não um parâmetro livre passado para
 * `t()` — dado de operador não é chave de dicionário.
 */
function lista(titulo: string, itens: readonly string[] | undefined): string | null {
  const limpos = (itens ?? [])
    .map((i) => sanitizarTextoDoLead(i, 160))
    .filter((i): i is string => i !== null);
  if (limpos.length === 0) return null;
  return `${titulo}: ${limpos.join("; ")}`;
}

function linha(titulo: string, valor: string | null | undefined): string | null {
  const texto = typeof valor === "string" ? valor.trim() : "";
  if (texto === "") return null;
  return `${titulo}: ${texto}`;
}

/**
 * Monta o resumo. FUNÇÃO TOTAL: nunca lança, e o corpo nunca vem vazio — o
 * chamador cai no `PISO` quando não há nada a dizer.
 *
 * A ORDEM não é estética: o closer lê de cima para baixo até decidir se
 * liga. Quem é e o que ele quer primeiro; o que a IA leu (pontuação + motivo)
 * depois; o que já foi combinado por último.
 */
export function montarResumoParaAEquipe(entrada: EntradaDoResumo): string {
  const t = (texto: string): string => traduzir(texto, entrada.idioma);
  const linhas: string[] = [t("Resumo do lead para a equipe")];

  const regra = entrada.regra.trim();
  if (regra !== "") linhas.push(`${t("Regra")}: ${regra}`);
  linhas.push("");

  const cliente = primeiroNome(nomeDoContato(entrada.contato ?? null));
  const fone = linha(t("Telefone"), entrada.contato?.phone_number);
  const negocio = sanitizarTextoDoLead(entrada.lead.title, TETOS_DO_TEXTO_DO_LEAD.title);
  const valor =
    typeof entrada.lead.value_cents === "number" && entrada.lead.value_cents > 0
      ? formatarMoeda(entrada.lead.value_cents, (entrada.lead.currency ?? "BRL").toUpperCase())
      : null;
  const motivoDoGanho = sanitizarTextoDoLead(entrada.lead.won_reason, 160);
  const descricao = sanitizarTextoDoLead(entrada.lead.description, TETOS_DO_TEXTO_DO_LEAD.summary);

  if (cliente) linhas.push(`${t("Cliente")}: ${cliente}`);
  if (fone) linhas.push(fone);
  if (negocio) linhas.push(`${t("Negócio")}: ${negocio}`);
  if (valor) linhas.push(`${t("Valor")}: ${valor}`);
  if (motivoDoGanho) linhas.push(`${t("Motivo do ganho")}: ${motivoDoGanho}`);
  if (descricao) linhas.push(`${t("O que o lead pediu")}: ${descricao}`);

  // ── A PONTUAÇÃO E O MOTIVO, na mesma linha ──────────────────────────────
  //
  // Os dois juntos de propósito (cabeçalho): número sozinho é oráculo, frase
  // sozinha é opinião. `probabilidade` pode ser `0` — zero é afirmação, não
  // ausência, e testar por truthiness esconderia o piso legítimo.
  const pontuacao = entrada.pontuacao ?? null;
  if (pontuacao && typeof pontuacao.probabilidade === "number" && Number.isFinite(pontuacao.probabilidade)) {
    const motivo = sanitizarTextoDoLead(pontuacao.motivo, 200);
    const numero = `${Math.max(0, Math.min(100, Math.round(pontuacao.probabilidade)))}%`;
    linhas.push(motivo === null ? `${t("Pontuação")}: ${numero}` : `${t("Pontuação")}: ${numero} — ${motivo}`);
  }

  const passagem = entrada.passagem ?? null;
  if (passagem) {
    const compromissos = lista(t("Compromissos"), passagem.compromissos);
    const objecoes = lista(t("Objeções"), passagem.objecoes);
    const proxima = linha(t("Próxima ação"), passagem.proximaAcao);
    if (compromissos) linhas.push(compromissos);
    if (objecoes) linhas.push(objecoes);
    if (proxima) linhas.push(proxima);
  }

  return linhas.join("\n");
}

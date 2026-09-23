/**
 * Quem PODE receber — puro, sem banco e sem rede.
 *
 * ═══ Por que os vetos são função pura, e não `if` no worker ═══
 *
 * Cada veto é uma decisão sobre uma PESSOA: bloqueada, anonimizada, que recusou
 * contato comercial. Espalhados no worker viram condições que ninguém testa
 * isoladamente — e o veto que ninguém testa é o que um refactor apaga sem nada
 * ficar vermelho. Aqui cada um tem nome, motivo legível e teste.
 *
 * ═══ Por que a MESMA função roda duas vezes ═══
 *
 * Na preparação (para o snapshot já nascer com os excluídos marcados e o
 * operador ver o recorte real antes de apertar) e de novo IMEDIATAMENTE antes de
 * cada envio. Entre uma e outra podem passar horas, e nelas a pessoa pode ter
 * pedido para parar. Revalidar é o que impede a campanha de honrar um opt-out
 * com atraso de um dia — que é o mesmo que não honrar.
 *
 * ═══ De onde vêm os vetos ═══
 *
 * Nenhum é inventado aqui: `is_blocked` é escrito pela detecção canônica de
 * opt-out (`lib/opt-out/deteccao.ts`, via `lib/channels/pos-entrada.ts`),
 * `is_anonymized` é a LGPD, e `consent.marketing.declined_at` é a recusa
 * registrada que `lib/automation/guarda-do-contato.ts` já respeita no resto do
 * produto. A campanha não cria régua concorrente: lê as que existem.
 */
import type { MotivoDeExclusao } from "./tipos";

/** O que se sabe do destinatário na hora de decidir. Nada além disto importa. */
export interface ContatoParaDecidir {
  contactId: string;
  telefone: string | null;
  bloqueado: boolean;
  anonimizado: boolean;
  /** `consent.marketing.declined_at` — recusa REGISTRADA, diferente de ausência. */
  recusouMarketing: boolean;
}

/** O telefone que o canal aceita: E.164 com `+`, o mesmo CHECK de `contacts.phone_number`. */
const E164 = /^\+\d{8,15}$/;

/**
 * Este contato pode receber? `null` = pode.
 *
 * A ordem importa pelo motivo que o operador lê: opt-out vem antes de tudo
 * porque é o veto irrevogável — quem pediu para parar não é "sem telefone", é
 * alguém que pediu para parar, e trocar isso na tela seria mentir sobre o
 * motivo de não ter recebido.
 */
export function motivoParaExcluir(c: ContatoParaDecidir): MotivoDeExclusao | null {
  if (c.bloqueado) return "opt_out";
  if (c.anonimizado) return "anonimizado";
  if (c.recusouMarketing) return "recusou_marketing";
  const telefone = c.telefone?.trim() ?? "";
  if (telefone === "") return "sem_telefone";
  if (!E164.test(telefone)) return "telefone_invalido";
  return null;
}

/** Um candidato do recorte, já lido do banco. */
export interface CandidatoDaAudiencia extends ContatoParaDecidir {
  nome: string | null;
}

export interface LinhaClassificada {
  candidato: CandidatoDaAudiencia;
  elegivel: boolean;
  motivo: MotivoDeExclusao | null;
  /** O texto final — só existe para quem é elegível. */
  corpo: string | null;
}

export interface ContextoDaClassificacao {
  /** Contatos que o operador tirou à mão desta campanha. */
  excluidosAMao: ReadonlySet<string>;
  /** Contatos já comprometidos com outra campanha não concluída. */
  jaEmCampanha: ReadonlySet<string>;
  /**
   * Hashes da lista de exclusão da operação (migration 0376). Decisão de quem
   * opera, diferente do opt-out: aqui não se silencia o atendimento.
   */
  suprimidos: ReadonlySet<string>;
  /** O hash de um endereço — injetado para esta função continuar pura. */
  hashDoEndereco: (endereco: string) => string;
  /** Renderiza o texto e diz o que faltou. Injetado para esta função ficar pura. */
  renderizar: (c: CandidatoDaAudiencia) => { texto: string; faltando: string[] };
}

/**
 * Classifica a lista inteira — é aqui que moram os dois vetos que não cabem numa
 * pessoa isolada: DUPLICADO (dois cadastros, um telefone) e JÁ EM CAMPANHA.
 *
 * ═══ Por que duplicado é veto, e não "manda para os dois" ═══
 *
 * Dois cadastros com o mesmo número são uma pessoa só, e ela receberia a mesma
 * mensagem duas vezes — do mesmo número, com segundos de diferença. Quem vence é
 * o primeiro da ordem estável do recorte, para a prévia e o snapshot darem o
 * mesmo resultado.
 *
 * ═══ Por que "já em campanha" só olha campanha VIVA ═══
 *
 * O produto convida a testar variantes (três textos, três campanhas), e sem este
 * veto as TRÊS mensagens iriam para a mesma pessoa: além de queimar o contato,
 * invalida a medição — a segunda mensagem não mede a segunda copy, mede alguém
 * que já foi abordado. Mas o veto termina quando a campanha termina: bloquear por
 * campanha CONCLUÍDA impediria para sempre falar de novo com quem já se falou,
 * que é o oposto do que um CRM serve para fazer.
 */
export function classificarAudiencia(
  candidatos: readonly CandidatoDaAudiencia[],
  ctx: ContextoDaClassificacao,
): LinhaClassificada[] {
  const enderecosVistos = new Set<string>();
  const saida: LinhaClassificada[] = [];

  for (const candidato of candidatos) {
    const excluir = (motivo: MotivoDeExclusao): void => {
      saida.push({ candidato, elegivel: false, motivo, corpo: null });
    };

    if (ctx.excluidosAMao.has(candidato.contactId)) {
      excluir("excluido_manualmente");
      continue;
    }
    const pessoal = motivoParaExcluir(candidato);
    if (pessoal) {
      excluir(pessoal);
      continue;
    }
    if (ctx.jaEmCampanha.has(candidato.contactId)) {
      excluir("ja_em_campanha");
      continue;
    }
    const endereco = candidato.telefone!.trim();
    if (ctx.suprimidos.has(ctx.hashDoEndereco(endereco))) {
      excluir("suprimido");
      continue;
    }
    if (enderecosVistos.has(endereco)) {
      excluir("duplicado");
      continue;
    }
    const { texto, faltando } = ctx.renderizar(candidato);
    if (faltando.length > 0) {
      excluir("variavel_ausente");
      continue;
    }

    enderecosVistos.add(endereco);
    saida.push({ candidato, elegivel: true, motivo: null, corpo: texto });
  }

  return saida;
}

/** Contagem por motivo, para a prévia. */
export function contarExclusoes(
  linhas: readonly LinhaClassificada[],
): Partial<Record<MotivoDeExclusao, number>> {
  const conta: Partial<Record<MotivoDeExclusao, number>> = {};
  for (const linha of linhas) {
    if (linha.motivo) conta[linha.motivo] = (conta[linha.motivo] ?? 0) + 1;
  }
  return conta;
}

/** Lê `contacts.consent` sem confiar no shape — é jsonb livre. */
export function recusouMarketing(consent: unknown): boolean {
  if (!consent || typeof consent !== "object") return false;
  const marketing = (consent as Record<string, unknown>).marketing;
  if (!marketing || typeof marketing !== "object") return false;
  return !!(marketing as Record<string, unknown>).declined_at;
}

/**
 * A base legal declarada basta para um primeiro toque frio?
 *
 * Mesma régua de `lib/agent-engine/guardrails/lgpd/legal-basis.ts`: interesse
 * legítimo sem a referência da avaliação (LIA) não responde "com base em quê
 * você me mandou isto?", e por isso não vale.
 */
export function baseLegalValida(input: { baseLegal: string; liaRef: string | null }): boolean {
  if (input.baseLegal === "consent") return true;
  if (input.baseLegal === "legitimate_interest") return (input.liaRef?.trim() ?? "") !== "";
  return false;
}

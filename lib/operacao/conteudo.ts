/**
 * O CONTEÚDO GUARDADO do relatório diário: só FATOS, nunca dado pessoal.
 *
 * ─── Por que o relatório não guarda nome, telefone nem texto ────────────────
 *
 * A doutrina de LGPD é que a cascata de anonimização alcança TODA cópia do
 * dado do contato (`fn_lgpd_cascade_redact_contact`). Um jsonb congelado não
 * é alcançado por ela — então ele não pode conter o que ela precisaria apagar.
 *
 * `congelar` tira de cada linha as chaves pessoais (ver `tipos.ts`): nome,
 * telefone, @, prévia da mensagem, resumo da passagem, título de tarefa e de
 * negócio, motivo escrito, mensagem de erro, nome de quem atende, título de
 * aviso. Ficam os ids, o canal, a situação, as etiquetas, os instantes, os
 * códigos e os termos/produtos da busca da IA.
 *
 * `hidratar` faz o caminho de volta NA HORA DE LER, pelo leitor que a tela
 * entrega (o client da sessão, sob RLS). Um contato anonimizado depois da
 * geração aparece anonimizado sozinho, porque o nome vem da linha ATUAL.
 */
import type {
  AvisoAberto,
  ContatoDaLinha,
  FalhaDaIa,
  FalhaDeMensagem,
  LinhaDeConversa,
  LinhaDeNegocio,
  OperacaoDoDia,
} from "./tipos";

/** As chaves que NUNCA podem aparecer no jsonb guardado. Vigiado por teste. */
export const CHAVES_PESSOAIS = [
  "nome",
  "telefone",
  "identidade",
  "resumo",
  "resumo_origem",
  "titulo",
  "motivo_da_perda",
  "responsavel",
  "erro",
] as const;

const contatoCongelado = (c: ContatoDaLinha): ContatoDaLinha => ({ contact_id: c.contact_id });

function conversaCongelada(l: LinhaDeConversa): LinhaDeConversa {
  const out: LinhaDeConversa = {
    conversation_id: l.conversation_id,
    contato: contatoCongelado(l.contato),
    canal: l.canal,
    numero: l.numero,
    status: l.status,
    comando: l.comando,
    motivo_codigo: l.motivo_codigo,
    proxima_acao: l.proxima_acao ? { vence_em: l.proxima_acao.vence_em } : null,
    responsavel_user_id: l.responsavel_user_id,
    responsavel_tipo: l.responsavel_tipo,
    ultima_atividade_em: l.ultima_atividade_em,
    esperando_desde: l.esperando_desde,
    tags: [...l.tags],
  };
  if (l.produtos) out.produtos = { termos: [...l.produtos.termos], encontrados: [...l.produtos.encontrados] };
  return out;
}

const negocioCongelado = (n: LinhaDeNegocio): LinhaDeNegocio => ({
  lead_id: n.lead_id,
  contato: contatoCongelado(n.contato),
  conversation_id: n.conversation_id,
  etapa: n.etapa,
  status: n.status,
  valor_cents: n.valor_cents,
  moeda: n.moeda,
  responsavel_user_id: n.responsavel_user_id,
  quando: n.quando,
});

const mensagemCongelada = (m: FalhaDeMensagem): FalhaDeMensagem => ({
  message_id: m.message_id,
  conversation_id: m.conversation_id,
  contato: contatoCongelado(m.contato),
  status: m.status,
  codigo: m.codigo,
  quando: m.quando,
});

const iaCongelada = (r: FalhaDaIa): FalhaDaIa => ({
  run_id: r.run_id,
  conversation_id: r.conversation_id,
  contato: contatoCongelado(r.contato),
  codigo: r.codigo,
  quando: r.quando,
});

const avisoCongelado = (a: AvisoAberto): AvisoAberto => ({
  id: a.id,
  kind: a.kind,
  severidade: a.severidade,
  quando: a.quando,
});

/** A Operação do dia sem nenhum dado pessoal — o que vai para o banco. Pura: devolve uma cópia. */
export function congelar(c: OperacaoDoDia): OperacaoDoDia {
  return {
    versao: c.versao,
    dia: c.dia,
    fuso: c.fuso,
    inicio: c.inicio,
    fim: c.fim,
    lido_em: c.lido_em,
    tags: { ...c.tags },
    contadores: { novas: { ...c.contadores.novas }, com_entrada: { ...c.contadores.com_entrada } },
    aguardando: c.aguardando.map(conversaCongelada),
    projetos: c.projetos.map(conversaCongelada),
    reclamacoes: c.reclamacoes.map(conversaCongelada),
    produtos: c.produtos.map(conversaCongelada),
    funil: {
      ganhos: c.funil.ganhos.map(negocioCongelado),
      perdidos: c.funil.perdidos.map(negocioCongelado),
      em_proposta: c.funil.em_proposta.map(negocioCongelado),
      mudaram_de_etapa: c.funil.mudaram_de_etapa,
    },
    falhas: {
      mensagens: c.falhas.mensagens.map(mensagemCongelada),
      execucoes_da_ia: c.falhas.execucoes_da_ia.map(iaCongelada),
      canais: c.falhas.canais.map((x) => ({ ...x })),
      avisos: c.falhas.avisos.map(avisoCongelado),
    },
    truncado: [...c.truncado],
  };
}

/** O jsonb é desta versão? Outro formato não é desenhado (a tela diz que não sabe ler). */
export function lerConteudo(bruto: unknown): OperacaoDoDia | null {
  if (!bruto || typeof bruto !== "object") return null;
  const c = bruto as Partial<OperacaoDoDia>;
  if (c.versao !== 1 || typeof c.dia !== "string" || !c.contadores || !c.falhas || !c.funil) return null;
  return c as OperacaoDoDia;
}

// ─── A VOLTA: resolver o pessoal AO VIVO ────────────────────────────────────

export interface ContatoAtual {
  nome: string | null;
  telefone: string | null;
  identidade: string | null;
}

/**
 * O que a tela do relatório lê do banco na hora, com a RLS da sessão. Quem
 * implementa é `leitorDoBanco` (`hidratar-do-banco.ts`); o teste entrega um
 * leitor de mentira. Id ausente no mapa = não alcançável (apagado, ou fora do
 * escopo de quem lê) — a linha diz "não registrado".
 */
export interface LeitorAoVivo {
  contatos(ids: string[]): Promise<Map<string, ContatoAtual>>;
  /** Por conversa: a prévia da última mensagem e o nome de quem atende agora. */
  conversas(ids: string[]): Promise<Map<string, { previa: string | null; responsavel: string | null }>>;
  /** Por conversa: o resumo da passagem mais recente. */
  passagens(ids: string[]): Promise<Map<string, string>>;
  /** Por contato: o título da próxima tarefa aberta. */
  tarefas(idsDeContato: string[]): Promise<Map<string, string>>;
  /** Por negócio: título e motivo da perda. */
  negocios(ids: string[]): Promise<Map<string, { titulo: string | null; motivo_da_perda: string | null }>>;
  /** Por usuário: o nome. */
  nomes(ids: string[]): Promise<Map<string, string | null>>;
}

const unicos = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

/** Preenche o pessoal de um conteúdo guardado com o que o banco diz AGORA. */
export async function hidratar(c: OperacaoDoDia, leitor: LeitorAoVivo): Promise<OperacaoDoDia> {
  const conversas = [...c.aguardando, ...c.projetos, ...c.reclamacoes, ...c.produtos];
  const negocios = [...c.funil.ganhos, ...c.funil.perdidos, ...c.funil.em_proposta];
  const todosOsContatos = [
    ...conversas.map((l) => l.contato),
    ...negocios.map((n) => n.contato),
    ...c.falhas.mensagens.map((m) => m.contato),
    ...c.falhas.execucoes_da_ia.map((r) => r.contato),
  ];
  const idsDeConversa = unicos(conversas.map((l) => l.conversation_id));
  const [contatos, convs, passagens, tarefas, negs, nomes] = await Promise.all([
    leitor.contatos(unicos(todosOsContatos.map((x) => x.contact_id))),
    leitor.conversas(idsDeConversa),
    leitor.passagens(idsDeConversa),
    leitor.tarefas(unicos(conversas.filter((l) => l.proxima_acao).map((l) => l.contato.contact_id))),
    leitor.negocios(unicos(negocios.map((n) => n.lead_id))),
    leitor.nomes(unicos(negocios.map((n) => n.responsavel_user_id))),
  ]);

  const contato = (x: ContatoDaLinha): ContatoDaLinha => {
    const atual = x.contact_id ? contatos.get(x.contact_id) : undefined;
    return { contact_id: x.contact_id, nome: atual?.nome ?? null, telefone: atual?.telefone ?? null, identidade: atual?.identidade ?? null };
  };
  const conversa = (l: LinhaDeConversa): LinhaDeConversa => {
    const passagem = passagens.get(l.conversation_id) ?? null;
    const previa = convs.get(l.conversation_id)?.previa ?? null;
    const titulo = l.contato.contact_id ? (tarefas.get(l.contato.contact_id) ?? null) : null;
    return {
      ...l,
      contato: contato(l.contato),
      resumo: passagem ?? previa,
      resumo_origem: passagem ? "passagem" : previa ? "ultima_mensagem" : null,
      proxima_acao: l.proxima_acao ? { titulo, vence_em: l.proxima_acao.vence_em } : null,
      responsavel: l.responsavel_user_id ? (convs.get(l.conversation_id)?.responsavel ?? null) : null,
    };
  };
  const negocio = (n: LinhaDeNegocio): LinhaDeNegocio => ({
    ...n,
    contato: contato(n.contato),
    titulo: negs.get(n.lead_id)?.titulo ?? null,
    motivo_da_perda: negs.get(n.lead_id)?.motivo_da_perda ?? null,
    responsavel: n.responsavel_user_id ? (nomes.get(n.responsavel_user_id) ?? null) : null,
  });

  return {
    ...c,
    aguardando: c.aguardando.map(conversa),
    projetos: c.projetos.map(conversa),
    reclamacoes: c.reclamacoes.map(conversa),
    produtos: c.produtos.map(conversa),
    funil: {
      ...c.funil,
      ganhos: c.funil.ganhos.map(negocio),
      perdidos: c.funil.perdidos.map(negocio),
      em_proposta: c.funil.em_proposta.map(negocio),
    },
    falhas: {
      ...c.falhas,
      mensagens: c.falhas.mensagens.map((m) => ({ ...m, contato: contato(m.contato) })),
      execucoes_da_ia: c.falhas.execucoes_da_ia.map((r) => ({ ...r, contato: contato(r.contato) })),
    },
  };
}

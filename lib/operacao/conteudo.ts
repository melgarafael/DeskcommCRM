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
 * códigos e os NOMES dos produtos que a busca da IA achou (o termo que o
 * cliente escreveu é texto dele e também sai).
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
  "termos",
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
  // Só os NOMES de produto (dado do catálogo). O TERMO buscado é o que o cliente
  // escreveu — texto dele — e não vai para o jsonb guardado.
  if (l.produtos) out.produtos = { encontrados: [...l.produtos.encontrados] };
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

/**
 * O que não deu para ler AGORA. Distinto de "não registrado": `null` num campo
 * pessoal quer dizer "o banco respondeu e não há" (contato apagado, sem nome);
 * o campo AUSENTE (`undefined`) com a leitura listada aqui quer dizer "o banco
 * não respondeu" — e a tela diz "não foi possível ler agora", nunca "não
 * registrado". Uma falha de leitura não pode se passar por dado vazio.
 */
export type LeituraAoVivo = "contatos" | "conversas" | "passagens" | "tarefas" | "negocios" | "nomes";

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
  const falhou: LeituraAoVivo[] = [];
  async function ler<T>(nome: LeituraAoVivo, p: () => Promise<Map<string, T>>): Promise<Map<string, T> | null> {
    try {
      return await p();
    } catch {
      falhou.push(nome);
      return null;
    }
  }
  const [contatos, convs, passagens, tarefas, negs, nomes] = await Promise.all([
    ler("contatos", () => leitor.contatos(unicos(todosOsContatos.map((x) => x.contact_id)))),
    ler("conversas", () => leitor.conversas(idsDeConversa)),
    ler("passagens", () => leitor.passagens(idsDeConversa)),
    ler("tarefas", () => leitor.tarefas(unicos(conversas.filter((l) => l.proxima_acao).map((l) => l.contato.contact_id)))),
    ler("negocios", () => leitor.negocios(unicos(negocios.map((n) => n.lead_id)))),
    ler("nomes", () => leitor.nomes(unicos(negocios.map((n) => n.responsavel_user_id)))),
  ]);

  // Mapa nulo = a leitura falhou: o campo fica AUSENTE (não `null`).
  const contato = (x: ContatoDaLinha): ContatoDaLinha => {
    if (!contatos) return { contact_id: x.contact_id };
    const atual = x.contact_id ? contatos.get(x.contact_id) : undefined;
    return { contact_id: x.contact_id, nome: atual?.nome ?? null, telefone: atual?.telefone ?? null, identidade: atual?.identidade ?? null };
  };
  const conversa = (l: LinhaDeConversa): LinhaDeConversa => {
    const out: LinhaDeConversa = { ...l, contato: contato(l.contato) };
    if (passagens && convs) {
      const passagem = passagens.get(l.conversation_id) ?? null;
      const previa = convs.get(l.conversation_id)?.previa ?? null;
      out.resumo = passagem ?? previa;
      out.resumo_origem = passagem ? "passagem" : previa ? "ultima_mensagem" : null;
    }
    if (l.proxima_acao) {
      out.proxima_acao = tarefas
        ? { titulo: l.contato.contact_id ? (tarefas.get(l.contato.contact_id) ?? null) : null, vence_em: l.proxima_acao.vence_em }
        : { vence_em: l.proxima_acao.vence_em };
    }
    if (!l.responsavel_user_id) out.responsavel = null;
    else if (convs) out.responsavel = convs.get(l.conversation_id)?.responsavel ?? null;
    return out;
  };
  const negocio = (n: LinhaDeNegocio): LinhaDeNegocio => {
    const out: LinhaDeNegocio = { ...n, contato: contato(n.contato) };
    if (negs) {
      out.titulo = negs.get(n.lead_id)?.titulo ?? null;
      out.motivo_da_perda = negs.get(n.lead_id)?.motivo_da_perda ?? null;
    }
    if (!n.responsavel_user_id) out.responsavel = null;
    else if (nomes) out.responsavel = nomes.get(n.responsavel_user_id) ?? null;
    return out;
  };

  return {
    ...c,
    ...(falhou.length > 0 ? { leitura_falhou: falhou } : {}),
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

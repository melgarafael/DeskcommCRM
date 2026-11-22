/**
 * A LISTA DA CAMPANHA DE VOLTA PARA QUEM OPERA (issue #4360).
 *
 * O produto sabia importar uma lista e não sabia devolvê-la: quem buscou 80
 * empresas, iniciou a campanha e quis a mesma lista com outra estratégia (outro
 * agente, outro número, outra instrução) ficava sem caminho — a tela só mostra
 * os candidatos e não há botão de saída.
 *
 * ─── O que sai: duas listas, a mesma porta ───────────────────────────────────
 *
 * `quem=nao_abordadas` (o padrão, o de sempre): só as empresas que AINDA PODEM
 * ser abordadas — nunca tiveram tentativa (`attempted_at` nulo), continuam na
 * fila (`new`/`queued`) e têm telefone com WhatsApp. É o arquivo para reimportar
 * aqui: quem já foi abordado viraria "Contato já existe no CRM" na triagem
 * (`store.ts`, `triarCandidato`).
 *
 * `quem=todas`: a lista INTEIRA da campanha, com uma coluna final `situacao`
 * (respondeu, abordada, envio não confirmado, não abordada ou fora da fila;
 * `situacaoDaEmpresa`). A #4360 decidiu entregar só a primeira,
 * e a decisão era certa para o arquivo de reimportar; ela deixava sem saída quem
 * terminou a campanha e quer a lista para outra oferta, por outro número — a
 * campanha concluída não tinha botão nenhum. A lista inteira não promete
 * reimportação: a coluna `situacao` diz o que aconteceu com cada empresa, e a
 * triagem de uma campanha nova continua recusando quem já é contato.
 *
 * ─── O que NUNCA sai, nos dois modos (decisão de produto D13) ───────────────
 *
 * Quem pediu para parar (`is_blocked`, o que o PARAR grava, ou a recusa de
 * marketing registrada — `recusaRegistrada`), ficha pessoal (`is_personal`) e
 * quem teve os dados apagados (contato anonimizado, ou a linha da campanha
 * suprimida pela cascata de LGPD). Um arquivo sai do CRM e não carrega mais
 * nenhuma das guardas daqui: a pessoa que pediu para parar, posta numa planilha,
 * vira mensagem por qualquer outra ferramenta. A tela diz QUANTAS ficaram de
 * fora (`resumoDaLista`), e por isso a régua é uma só — `motivoForaDaLista`.
 *
 * O contato de uma empresa é achado pelo `contact_id` da linha E pelo telefone
 * (com as duas grafias do nono dígito, na ficha principal ou como telefone
 * extra): a empresa que a triagem pulou por "Contato já existe no CRM" fica com
 * `contact_id` nulo de propósito (`store.ts`), e só pelo vínculo a pessoa que
 * pediu para parar por outro caminho sairia no arquivo.
 *
 * ─── O formato é o da IMPORTAÇÃO, não um formato novo ────────────────────────
 *
 * As colunas são as do "Baixar modelo" (`_client.tsx`, `baixarModelo`) e as que
 * `lerPlanilhaDeProspeccao` reconhece (`lib/prospecting/planilha.ts`):
 * `empresa;telefone;site;segmento;endereco;email;redes`, separadas por `;`, com
 * BOM UTF-8 e CRLF — o que o Excel em português abre em colunas e o que o
 * importador de planilha lê de volta. Exportar num dialeto próprio obrigaria a
 * pessoa a editar o arquivo antes de reusá-lo.
 *
 * ─── Por que exportar e não "duplicar campanha" ──────────────────────────────
 *
 * MEDIDO: `prospecting_candidates` tem `unique (organization_id, place_id)` e o
 * índice `prospecting_phone_once_org on (organization_id, phone)`
 * (`supabase/baseline.sql:35628`) — a mesma empresa só pode estar em UMA
 * campanha por organização. Copiar as linhas para uma campanha nova passa pelo
 * `insert ... on conflict do nothing` de `gravarCandidatos` e grava ZERO linha,
 * em silêncio; e "duplicar" movendo as linhas tiraria a lista da campanha de
 * origem. Duplicar exige decisão de produto sobre essa unicidade (e sobre o
 * contato/negócio que o modo `on_start` já criou) — o PR desta fatia declara
 * isso e entrega a saída que não depende dela.
 */

import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { recusaRegistrada } from "@/lib/lgpd/recusa-registrada";
import { dataIsoNoFuso } from "@/lib/propostas/data-no-fuso";

/**
 * As marcas de um contato do CRM que tiram a empresa do arquivo
 * (`contacts`). `telefone` é por onde ele foi achado: a ficha principal ou um
 * telefone extra (`contact_phones`).
 */
export type ContatoDaLista = {
  id: string;
  telefone?: string | null;
  is_blocked?: boolean | null;
  is_personal?: boolean | null;
  is_anonymized?: boolean | null;
  consent?: unknown;
};

/**
 * A MARCA do que já foi tentado nesta empresa (issue #4632): quando a abordagem
 * foi registrada e em que campanha ela saiu.
 *
 * Onde isso mora, medido: a linha de `prospecting_candidates` guarda o ESTADO
 * atual da empresa naquela campanha (`status`, `attempted_at`, `channel_session_id`)
 * e a única trilha que sobrevive à linha é a auditoria `prospecting.approach_sent`
 * (`worker.ts`), com `campaign_id`, `contact_id`, `conversation_id` e
 * `channel_session_id` no metadata. Ou seja: o registro de abordagem é POR
 * EMPRESA+CAMPANHA na linha e POR CONTATO na trilha — não é por número. O número
 * (`channel_session_id`) viaja junto, como dado da abordagem, e não é a chave
 * de nada.
 *
 * Por isso a campanha da abordagem vem da trilha (`campanha`), e `campanha` só
 * difere da campanha exportada quando a mesma empresa já foi tentada por OUTRA
 * campanha — o caso que a #4632 veio resolver.
 */
export type AbordagemAnterior = {
  /** Quando a abordagem foi registrada (`created_at` da trilha, ou `attempted_at`). */
  em?: string | Date | null;
  /** A campanha em que a abordagem saiu (`campaign_id` da trilha, já com nome). */
  campanha?: string | null;
};

/** O mínimo de um candidato que a régua e o CSV leem (`prospecting_candidates`). */
// `type` e não `interface`: `pg` exige `Record<string, any>` no genérico do
// `query<>`, e só o alias ganha índice implícito.
export type CandidatoDaLista = {
  status?: string;
  attempted_at?: string | Date | null;
  /** Identidade da empresa na origem (`prospecting_candidates.place_id`): a chave do dedupe. */
  place_id?: string | null;
  /** O que já foi tentado com esta empresa, na trilha `prospecting.approach_sent`. */
  abordagem?: AbordagemAnterior | null;
  /** Coluna `phone` da linha; `data.phone` é a mesma coisa no caminho da busca. */
  phone?: string | null;
  contact_id?: string | null;
  /** A cascata de LGPD apagou esta linha (`suppression_salt` semeado, migration 0370). */
  suprimida?: boolean | null;
  /** A conversa da abordagem recebeu mensagem da empresa (`conversations.last_inbound_at`). */
  respondeu?: boolean | null;
  /** Os contatos do CRM desta empresa, ligados por `ligarContatos`. */
  contatos?: readonly ContatoDaLista[];
  data: {
    name?: string | null;
    phone?: string | null;
    website?: string | null;
    category?: string | null;
    address?: string | null;
    emails?: readonly string[] | null;
    socials?: readonly string[] | null;
    whatsapp?: { existe: boolean } | null;
  };
}

/**
 * A régua ÚNICA de "ainda não abordada". A rota do CSV e o contador da tela
 * chamam esta função — duas cópias divergiriam no primeiro ajuste, e o botão
 * diria "12" enquanto o arquivo levasse 9.
 */
export function naoAbordada(c: CandidatoDaLista): boolean {
  // Tentativa registrada = a empresa foi (ou está sendo) abordada. `sending` e
  // `sent` já caem aqui pelo status; o `attempted_at` pega também quem voltou
  // para a fila depois de uma falha.
  if (c.attempted_at != null) return false;
  if (c.status !== "new" && c.status !== "queued") return false;
  // O canal já respondeu que este número não tem WhatsApp: abordar seria
  // escrever (e pagar) uma mensagem que ninguém recebe. Não entra no arquivo
  // porque também não entraria na fila (`triarCandidato`).
  if (c.data.whatsapp?.existe === false) return false;
  return Boolean(c.data.phone ?? c.phone);
}

/** Por que uma empresa não sai no arquivo. A ordem é a de precedência. */
export const MOTIVOS_FORA_DA_LISTA = ["dados_apagados", "pediu_para_parar", "ficha_pessoal"] as const;
export type MotivoForaDaLista = (typeof MOTIVOS_FORA_DA_LISTA)[number];

/**
 * A régua ÚNICA de "esta empresa não sai em arquivo nenhum" (D13). `null` é
 * "pode sair". Vale para os dois modos: a lista das não abordadas também não
 * leva quem pediu para parar — o contato criado ao iniciar (`on_start`) pode
 * ter dito PARAR por outro caminho antes de a abordagem sair.
 */
export function motivoForaDaLista(c: CandidatoDaLista): MotivoForaDaLista | null {
  const contatos = c.contatos ?? [];
  if (c.suprimida === true || contatos.some((k) => k.is_anonymized === true)) return "dados_apagados";
  if (contatos.some((k) => k.is_blocked === true || recusaRegistrada(k.consent, "marketing")))
    return "pediu_para_parar";
  if (contatos.some((k) => k.is_personal === true)) return "ficha_pessoal";
  return null;
}

/** As duas listas que a rota entrega (`?quem=`). */
export const LISTAS = ["nao_abordadas", "todas"] as const;
export type QualLista = (typeof LISTAS)[number];

/** A empresa entra no arquivo `quem`? Uma função só para a rota e o resumo. */
export function entraNaLista(c: CandidatoDaLista, quem: QualLista): boolean {
  if (motivoForaDaLista(c) !== null) return false;
  return quem === "todas" ? true : naoAbordada(c);
}

/** A régua de `quem=todas`: a lista inteira, menos quem nunca sai (D13). */
export function naLista(c: CandidatoDaLista): boolean {
  return entraNaLista(c, "todas");
}

/**
 * A chave da EMPRESA, para a mesma empresa não sair duas vezes no arquivo da
 * mesma campanha: `place_id` é a identidade da origem; sem ele, o telefone; sem
 * telefone, o nome normalizado. `prospecting_candidates` tem
 * `unique (organization_id, place_id)` e `prospecting_phone_once_org`, então a
 * duplicata não deveria existir no banco — esta é a rede embaixo do trapézio,
 * para quando a leitura juntar linhas de duas campanhas.
 */
export function chaveDaEmpresa(c: CandidatoDaLista): string {
  if (c.place_id) return `place:${c.place_id}`;
  const telefone = telefonesDaEmpresa(c)[0];
  if (telefone) return `fone:${telefone}`;
  return `nome:${(c.data.name ?? "").trim().toLowerCase()}`;
}

/**
 * UMA linha por empresa, na ordem da campanha. Se a mesma empresa aparece duas
 * vezes (uma abordada e outra não), fica a ABORDADA: a lista da #4632 existe
 * para mostrar o que já foi tentado, e a linha sem tentativa esconderia a marca.
 */
export function empresasDaLista(
  candidatos: readonly CandidatoDaLista[],
  quem: QualLista,
): CandidatoDaLista[] {
  const porChave = new Map<string, number>();
  const saida: CandidatoDaLista[] = [];
  for (const c of candidatos) {
    if (!entraNaLista(c, quem)) continue;
    const chave = chaveDaEmpresa(c);
    const jaEsta = porChave.get(chave);
    if (jaEsta === undefined) {
      porChave.set(chave, saida.length);
      saida.push(c);
      continue;
    }
    if (!foiAbordada(saida[jaEsta]!) && foiAbordada(c)) saida[jaEsta] = c;
  }
  return saida;
}

/** O que aconteceu com a empresa, na coluna `situacao` do arquivo completo. */
export const SITUACOES_DA_EMPRESA = [
  "respondeu",
  "abordada",
  "envio não confirmado",
  "não abordada",
  "fora da fila",
] as const;
export type SituacaoDaEmpresa = (typeof SITUACOES_DA_EMPRESA)[number];

/**
 * A coluna promete o que ACONTECEU com cada empresa, então cada valor só é dito
 * quando a fonte dele confirma:
 *
 * - `abordada` é envio CONFIRMADO: o worker só grava `sent` quando a 1ª bolha
 *   foi aceita pelo canal (`worker.ts`, `abordou`). `attempted_at` sozinho NÃO
 *   é envio: ele é gravado antes da guarda, da geração por IA e da autorização,
 *   e a falha em qualquer um desses passos deixa a linha `failed` com a
 *   tentativa gravada e nenhuma mensagem enviada.
 * - `envio não confirmado` é a tentativa sem confirmação (`failed` ou `sending`
 *   com `attempted_at`): pode não ter saído nada (IA sem texto, guarda vetou) ou
 *   ter saído sem o canal confirmar (a limpeza de 10 minutos do `sending`). O
 *   arquivo não afirma nenhum dos dois, como o "Envio não confirmado. Consulte
 *   a conversa antes de reenviar." que o próprio worker grava.
 * - `não abordada` é EXATAMENTE `naoAbordada`, a régua do arquivo das não
 *   abordadas e do número do menu. Sem isso, o menu diria "0" e a coluna
 *   mostraria 3.
 * - `fora da fila` é o resto sem tentativa: a triagem pulou (já é contato do
 *   CRM, sem WhatsApp, sem telefone) ou a linha saiu da fila antes de tentar.
 *   Não é "não abordada": parte dessas empresas já é contato, talvez em
 *   atendimento, e não deve ser abordada por fora.
 */
export function situacaoDaEmpresa(c: CandidatoDaLista): SituacaoDaEmpresa {
  if (c.respondeu === true) return "respondeu";
  if (c.status === "sent") return "abordada";
  if (c.attempted_at != null || c.status === "sending") return "envio não confirmado";
  if (naoAbordada(c)) return "não abordada";
  return "fora da fila";
}

/** A empresa já teve TENTATIVA registrada? (a linha da campanha, ou a trilha) */
export function foiAbordada(c: CandidatoDaLista): boolean {
  // `attempted_at` é gravado ANTES da guarda, da IA e da autorização
  // (`worker.ts`): tentativa, não envio. É a marca do que já foi tentado, e é
  // isso que a coluna promete — quem separa "enviada" de "envio não confirmado"
  // é `situacaoDaEmpresa`.
  if (c.attempted_at != null) return true;
  if (c.status === "sent" || c.status === "sending") return true;
  return c.abordagem?.em != null;
}

/**
 * `AAAA-MM-DD` (ou vazio). Data ISO e não `dd/mm/aaaa`: o arquivo é lido por
 * planilha e por script, e a data ambígua é a que faz alguém achar que a
 * abordagem foi em janeiro quando foi em dezembro.
 *
 * O dia é o do FUSO da organização, não o de UTC: `toISOString()` punha uma
 * abordagem das 21:30 de Brasília no dia seguinte.
 */
export function dataDaAbordagem(c: CandidatoDaLista, fuso: string): string {
  const marca = c.abordagem?.em ?? c.attempted_at;
  if (marca == null) return "";
  const data = marca instanceof Date ? marca : new Date(marca);
  if (Number.isNaN(data.getTime())) return "";
  return dataIsoNoFuso(data, fuso);
}

/**
 * Em que campanha a abordagem saiu. Vem da TRILHA (`prospecting.approach_sent`)
 * quando ela tem a passagem; sem trilha, a campanha da própria linha — que é o
 * mesmo dado dito pelo lugar em que a empresa entrou. Empresa não abordada não
 * tem campanha, e a coluna fica vazia: inventar o nome da campanha exportada ali
 * diria "tentamos" de quem nunca recebeu nada.
 */
export function campanhaDaAbordagem(c: CandidatoDaLista, nomeDaCampanha: string): string {
  if (!foiAbordada(c)) return "";
  return c.abordagem?.campanha || nomeDaCampanha;
}

export interface ResumoDaLista {
  /** Linhas lidas da campanha (até o teto da rota). */
  total: number;
  /** Quantas o arquivo `quem=nao_abordadas` leva. */
  nao_abordadas: number;
  /** Quantas o arquivo `quem=todas` leva. */
  todas: number;
  /** Quantas nenhum arquivo leva, por motivo. */
  fora_da_lista: Record<MotivoForaDaLista, number>;
}

/** A contagem que a tela mostra, sobre a lista INTEIRA da campanha — a mesma régua do arquivo. */
export function resumoDaLista(candidatos: readonly CandidatoDaLista[]): ResumoDaLista {
  const fora: Record<MotivoForaDaLista, number> = {
    dados_apagados: 0,
    pediu_para_parar: 0,
    ficha_pessoal: 0,
  };
  for (const c of candidatos) {
    const motivo = motivoForaDaLista(c);
    if (motivo) fora[motivo] += 1;
  }
  return {
    total: candidatos.length,
    nao_abordadas: candidatos.filter((c) => entraNaLista(c, "nao_abordadas")).length,
    todas: candidatos.filter((c) => entraNaLista(c, "todas")).length,
    fora_da_lista: fora,
  };
}

/** Os telefones pelos quais o contato de uma empresa pode estar gravado (E.164 com `+`). */
export function telefonesDaEmpresa(c: CandidatoDaLista): string[] {
  const bruto = c.phone ?? c.data.phone;
  return bruto ? phoneLookupVariants(bruto) : [];
}

/**
 * Pendura em cada empresa os contatos do CRM que são dela: pelo `contact_id` da
 * linha ou por qualquer grafia do telefone. Pura — a rota lê os contatos numa
 * consulta só e a ligação é feita aqui, onde o teste alcança.
 */
export function ligarContatos(
  candidatos: readonly CandidatoDaLista[],
  contatos: readonly ContatoDaLista[],
): CandidatoDaLista[] {
  const porId = new Map<string, ContatoDaLista[]>();
  const porTelefone = new Map<string, ContatoDaLista[]>();
  for (const k of contatos) {
    porId.set(k.id, [...(porId.get(k.id) ?? []), k]);
    if (k.telefone) porTelefone.set(k.telefone, [...(porTelefone.get(k.telefone) ?? []), k]);
  }
  return candidatos.map((c) => {
    const achados = [
      ...(c.contact_id ? (porId.get(c.contact_id) ?? []) : []),
      ...telefonesDaEmpresa(c).flatMap((t) => porTelefone.get(t) ?? []),
    ];
    return { ...c, contatos: achados };
  });
}

/**
 * As colunas do arquivo, na ordem do modelo de importação. Cada nome existe em
 * `COLUNAS` de `planilha.ts` (nenhuma coluna que o importador descartaria em
 * silêncio). A lista inteira acrescenta `COLUNA_DA_SITUACAO` no FIM: o
 * importador não a reconhece e a lista como coluna ignorada — ela informa, não
 * é dado da empresa.
 */
export const COLUNAS_DA_LISTA = [
  "empresa",
  "telefone",
  "site",
  "segmento",
  "endereco",
  "email",
  "redes",
] as const;

export const COLUNA_DA_SITUACAO = "situacao";

/**
 * As duas colunas da MARCA do que já foi tentado (#4632), no fim do arquivo
 * completo. `abordada_em` é a data (`AAAA-MM-DD`) e `campanha_anterior` é a
 * campanha em que a abordagem saiu — o par que responde "esta empresa já foi
 * tentada, quando e por qual oferta" sem precisar de lista paralela.
 */
export const COLUNA_DA_ABORDAGEM = "abordada_em";
export const COLUNA_DA_CAMPANHA_ANTERIOR = "campanha_anterior";

const SEPARADOR = ";";

/**
 * Telefone E.164 passa intacto pela neutralização de fórmula: o `'` na frente
 * de `+5511…` quebraria o `normalizeProspectPhone` na reimportação — o número
 * viraria linha recusada.
 */
const TELEFONE_FORMATADO = /^\+[\d\s().-]+$/;

function neutralizarFormula(trecho: string): string {
  if (!/^[=+\-@\t\r]/.test(trecho)) return trecho;
  if (TELEFONE_FORMATADO.test(trecho)) return trecho;
  return `'${trecho}`;
}

/**
 * RFC 4180 com `;` de separador (Excel em pt-BR) e célula que começa com
 * caractere de fórmula neutralizada — a mesma regra do export de contatos
 * (`lib/contacts/exportar.ts`). Quebra de linha no meio do texto sai entre
 * aspas, senão vira linha nova no leitor que não conhece aspas.
 */
function celula(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  const texto = neutralizarFormula(String(valor).replace(/\s+/g, " ").trim());
  if (texto.includes(SEPARADOR) || texto.includes('"') || /[\n\r]/.test(texto)) {
    return `"${texto.replace(/"/g, '""')}"`;
  }
  return texto;
}

/** Os valores de uma linha, na ordem de `COLUNAS_DA_LISTA`. */
function valoresDaEmpresa(c: CandidatoDaLista): string[] {
  const emails = (c.data.emails ?? []).filter(Boolean).slice(0, 5).join(" ");
  const redes = (c.data.socials ?? []).filter(Boolean).slice(0, 15).join(" ");
  return [
    c.data.name ?? "",
    c.data.phone ?? c.phone ?? "",
    c.data.website ?? "",
    c.data.category ?? "",
    c.data.address ?? "",
    emails,
    redes,
  ];
}

/**
 * O arquivo inteiro. Começa com BOM porque é o que faz o Excel em português
 * abrir o acento certo, e o importador já remove BOM (`decodificarCsv`).
 *
 * Lista vazia devolve só o cabeçalho: quem decide recusar um arquivo sem
 * empresa é a rota, com mensagem — um CSV de zero linha não explica nada.
 */
export function csvDaLista(
  candidatos: readonly CandidatoDaLista[],
  opcoes: {
    comSituacao?: boolean;
    /**
     * Acrescenta a MARCA do que já foi tentado (`abordada_em` e
     * `campanha_anterior`) — só faz sentido junto da lista inteira, porque quem
     * nunca foi abordado sai com as duas colunas vazias.
     */
    comAbordagem?: boolean;
    /** O nome da campanha exportada: a campanha da abordagem quando a trilha não tem a passagem. */
    nomeDaCampanha?: string;
    /** O fuso IANA da organização: o dia de `abordada_em`. Sem ele, o padrão do produto. */
    fuso?: string;
    /**
     * A situação no idioma de quem vai ler a planilha. A rota passa o idioma da
     * organização; o padrão é o português, como os nomes das colunas.
     */
    rotuloDaSituacao?: (situacao: SituacaoDaEmpresa) => string;
  } = {},
): string {
  const comSituacao = opcoes.comSituacao === true;
  const comAbordagem = opcoes.comAbordagem === true;
  const nomeDaCampanha = opcoes.nomeDaCampanha ?? "";
  const fuso = opcoes.fuso ?? "";
  const rotulo = opcoes.rotuloDaSituacao ?? ((s: SituacaoDaEmpresa) => s);
  const cabecalho = [
    ...COLUNAS_DA_LISTA,
    ...(comSituacao ? [COLUNA_DA_SITUACAO] : []),
    ...(comAbordagem ? [COLUNA_DA_ABORDAGEM, COLUNA_DA_CAMPANHA_ANTERIOR] : []),
  ];
  const linhas = [
    cabecalho.join(SEPARADOR),
    ...candidatos.map((c) =>
      [
        ...valoresDaEmpresa(c),
        ...(comSituacao ? [rotulo(situacaoDaEmpresa(c))] : []),
        ...(comAbordagem ? [dataDaAbordagem(c, fuso), campanhaDaAbordagem(c, nomeDaCampanha)] : []),
      ]
        .map(celula)
        .join(SEPARADOR),
    ),
  ];
  return `\uFEFF${linhas.join("\r\n")}\r\n`;
}

/**
 * `lista-<campanha>-AAAA-MM-DD.csv` (ou `lista-completa-…` para a lista
 * inteira), sem acento, espaço nem aspas no nome. Os dois arquivos baixados no
 * mesmo dia não se sobrescrevem na pasta de downloads.
 */
export function nomeDoArquivoDaLista(
  nomeDaCampanha: string,
  agora: Date,
  quem: QualLista = "nao_abordadas",
): string {
  const dia = agora.toISOString().slice(0, 10);
  const apelido = nomeDaCampanha
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `lista-${quem === "todas" ? "completa-" : ""}${apelido || "prospeccao"}-${dia}.csv`;
}

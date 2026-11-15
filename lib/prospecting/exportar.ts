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

/** O mínimo de um candidato que a régua e o CSV leem (`prospecting_candidates`). */
// `type` e não `interface`: `pg` exige `Record<string, any>` no genérico do
// `query<>`, e só o alias ganha índice implícito.
export type CandidatoDaLista = {
  status?: string;
  attempted_at?: string | Date | null;
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
     * A situação no idioma de quem vai ler a planilha. A rota passa o idioma da
     * organização; o padrão é o português, como os nomes das colunas.
     */
    rotuloDaSituacao?: (situacao: SituacaoDaEmpresa) => string;
  } = {},
): string {
  const comSituacao = opcoes.comSituacao === true;
  const rotulo = opcoes.rotuloDaSituacao ?? ((s: SituacaoDaEmpresa) => s);
  const cabecalho = comSituacao ? [...COLUNAS_DA_LISTA, COLUNA_DA_SITUACAO] : [...COLUNAS_DA_LISTA];
  const linhas = [
    cabecalho.join(SEPARADOR),
    ...candidatos.map((c) =>
      (comSituacao ? [...valoresDaEmpresa(c), rotulo(situacaoDaEmpresa(c))] : valoresDaEmpresa(c))
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

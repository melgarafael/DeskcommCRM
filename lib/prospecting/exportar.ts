/**
 * A LISTA DA CAMPANHA DE VOLTA PARA QUEM OPERA (issue #4360).
 *
 * O produto sabia importar uma lista e não sabia devolvê-la: quem buscou 80
 * empresas, iniciou a campanha e quis a mesma lista com outra estratégia (outro
 * agente, outro número, outra instrução) ficava sem caminho — a tela só mostra
 * os candidatos e não há botão de saída.
 *
 * ─── O que sai, e por que só as não abordadas ────────────────────────────────
 *
 * Sai a lista das empresas que AINDA PODEM ser abordadas: as que nunca tiveram
 * tentativa (`attempted_at` nulo), continuam na fila (`new`/`queued`) e têm
 * telefone com WhatsApp. Quem já foi abordado fica de fora de propósito — não é
 * economia de linha, é honestidade: a mensagem já saiu, o contato e o negócio já
 * existem no CRM, e a triagem de qualquer campanha nova recusaria a empresa com
 * "Contato já existe no CRM" (`store.ts`, `triarCandidato`). Um arquivo com
 * quem já foi abordado prometeria uma reimportação que não acontece.
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

/** O mínimo de um candidato que a régua e o CSV leem (`prospecting_candidates`). */
// `type` e não `interface`: `pg` exige `Record<string, any>` no genérico do
// `query<>`, e só o alias ganha índice implícito.
export type CandidatoDaLista = {
  status?: string;
  attempted_at?: string | Date | null;
  /** Coluna `phone` da linha; `data.phone` é a mesma coisa no caminho da busca. */
  phone?: string | null;
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

export interface ResumoDaLista {
  total: number;
  nao_abordadas: number;
}

/** Quantas ainda podem ser abordadas, sobre a lista INTEIRA da campanha. */
export function resumoDaLista(candidatos: readonly CandidatoDaLista[]): ResumoDaLista {
  return {
    total: candidatos.length,
    nao_abordadas: candidatos.filter(naoAbordada).length,
  };
}

/**
 * As colunas do arquivo, na ordem do modelo de importação. Cada nome existe em
 * `COLUNAS` de `planilha.ts` (nenhuma coluna que o importador descartaria em
 * silêncio).
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
export function csvDaLista(candidatos: readonly CandidatoDaLista[]): string {
  const linhas = [
    COLUNAS_DA_LISTA.join(SEPARADOR),
    ...candidatos.map((c) => valoresDaEmpresa(c).map(celula).join(SEPARADOR)),
  ];
  return `\uFEFF${linhas.join("\r\n")}\r\n`;
}

/** `lista-<campanha>-AAAA-MM-DD.csv`, sem acento, espaço nem aspas no nome. */
export function nomeDoArquivoDaLista(nomeDaCampanha: string, agora: Date): string {
  const dia = agora.toISOString().slice(0, 10);
  const apelido = nomeDaCampanha
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `lista-${apelido || "prospeccao"}-${dia}.csv`;
}

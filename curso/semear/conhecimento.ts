/**
 * Semente do módulo "Conhecimento" (Agente de IA › Ver tudo em IA › Conhecimento,
 * /app/ai/knowledge/sources): o acervo da Clínica Bem Viver nos estados que o
 * indexador (workers/rag-indexer.ts) realmente grava.
 *
 * A história que a tela conta: a clínica preparou material com uma chave da
 * OpenAI; a chave foi recusada pelo provedor ("Pacotes de fisioterapia e
 * pilates" não entrou) e deixou de ser utilizável; o material cadastrado depois
 * ("Valores das consultas particulares") ficou esperando a chave. A bancada não
 * tem credencial de embedding, e esta semente NÃO cria nenhuma: uma credencial
 * apareceria nas telas de Credenciais e Provedores dos outros módulos. As
 * versões de índice gravadas com `openai/text-embedding-3-small` fazem a tela
 * dizer, como o produto diz, que a base é preparada pela OpenAI e que falta a
 * chave dela.
 *
 * Nenhum assistente consulta estes materiais (o agente da base não é tocado):
 * o selo "Consultado por" mostra "nenhum assistente ainda".
 *
 * Idempotente: apaga só as próprias linhas (ids fixos d1160000-…, e os materiais
 * que as lições criam pela tela, pelo nome) e recria. Apagar a fonte leva junto,
 * por cascata, os pares de pergunta e resposta, as versões de índice e os trechos.
 */
import { createHash } from "node:crypto";

import { chunkText, computeContentHash } from "../../lib/ai/rag/chunker";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, ha, semErro } from "../semear-demonstracao";

const BUCKET = "ai-policy"; // BUCKET_DE_CONHECIMENTO (lib/ai/rag/ingest/documento.ts)
const MODELO = "openai/text-embedding-3-small"; // MODELO_DE_EMBEDDING (lib/ai/embeddings/chave.ts)
const DIAS = 24 * 60;

const id = (bloco: string, n: number) => `${bloco}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fonteId = (n: number) => id("d1160000", n);
const itemId = (n: number) => id("d1160100", n);
const versaoId = (n: number) => id("d1160200", n);
const trechoId = (n: number) => id("d1160300", n);
const ARQUIVO_DO_PREPARO = `${id("d1160400", 1)}.md`;

/** Nomes que as lições criam pela tela: apagados aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = ["Primeira consulta de nutrição"];

/** O que o indexador grava quando a organização não tem chave (workers/rag-indexer.ts). */
const MOTIVO_SEM_CHAVE =
  "Falta uma chave de embedding para indexar. Cadastre uma chave OpenAI ou OpenRouter " +
  "em IA › Credenciais e este material entra sozinho.";
/** A resposta da OpenAI a uma chave revogada, como o embedTexts a repassa (lote de 4 trechos). */
const RECUSA_DA_OPENAI =
  "Incorrect API key provided: sk-proj-********************************************Xq7w. " +
  "You can find your API key at https://platform.openai.com/account/api-keys.";

type Par = { q: string; a: string };

const FAQ_DA_RECEPCAO: Par[] = [
  { q: "Qual o horário de funcionamento da clínica?", a: "De segunda a sexta, das 7h às 19h, e aos sábados, das 8h às 12h." },
  { q: "Onde fica a clínica?", a: "Na Rua das Acácias, 120 — 3º andar, Vila Mariana, São Paulo. Há estacionamento conveniado no prédio ao lado." },
  { q: "Vocês atendem por convênio?", a: "Sim, nas consultas médicas: Unimed, Bradesco Saúde e SulAmérica. Fisioterapia, nutrição e pilates são só particulares." },
  { q: "Como faço para remarcar uma consulta?", a: "Avise com pelo menos 24 horas de antecedência, por aqui mesmo no WhatsApp. A remarcação não tem custo." },
  { q: "Quais as formas de pagamento?", a: "Pix, cartão de débito e cartão de crédito em até 3 vezes sem juros." },
];

const PACOTES: Par[] = [
  { q: "Quanto custa o pacote de fisioterapia?", a: "O pacote de 10 sessões sai por R$ 1.200, e a sessão avulsa, R$ 140." },
  { q: "As aulas de pilates são em grupo?", a: "Sim, em turmas de até 4 alunos. Também há aula individual, com horário marcado." },
  { q: "Preciso de pedido médico para a fisioterapia?", a: "Não é obrigatório, mas ajuda: traga o pedido e os exames na primeira sessão." },
  { q: "Dá para trocar o horário da aula de pilates?", a: "Sim, avisando com 12 horas de antecedência, dentro do mesmo mês." },
];

const VALORES: Par[] = [
  { q: "Quanto custa a consulta com a nutricionista?", a: "A primeira consulta custa R$ 250. O retorno, em até 30 dias, custa R$ 150." },
  { q: "Quanto custa a consulta de clínica geral?", a: "R$ 300, com retorno gratuito em até 15 dias." },
  { q: "Vocês dão recibo para reembolso do plano?", a: "Sim. O recibo sai no dia da consulta, com os dados que o plano pede." },
];

const FIM_DE_ANO: Par[] = [
  { q: "A clínica abre entre o Natal e o Ano-Novo?", a: "Em 2025, a clínica fecha de 24/12 a 1º/1 e reabre no dia 2 de janeiro." },
  { q: "Quem atende nos plantões de fim de ano?", a: "Só a recepção, pelo WhatsApp, das 9h às 12h." },
];

const PREPARO_PARA_EXAMES = `# Preparo para exames

## Exame de sangue
Jejum de 8 horas. Pode beber água normalmente. Tome os remédios de uso contínuo, a não ser que o médico tenha dito o contrário.

## Ultrassom de abdome
Jejum de 6 horas e bexiga cheia: beba 4 copos de água uma hora antes e não urine até o exame.

## Eletrocardiograma
Não precisa de jejum. Evite passar creme ou óleo no peito no dia do exame.

## No dia do exame
Chegue 15 minutos antes e traga um documento com foto, o pedido médico e a carteirinha do convênio, se tiver.`;

/** Vetor de 1536 posições, determinístico e normalizado: a coluna exige o vetor, e ninguém o lê na tela. */
function vetor(texto: string): string {
  const v: number[] = [];
  let bloco = createHash("sha256").update(texto).digest();
  while (v.length < 1536) {
    for (let i = 0; i + 1 < bloco.length && v.length < 1536; i += 2) v.push((bloco.readUInt16BE(i) / 65535) * 2 - 1);
    bloco = createHash("sha256").update(bloco).digest();
  }
  const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return `[${v.map((x) => (x / norma).toFixed(6)).join(",")}]`;
}

const traduzir = (pares: Par[]) => pares.map((p) => ({ q: demo(p.q), a: demo(p.a) }));

/**
 * A base chama antes de QUALQUER aula: um acervo que sobra apaga o aviso
 * "sem acervo" que a aula de Agentes fotografa.
 */
export async function limpar(c: Contexto) {
  const { db, org } = c;
  const criadas = ((await db
    .from("ai_knowledge_sources")
    .select("id, source_metadata")
    .eq("organization_id", org)
    .in("name", CRIADAS_NAS_LICOES.map(demo))).data ?? []) as Array<{ id: string; source_metadata: { blob_path?: string } | null }>;
  const arquivosCriados = criadas.map((f) => f.source_metadata?.blob_path).filter((p): p is string => typeof p === "string");
  if (arquivosCriados.length) await db.storage.from(BUCKET).remove(arquivosCriados);
  if (criadas.length)
    semErro(await db.from("ai_knowledge_sources").delete().eq("organization_id", org).in("id", criadas.map((f) => f.id)), "limpar materiais das lições");
  semErro(
    await db.from("ai_knowledge_sources").delete().eq("organization_id", org).in("id", [1, 2, 3, 4, 5].map(fonteId)),
    "limpar materiais",
  );
  await db.storage.from(BUCKET).remove([`${org}/${ARQUIVO_DO_PREPARO}`]);
}

export async function semear(c: Contexto) {
  const { db, org } = c;
  await limpar(c);

  // ---------- o texto colado vira arquivo .md no Storage, como o POST grava ----------
  const caminhoDoPreparo = `${org}/${ARQUIVO_DO_PREPARO}`;
  const textoDoPreparo = demo(PREPARO_PARA_EXAMES);
  const envio = await db.storage
    .from(BUCKET)
    .upload(caminhoDoPreparo, Buffer.from(textoDoPreparo, "utf8"), { contentType: "text/markdown", upsert: true });
  if (envio.error) throw new Error(`guardar o texto do Preparo para exames: ${envio.error.message}`);

  // ---------- os materiais ----------
  const recepcao = traduzir(FAQ_DA_RECEPCAO);
  const pacotes = traduzir(PACOTES);
  const valores = traduzir(VALORES);
  const fimDeAno = traduzir(FIM_DE_ANO);

  // trechos como o indexador os monta (pedacosDeFaq / pedacosDeDocumento)
  const trechosDeFaq = (pares: { q: string; a: string }[]) =>
    pares.flatMap((p) =>
      chunkText(`Pergunta: ${p.q}\nResposta: ${p.a}`).map((content) => ({ content, metadata: { source_type: "faq", pergunta: p.q } })),
    );
  const trechosDoPreparo = chunkText(textoDoPreparo.trim(), { maxChars: 1600, overlapChars: 200 }).map((content) => ({
    content,
    metadata: { source_type: "documento", arquivo: ARQUIVO_DO_PREPARO, extensao: "md" },
  }));

  type Pronto = { n: number; trechos: { content: string; metadata: Record<string, unknown> }[]; tipo: string; preparadoHa: number };
  const PRONTOS: Pronto[] = [
    { n: 1, trechos: trechosDeFaq(recepcao), tipo: "faq", preparadoHa: 9 * DIAS },
    { n: 2, trechos: trechosDoPreparo, tipo: "documento", preparadoHa: 12 * DIAS },
    { n: 5, trechos: trechosDeFaq(fimDeAno), tipo: "faq", preparadoHa: 300 * DIAS },
  ];
  const hashDe = (p: Pronto) => computeContentHash(p.trechos.map((t) => t.content).join("\n---\n"));
  const pronto = (n: number) => PRONTOS.find((p) => p.n === n)!;

  const FONTES = [
    {
      n: 1, name: demo("Perguntas frequentes da recepção"), source_type: "faq", criadoHa: 9 * DIAS,
      status: "ready", is_active: true, source_metadata: {},
      last_index_status: "success", last_index_error: null, last_indexed_at: ha(9 * DIAS - 1),
      chunks_count: pronto(1).trechos.length, content_hash: hashDe(pronto(1)),
    },
    {
      n: 2, name: demo("Preparo para exames"), source_type: "documento", criadoHa: 12 * DIAS,
      status: "ready", is_active: true, source_metadata: { blob_path: caminhoDoPreparo, ext: "md", origem: "texto_colado" },
      last_index_status: "success", last_index_error: null, last_indexed_at: ha(12 * DIAS - 1),
      chunks_count: pronto(2).trechos.length, content_hash: hashDe(pronto(2)),
    },
    {
      n: 3, name: demo("Pacotes de fisioterapia e pilates"), source_type: "faq", criadoHa: 4 * DIAS,
      status: "ready", is_active: true, source_metadata: {},
      last_index_status: "failed", last_index_error: `embedding falhou no lote 0-3: ${RECUSA_DA_OPENAI}`, last_indexed_at: null,
      chunks_count: 0, content_hash: null,
    },
    {
      n: 4, name: demo("Valores das consultas particulares"), source_type: "faq", criadoHa: 26 * 60,
      status: "ready", is_active: true, source_metadata: {},
      last_index_status: "sem_credencial", last_index_error: MOTIVO_SEM_CHAVE, last_indexed_at: null,
      chunks_count: 0, content_hash: null,
    },
    {
      n: 5, name: demo("Horários de fim de ano 2025"), source_type: "faq", criadoHa: 300 * DIAS,
      status: "archived", is_active: false, source_metadata: {},
      last_index_status: "success", last_index_error: null, last_indexed_at: ha(300 * DIAS - 1),
      chunks_count: pronto(5).trechos.length, content_hash: hashDe(pronto(5)),
    },
  ];

  semErro(
    await db.from("ai_knowledge_sources").insert(
      FONTES.map(({ n, criadoHa, ...f }) => ({
        ...f,
        id: fonteId(n),
        organization_id: org,
        agent_id: null, // o diálogo da tela não manda agente: o material é da organização
        ingested_at: ha(criadoHa),
        created_at: ha(criadoHa),
        // o arquivado mudou depois de criado; os outros, quando o indexador os marcou
        updated_at: n === 5 ? ha(40 * DIAS) : ha(Math.max(criadoHa - 2, 0)),
      })),
    ),
    "materiais",
  );

  // ---------- pares de pergunta e resposta (ai_faq_items), na ordem cadastrada ----------
  let nItem = 0;
  const itens = (
    [
      [1, recepcao, 9 * DIAS],
      [3, pacotes, 4 * DIAS],
      [4, valores, 26 * 60],
      [5, fimDeAno, 300 * DIAS],
    ] as const
  ).flatMap(([n, pares, criadoHa]) =>
    pares.map((p, position) => ({
      id: itemId(++nItem),
      organization_id: org,
      knowledge_source_id: fonteId(n),
      question: p.q,
      answer: p.a,
      tags: [],
      locale: "pt-BR", // o padrão do POST /api/v1/ai/knowledge/sources
      position,
      created_at: ha(criadoHa),
      updated_at: ha(criadoHa),
    })),
  );
  semErro(await db.from("ai_faq_items").insert(itens), "perguntas e respostas");

  // ---------- versões de índice: as prontas ativas, a recusada como falha ----------
  semErro(
    await db.from("ai_knowledge_versions").insert([
      ...PRONTOS.map((p) => ({
        id: versaoId(p.n),
        organization_id: org,
        agent_id: null,
        knowledge_source_id: fonteId(p.n),
        version_number: 1,
        description: `Indexação de ${p.tipo}`,
        status: "ready",
        is_active: true,
        total_chunks: p.trechos.length,
        embedding_model: MODELO,
        embedding_dims: 1536,
        created_at: ha(p.preparadoHa),
        indexed_at: ha(p.preparadoHa - 1),
        activated_at: ha(p.preparadoHa - 1),
      })),
      {
        id: versaoId(3),
        organization_id: org,
        agent_id: null,
        knowledge_source_id: fonteId(3),
        version_number: 1,
        description: "Indexação de faq",
        status: "failed",
        is_active: false,
        total_chunks: 0,
        embedding_model: MODELO,
        embedding_dims: 1536,
        error_message: `embed@lote 0-3: ${RECUSA_DA_OPENAI}`,
        created_at: ha(4 * DIAS - 1),
      },
    ]),
    "versões de índice",
  );

  // ---------- trechos (ai_chunks) das versões ativas ----------
  let nTrecho = 0;
  const trechos = PRONTOS.flatMap((p) =>
    p.trechos.map((t, position) => ({
      id: trechoId(++nTrecho),
      organization_id: org,
      kb_version_id: versaoId(p.n),
      knowledge_source_id: fonteId(p.n),
      position,
      content: t.content,
      content_hash: computeContentHash(t.content),
      token_count: Math.ceil(t.content.length / 4), // estimateTokens (lib/ai/runtime/history.ts)
      embedding: vetor(t.content),
      metadata: t.metadata,
      created_at: ha(p.preparadoHa - 1),
    })),
  );
  semErro(await db.from("ai_chunks").insert(trechos), "trechos");

  for (const p of PRONTOS)
    semErro(
      await db.from("ai_knowledge_sources").update({ active_kb_version_id: versaoId(p.n) }).eq("organization_id", org).eq("id", fonteId(p.n)),
      "versão ativa",
    );
}

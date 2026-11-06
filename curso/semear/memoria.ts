/**
 * Semente do módulo "Memória" (Agente de IA › Ver tudo em IA › Memória,
 * /app/ai/memory): a memória geral da Clínica Bem Viver, nos estados que a tela
 * mostra.
 *
 * - Documento da organização com duas versões publicadas (v1 antiga e v2 ativa),
 *   para o histórico ter o que mostrar e a lição de restaurar ter para onde voltar.
 * - Aprendizados nas três origens que a tela rotula (`manual`, `flywheel` =
 *   "aprendido automaticamente", `agent` = "anotado pelo agente") e um arquivado,
 *   para o link "Ver aprendizados arquivados" existir.
 *
 * O aprendizado `flywheel` é gravado como `lib/ai/apply-proposal.ts` grava: o
 * título é o começo do texto, cortado em 77 caracteres + "..." quando passa de 80.
 * Sem proposta de origem (`proposal_id` nulo): a tela não a mostra.
 *
 * Idempotente: apaga só as próprias linhas (ids fixos d1170000-… e d1170100-…,
 * a versão que a lição publica, pelo conteúdo, e o aprendizado que a lição cria,
 * pelo título) e recria. O ponteiro da memória é um por organização e só esta
 * tela o move; ele é apagado antes das versões porque a chave estrangeira não
 * deixa apagar a versão ativa, e recriado apontando para a v2.
 */
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";
import { type Contexto, ha, semErro } from "../semear-demonstracao";

const DIAS = 24 * 60;
const id = (bloco: string, n: number) => `${bloco}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const versaoId = (n: number) => id("d1170000", n);
const aprendizadoId = (n: number) => id("d1170100", n);

const DOCUMENTO_V1 = [
  "Você atende pela Clínica Bem Viver, na Rua das Acácias, 120 — 3º andar, Vila Mariana, São Paulo.",
  "Horário de atendimento: segunda a sexta, das 7h às 19h, e sábado, das 8h às 12h.",
  "Chame o paciente pelo primeiro nome e escreva frases curtas.",
].join("\n");

const DOCUMENTO_V2 = [
  DOCUMENTO_V1,
  "Nunca dê diagnóstico nem indique remédio. Se o paciente contar uma dor forte ou um sintoma grave, oriente procurar um pronto-socorro.",
  "Não prometa desconto. Valores e convênios, confirme com a recepção antes de responder.",
].join("\n");

/** O texto que a lição "Escrever e publicar" digita e publica como v3 (curso/licoes/memoria.json). */
const DOCUMENTO_DA_LICAO = [
  DOCUMENTO_V2,
  "Para remarcar uma consulta, peça aviso de pelo menos 24 horas. A remarcação não tem custo.",
].join("\n");

/** Títulos que as lições criam pela tela: apagados aqui para cada lição partir do mesmo estado. */
const CRIADAS_NAS_LICOES = ["Retorno em até 30 dias não é cobrado"];

/** Como `applyProposal` titula o aprendizado aprovado de uma proposta. */
const tituloDaProposta = (texto: string) => (texto.length > 80 ? `${texto.slice(0, 77)}...` : texto);

/** O texto em PT e no idioma da captura: a rodada anterior pode ter sido no outro idioma. */
const nosDoisIdiomas = (textos: string[]) => [...new Set([...textos, ...textos.map((t) => demo(t))])];

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  // ---------- documento da organização ----------
  semErro(await db.from("org_memory_pointers").delete().eq("organization_id", org), "limpar ponteiro da memória");
  const VERSOES = [
    { n: 1, version_number: 1, content: DOCUMENTO_V1, criadaHa: 34 * DIAS + 185 },
    { n: 2, version_number: 2, content: DOCUMENTO_V2, criadaHa: 6 * DIAS + 70 },
  ];
  semErro(
    await db.from("org_memory_versions").delete().eq("organization_id", org).in("id", VERSOES.map((v) => versaoId(v.n))),
    "limpar versões da memória",
  );
  semErro(
    await db.from("org_memory_versions").delete().eq("organization_id", org).in("content", nosDoisIdiomas([DOCUMENTO_DA_LICAO])),
    "limpar versão publicada na lição",
  );
  semErro(
    await db.from("org_memory_versions").insert(
      VERSOES.map((v) => ({
        id: versaoId(v.n),
        organization_id: org,
        version_number: v.version_number,
        content: demo(v.content),
        created_by: pessoa.helena,
        created_at: ha(v.criadaHa),
      })),
    ),
    "versões da memória",
  );
  semErro(
    await db
      .from("org_memory_pointers")
      .insert({ organization_id: org, version_id: versaoId(2), updated_at: ha(6 * DIAS + 70) }),
    "ponteiro da memória",
  );

  // ---------- aprendizados ----------
  const textoAutomatico = demo(
    "Quando o paciente perguntar se o exame de sangue precisa de jejum, responda: jejum de 8 horas, e pode beber água.",
  );
  const APRENDIZADOS = [
    {
      n: 1,
      title: demo("Pacientes do pilates preferem o fim da tarde"),
      body: demo(
        "Nas últimas conversas, quase todos os pedidos de aula experimental de pilates foram para depois das 17h. Ofereça primeiro os horários do fim da tarde.",
      ),
      source: "agent",
      status: "active",
      created_by: null,
      criadoHa: 1 * DIAS + 140,
    },
    {
      n: 2,
      title: tituloDaProposta(textoAutomatico),
      body: textoAutomatico,
      source: "flywheel",
      status: "active",
      created_by: pessoa.helena,
      criadoHa: 3 * DIAS + 300,
    },
    {
      n: 3,
      title: demo("Estacionamento conveniado"),
      body: demo(
        "O estacionamento conveniado fica no prédio ao lado. Com o carimbo da recepção, a primeira hora é grátis.",
      ),
      source: "manual",
      status: "active",
      created_by: pessoa.helena,
      criadoHa: 10 * DIAS + 45,
    },
    {
      n: 4,
      title: demo("Primeira aula de pilates grátis"),
      body: demo("Durante a promoção de inverno, a primeira aula experimental de pilates não é cobrada."),
      source: "manual",
      status: "archived",
      created_by: pessoa.helena,
      criadoHa: 40 * DIAS + 200,
    },
  ];
  semErro(
    await db.from("org_memory_entries").delete().eq("organization_id", org).in("id", APRENDIZADOS.map((a) => aprendizadoId(a.n))),
    "limpar aprendizados",
  );
  semErro(
    await db.from("org_memory_entries").delete().eq("organization_id", org).in("title", nosDoisIdiomas(CRIADAS_NAS_LICOES)),
    "limpar aprendizados das lições",
  );
  semErro(
    await db.from("org_memory_entries").insert(
      APRENDIZADOS.map(({ n, criadoHa, ...a }) => ({
        ...a,
        id: aprendizadoId(n),
        organization_id: org,
        created_at: ha(criadoHa),
        // o arquivado mudou de estado depois de criado; os ativos, nunca
        updated_at: a.status === "archived" ? ha(12 * DIAS) : ha(criadoHa),
      })),
    ),
    "aprendizados",
  );
}

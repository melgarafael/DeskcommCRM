/**
 * Semente do módulo "Skills" (Agente de IA › Ver tudo em IA › Skills).
 *
 * Uma instalação fresca já traz o catálogo da plataforma (`objecao-preco` e
 * `agendamento`, ponteiros com organization_id NULL, do baseline), mas nenhuma
 * skill instalada na organização — a tela vazia não ensina a lista, o editor,
 * o histórico nem o aviso de versão nova. Aqui a Clínica Bem Viver ganha:
 *
 *  - `agendamento`, instalada do catálogo há dois meses, quando o catálogo ainda
 *    estava numa versão ANTERIOR (a cópia aponta, em `forked_from_version_id`, para
 *    uma versão antiga real de plataforma, que o próprio baseline gravou). Depois a
 *    clínica editou a cópia e acrescentou duas palavras-chave. Resultado na tela:
 *    selo "do catálogo", histórico com duas versões e o aviso "Há uma versão nova
 *    desta skill no catálogo", com o comparativo do que muda ao adotar.
 *  - `preparo-primeira-consulta`, enviada pela clínica num .zip (selo "manual"),
 *    com uma etiqueta de ativação que existe na base (`primeira-consulta`, no
 *    contato da Mariana Souza).
 *  - `objecao-preco` fica SEM cópia: continua no "Catálogo", com o botão "Instalar".
 *
 * As lições instalam `objecao-preco`, editam `preparo-primeira-consulta` e adotam a
 * versão nova de `agendamento` pela tela — cada uma grava versão nova com id
 * aleatório. Por isso a limpeza apaga, desta organização, os ponteiros e as versões
 * com esses nomes (ninguém mais semeia skill: a base não tem skill instalada).
 * `skill_versions` é imutável para UPDATE, mas DELETE é permitido (o trigger só veta
 * UPDATE); nenhuma versão da organização aponta para outra da organização, então o
 * `on delete set null` de `forked_from_version_id` não toca linha nenhuma.
 *
 * As linhas de PLATAFORMA (organization_id NULL) só são lidas, nunca escritas.
 */
import { type Contexto, exigir, ha, semErro } from "../semear-demonstracao";
import { textoDaDemonstracao as demo } from "../espanhol-demonstracao";

const versaoId = (n: number) => `d1180000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DIA = 24 * 60;

const AGENDAMENTO = "agendamento";
const OBJECAO = "objecao-preco";
const PREPARO_PT = "preparo-primeira-consulta";

/** Etiqueta de CONTATO que a base grava (sem tradução) na Mariana Souza. */
const ETIQUETA_DA_BASE = "primeira-consulta";

/** Corpo da skill enviada pela clínica: uma linha por entrada do catálogo de espanhol. */
const CORPO_PREPARO = [
  "# Preparo para a primeira consulta",
  "",
  "## Quando usar",
  "O paciente vai à Clínica Bem Viver pela primeira vez e pergunta o que levar ou como se preparar.",
  "",
  "## O que fazer",
  "1. Pergunte se a consulta é de nutrição ou de fisioterapia.",
  "2. Peça para chegar 15 minutos antes, para o cadastro na recepção.",
  "3. Lembre o paciente de trazer documento com foto e, se for pelo convênio, a carteirinha.",
  "4. Fisioterapia: peça para vir com roupa confortável.",
  "5. Nutrição: peça os exames de sangue dos últimos 6 meses, se o paciente tiver.",
  "6. Jejum: explique que não é preciso jejum para a primeira consulta.",
  "",
  "## O que não fazer",
  "- Não confirme a cobertura do convênio: diga que a recepção confere na chegada.",
  "- Não dê orientação de saúde: isso é com o profissional, na consulta.",
];

const PALAVRAS_PREPARO = [
  "primeira consulta",
  "primeira vez",
  "o que levar",
  "o que preciso levar",
  "carteirinha",
  "convênio",
];

/** Palavras-chave que a clínica acrescentou à sua cópia de `agendamento`. */
const PALAVRAS_DA_CLINICA = ["avaliação", "encaixe"];

type Matcher = { any_keywords: string[]; probe_keywords?: string[]; any_tags?: string[] };
type VersaoDePlataforma = { id: string; description: string; body: string; matcher: Matcher; created_at: string };

export async function semear(c: Contexto) {
  const { db, org } = c;
  const preparo = demo(PREPARO_PT);

  // 1) Limpeza: só as skills que este módulo semeia ou que as lições gravam pela tela.
  //    O nome em PT e o traduzido entram os dois, para a troca de idioma não deixar resto.
  const NOMES = [...new Set([AGENDAMENTO, OBJECAO, PREPARO_PT, preparo])];
  semErro(
    await db.from("skill_pointers").delete().eq("organization_id", org).in("name", NOMES),
    "apagar ponteiros de skill da organização",
  );
  semErro(
    await db.from("skill_versions").delete().eq("organization_id", org).in("name", NOMES),
    "apagar versões de skill da organização",
  );

  // 2) A versão de plataforma ATUAL de `agendamento` e uma ANTERIOR a ela (o baseline
  //    grava as três publicações do catálogo; só a última recebe o ponteiro).
  const ponteiro = exigir(
    await db.from("skill_pointers").select("version_id").is("organization_id", null).eq("name", AGENDAMENTO).maybeSingle(),
    "ponteiro de plataforma de agendamento",
  ) as { version_id: string };
  const versoes = exigir(
    await db
      .from("skill_versions")
      .select("id, description, body, matcher, created_at")
      .is("organization_id", null)
      .eq("name", AGENDAMENTO)
      .order("created_at", { ascending: true }),
    "versões de plataforma de agendamento",
  ) as VersaoDePlataforma[];
  const antiga = versoes.find((v) => v.id !== ponteiro.version_id);
  if (!antiga) {
    throw new Error(
      "o catálogo não tem versão anterior de 'agendamento' — o aviso de versão nova não tem como aparecer nesta instalação",
    );
  }
  // A lição de instalar precisa de `objecao-preco` no catálogo: sem ela, falha aqui, alto.
  exigir(
    await db.from("skill_pointers").select("name").is("organization_id", null).eq("name", OBJECAO).maybeSingle(),
    "ponteiro de plataforma de objecao-preco",
  );

  // 3) `agendamento`: a cópia instalada (texto da versão antiga do catálogo) e a edição
  //    da clínica, que acrescentou palavras-chave. O ponteiro aponta para a edição.
  const palavrasDaClinica = PALAVRAS_DA_CLINICA.map((p) => demo(p));
  const instalada = ha(60 * DIA);
  const editada = ha(15 * DIA);
  semErro(
    await db.from("skill_versions").insert([
      {
        id: versaoId(1),
        organization_id: org,
        name: AGENDAMENTO,
        description: antiga.description,
        body: antiga.body,
        matcher: antiga.matcher,
        manifest: [],
        forked_from_version_id: antiga.id,
        created_at: instalada,
      },
      {
        id: versaoId(2),
        organization_id: org,
        name: AGENDAMENTO,
        description: antiga.description,
        body: antiga.body,
        matcher: { ...antiga.matcher, any_keywords: [...antiga.matcher.any_keywords, ...palavrasDaClinica] },
        manifest: [],
        forked_from_version_id: antiga.id,
        created_at: editada,
      },
      // 4) A skill que a clínica escreveu e enviou num .zip (sem arquivos de pacote).
      {
        id: versaoId(3),
        organization_id: org,
        name: preparo,
        description: demo(
          "Orienta o paciente sobre como se preparar para a primeira consulta: o que levar, a que horas chegar e o que não precisa fazer.",
        ),
        body: CORPO_PREPARO.map((linha) => (linha === "" ? "" : demo(linha))).join("\n") + "\n",
        matcher: { any_keywords: PALAVRAS_PREPARO.map((p) => demo(p)), any_tags: [ETIQUETA_DA_BASE] },
        manifest: [],
        forked_from_version_id: null,
        created_at: ha(25 * DIA),
      },
    ]),
    "versões de skill da clínica",
  );
  semErro(
    await db.from("skill_pointers").insert([
      { organization_id: org, name: AGENDAMENTO, version_id: versaoId(2), updated_at: editada },
      { organization_id: org, name: preparo, version_id: versaoId(3), updated_at: ha(25 * DIA) },
    ]),
    "ponteiros de skill da clínica",
  );
}

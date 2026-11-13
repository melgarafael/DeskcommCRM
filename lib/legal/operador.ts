/**
 * Quem é o responsável legal por ESTA instalação.
 *
 * O DeskcommCRM é MIT e self-host: quem instala numa VPS opera o próprio
 * sistema, decide o que fazer com os dados dos clientes dele e responde por
 * eles. Os mantenedores do projeto não têm acesso ao banco de ninguém e não são
 * parte de nenhum contrato entre o operador e os clientes dele.
 *
 * Por isso os documentos legais não podem ser um texto fixo se apresentando
 * como "serviço prestado pelo DeskcommCRM": isso seria literalmente falso em
 * toda instalação de terceiro, e criaria obrigação para quem não pode cumpri-la.
 * O documento nomeia o OPERADOR — e, quando ele publicou a política dele, é a
 * dele que vale.
 */
import { env } from "@/lib/env";
import { valorDaInstalacao } from "@/lib/instalacao/config";
import { marcaDaSaida } from "@/lib/branding/saida";
import { loadAuthUser, orgAtivaSemPortao } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROVEDORES, PROVEDOR_POR_ID, type PaisDoProvedor } from "@/lib/ai/pontos/provedores";
import { lerAmbiente, type FonteDeAmbiente } from "@/lib/instalacao/ambiente";

export interface Operador {
  /** Nome do sistema nesta instalação (respeita marca própria). */
  sistema: string;
  /** Nome comercial da organização, quando dá para saber quem está lendo. */
  nome: string | null;
  /** Razão social. */
  razaoSocial: string | null;
  cnpj: string | null;
  /** Contato do encarregado de dados (LGPD). */
  dpoEmail: string | null;
  /**
   * ISO-3166 alpha-2 da organização ativa, ou `null` (Brasil, o padrão).
   *
   * Existe para a política de privacidade (`app/legal/privacy/page.tsx`) falar
   * a língua legal do país: "controlador"/"CNPJ"/"LGPD" no Brasil, "responsável
   * pelo tratamento"/"NIPC"/"RGPD" em Portugal (issue #2344). Mesma razão de
   * `lib/legal/perfil-do-pais.ts` — o vocabulário é do país, não do texto fixo.
   */
  pais: string | null;
  /** Política própria do operador, já checada — nunca o valor cru do banco. */
  politicaPropria: string | null;
  /**
   * `false` quando a página foi aberta sem sessão. O texto continua íntegro:
   * só troca a razão social por "o operador desta instalação".
   */
  resolvido: boolean;
}

/**
 * A guarda de saída da URL de política do operador.
 *
 * O formulário valida esse campo com `z.string().url()`, e `url()` do zod
 * ACEITA `javascript:alert(1)` — é um esquema de URL válido. Como `/legal/*` é
 * rota pública, renderizar o valor cru num `<a href>` (ou passá-lo a
 * `redirect()`) deixaria um admin de tenant alcançar visitantes anônimos.
 *
 * A checagem mora aqui, na saída, e não no schema: o schema é compartilhado com
 * outros campos e já aceitou dados que estão gravados há tempo. Falhar fechado
 * aqui vale para o que já existe no banco, não só para o que for gravado depois.
 */
export function urlDePoliticaSegura(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  if (texto === "") return null;
  try {
    const url = new URL(texto);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return texto;
  } catch {
    // Não é URL absoluta. Um caminho relativo aqui apontaria para dentro do
    // próprio CRM, o que não é uma política de privacidade publicada.
    return null;
  }
}

/**
 * O nome do sistema NESTA instalação — pelo resolvedor que LÊ O BANCO.
 *
 * Era `branding().name`, que considera só o `.env` (a semente da instalação), e
 * a marca gravada pela tela (Administração › Marca, `platform_branding`) não
 * chegava aos documentos legais: um revendedor que mudou de nome continuava
 * vendo o nome antigo na política de privacidade e nos termos (#2511).
 *
 * `marcaDaSaida(null)` é o mesmo resolvedor sem DOM que a página pública `/`
 * usa desde o #2510 — banco ACIMA do `.env`, e NUNCA lança. Aqui a recusa não é
 * caminho de erro aceitável: falha fechada fecharia o texto legal inteiro por
 * causa de um nome.
 */
const sistemaDaInstalacao = async (): Promise<string> => (await marcaDaSaida(null)).nome;

/**
 * Virou `async` porque o contato do encarregado passou a vir do banco (migration
 * 0341), com o arquivo de instalação como piso. As três chamadas vivem dentro de
 * `resolverOperador`, que já era assíncrona — o alcance foi medido antes de
 * mudar a assinatura.
 */
const SEM_SESSAO = async (): Promise<Operador> => ({
  sistema: await sistemaDaInstalacao(),
  nome: null,
  razaoSocial: null,
  cnpj: null,
  dpoEmail: (await valorDaInstalacao("LGPD_DPO_EMAIL")).valor?.trim() || null,
  politicaPropria: null,
  resolvido: false,
  // Sem sessão não há organização para ler: vale o Brasil, o mesmo "vazio" da
  // coluna `organizations.country`.
  pais: null,
});

/**
 * Lê os dados do operador com o client de SESSÃO, nunca com o service role: a
 * policy `orgs_select` já restringe a leitura às organizações do usuário. Numa
 * rota pública, um admin client resolveria "alguma" organização e publicaria
 * razão social, CNPJ e e-mail do encarregado de um tenant numa URL sem
 * autenticação — e resolveria a org de fonte não confiável, que é o
 * anti-pattern que a doutrina do projeto proíbe.
 *
 * Sem sessão, devolve o fallback. Não é caminho de erro: é o visitante que
 * colou o link, e ele tem direito a ler o documento inteiro.
 */
export async function resolverOperador(): Promise<Operador> {
  const user = await loadAuthUser();
  if (!user) return await SEM_SESSAO();

  const activeOrg = await orgAtivaSemPortao(user);
  if (!activeOrg) return await SEM_SESSAO();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("display_name, legal_name, cnpj, dpo_email, privacy_policy_url, country")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  // Falha de leitura não pode apagar o documento da tela: o texto do produto
  // vale para todo mundo, e o que se perde é só a personalização.
  if (error || !data) return { ...(await SEM_SESSAO()), sistema: await sistemaDaInstalacao() };

  const org = data as {
    display_name: string | null;
    legal_name: string | null;
    cnpj: string | null;
    dpo_email: string | null;
    privacy_policy_url: string | null;
    country: string | null;
  };

  return {
    sistema: await sistemaDaInstalacao(),
    nome: org.display_name?.trim() || null,
    razaoSocial: org.legal_name?.trim() || null,
    cnpj: org.cnpj?.trim() || null,
    // Mesmo fallback que o resto do produto já usa para o encarregado.
    dpoEmail:
      org.dpo_email?.trim() ||
      (await valorDaInstalacao("LGPD_DPO_EMAIL")).valor?.trim() ||
      null,
    politicaPropria: urlDePoliticaSegura(org.privacy_policy_url),
    resolvido: true,
    pais: org.country?.trim() || null,
  };
}

/** Como o documento se refere ao operador quando não dá para saber quem é. */
export function nomeDoOperador(op: Operador): string {
  return op.razaoSocial ?? op.nome ?? "o operador desta instalação";
}

// ── TRANSFERÊNCIA INTERNACIONAL — A CLÁUSULA SAI DO CATÁLOGO (#4520) ─────────
//
// A cláusula 9 do documento do operador dizia "as conversas vão para provedores
// fora do Brasil" — uma frase escrita à mão, uma vez, para todo mundo. Quem
// assina o contrato precisa dizer O QUE sai do país e PARA ONDE, e a frase
// genérica não consegue cumprir isso; pior, ela continuaria igual numa
// instalação cujo único provedor é um endpoint próprio, no servidor do próprio
// operador.
//
// O dado que faltava é o país. Ele NÃO EXISTIA em lugar nenhum do repo (medido:
// `PROVEDOR_POR_ID` não tinha país, e nenhum arquivo de `lib/ai` mapeava
// provedor → país). Então ele passou a ser DECLARADO no catálogo
// (`lib/ai/pontos/provedores.ts`, campo `pais`), e esta função só compõe: quem
// lista provedor é uma fonte, quem escreve o texto é outra, e a data da
// consulta vai junto porque dado sem data parece garantia.
//
// As regras são as da issue, nesta ordem:
//  1. só entram provedores ATIVOS nesta instalação (`provedoresAtivosDaInstalacao`);
//  2. provedor que não declara o país aparece, com a frase que manda consultar
//     a política dele — omitir seria esconder uma transferência que existe;
//  3. endpoint próprio/modelo local aparece como "no servidor do operador";
//  4. a data da declaração vai no texto.

/**
 * Quando os países do catálogo foram conferidos pela última vez.
 *
 * Data, e não "atualizado sempre": o país da sede de um provedor muda por
 * aquisição/reorganização, e o contrato precisa poder ser reconferido. Quem
 * mudar um `pais` em `provedores.ts` muda esta data no mesmo commit.
 */
export const CONSULTA_DOS_PAISES_EM = "2026-11-13";

/** O nome do país como o contrato escreve — não é ISO-3166 de tela. */
const NOME_DO_PAIS: Record<Exclude<PaisDoProvedor, "desconhecido" | "operador">, string> = {
  US: "Estados Unidos",
  CN: "China",
  UE: "União Europeia",
};

/** `"Anthropic (Claude)"` → `"Anthropic"`: o parêntese do rótulo é da tela. */
function nomeCurtoDoProvedor(rotulo: string): string {
  const corte = rotulo.indexOf(" (");
  return corte > 0 ? rotulo.slice(0, corte) : rotulo;
}

/** Como uma linha da lista nomeia o provedor e o destino do dado. */
function linhaDoProvedor(id: string): string | null {
  const provedor = PROVEDOR_POR_ID.get(id);
  if (!provedor) return null;
  const nome = nomeCurtoDoProvedor(provedor.rotulo);
  if (provedor.pais === "desconhecido") {
    return `${nome} (não declara o país; consulte a política do provedor)`;
  }
  if (provedor.pais === "operador") {
    return `${nome} (no servidor do operador)`;
  }
  return `${nome} (${NOME_DO_PAIS[provedor.pais]})`;
}

/**
 * A cláusula 9, composta a partir dos provedores ATIVOS.
 *
 * `null` — e não lista vazia — é a leitura que FALHOU: dizer "não há
 * transferência" porque o banco não respondeu seria a única frase desta
 * cláusula capaz de criar obrigação falsa. Lista vazia é medição: a instalação
 * não tem IA ligada, e aí a cláusula diz isso.
 *
 * A ordem é a do catálogo (`PROVEDORES`), não a de chegada: dois documentos
 * gerados da mesma instalação saem iguais, e o diff de um contrato não muda de
 * ordem porque o Postgres devolveu as linhas noutra.
 */
export function clausulaDeTransferenciaInternacional(
  idsAtivos: readonly string[] | null,
): string {
  if (idsAtivos === null) {
    return (
      "Não foi possível confirmar agora, pelo banco desta instalação, quais provedores de " +
      "inteligência artificial estão ativos; a lista corrente está em Agente de IA › Credenciais. " +
      "O CRM e o banco ficam no servidor do operador, no Brasil. Você, como controlador, deve " +
      "indicar na sua política o mecanismo de transferência que adota (Resolução CD/ANPD nº 19/2024)."
    );
  }

  const ativos = new Set(idsAtivos);
  const linhas = PROVEDORES.map((p) => p.id)
    .filter((id) => ativos.has(id))
    .map(linhaDoProvedor)
    .filter((linha): linha is string => linha !== null);

  if (linhas.length === 0) {
    return (
      "Com a IA desligada, nenhum texto de conversa é enviado a provedor externo: nada sai do " +
      "servidor do operador, no Brasil. Se a IA for ligada, esta cláusula passa a listar os " +
      "provedores usados e os países deles."
    );
  }

  return (
    `Com a IA ligada, o texto das conversas é processado por: ${linhas.join(", ")} — ` +
    `conforme a declaração de cada provedor, consultada em ${dataDaConsulta()}. ` +
    "O CRM e o banco ficam no servidor do operador, no Brasil. Você, como controlador, deve " +
    "indicar na sua política o mecanismo de transferência que adota (Resolução CD/ANPD nº 19/2024)."
  );
}

/** `2026-11-13` → `13/11/2026`, o formato que o contrato em português usa. */
function dataDaConsulta(): string {
  const [ano, mes, dia] = CONSULTA_DOS_PAISES_EM.split("-");
  return `${dia}/${mes}/${ano}`;
}

/**
 * Quais provedores de IA estão ATIVOS nesta instalação — a fonte da cláusula 9.
 *
 * Duas portas, porque o produto tem duas: a credencial cadastrada pela tela
 * (`ai_provider_credentials`, ativa E já validada — a que o turno consegue usar)
 * e a chave de plataforma do `.env` (`lerAmbiente`). Provedor só oferecido, sem
 * chave, NÃO entra: listar o que não é usado assusta sem informar.
 *
 * `null` é falha de leitura, e não "nenhum" — quem chama decide como escrever
 * isso (`clausulaDeTransferenciaInternacional` tem a frase própria).
 *
 * O `db` precisa ser o cliente de serviço: `ai_provider_credentials` é cifrada e
 * a policy não a entrega a `authenticated`; com o cliente de sessão esta leitura
 * volta vazia e a cláusula diria "nenhuma transferência" para uma instalação com
 * IA ligada.
 */
export async function provedoresAtivosDaInstalacao(
  db: SupabaseClient,
  ambiente: FonteDeAmbiente = process.env,
): Promise<string[] | null> {
  const { data, error } = await db
    .from("ai_provider_credentials")
    .select("provider")
    .eq("is_active", true)
    .not("validated_at", "is", null);
  if (error) return null;

  const ativos = new Set<string>(
    ((data ?? []) as { provider: string }[]).map((linha) => linha.provider),
  );
  for (const [id, temChave] of Object.entries(lerAmbiente(ambiente).chavesDeProvedor)) {
    if (temChave) ativos.add(id);
  }

  // A ordem do catálogo, e só quem o catálogo conhece: uma linha órfã no banco
  // (provedor removido do produto) não pode virar parágrafo de contrato.
  return PROVEDORES.map((p) => p.id).filter((id) => ativos.has(id));
}

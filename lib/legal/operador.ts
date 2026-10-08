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
    .select("display_name, legal_name, cnpj, dpo_email, privacy_policy_url")
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
  };
}

/** Como o documento se refere ao operador quando não dá para saber quem é. */
export function nomeDoOperador(op: Operador): string {
  return op.razaoSocial ?? op.nome ?? "o operador desta instalação";
}

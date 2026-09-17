/**
 * De onde o editor tira modelo e credencial quando ainda não há versão.
 *
 * O onboarding grava o agente em `ai_agents` (às vezes com `model` no formato
 * `provedor/id`, que é o default do schema) e, sem canal, não chegava a criar
 * linha em `ai_agent_versions`. O cartão lia o cadastro; o formulário lia só a
 * versão e abria com modelo vazio — "Escolha o modelo…" numa tela cujo cartão
 * já mostrava `claude-sonnet-4-6`.
 *
 * Estas funções são a ponte. São puras de propósito: o teste vigia o recorte
 * sem montar a tela, e o formulário não precisa adivinhar o formato.
 *
 * Não leem credencial cifrada. O seletor só precisa do id, do provedor e de
 * saber se a chave está ativa e validada — o mesmo recorte da view
 * `ai_provider_credentials_safe`.
 */

export type ModeloDoCatalogo = {
  provider: string;
  model_id: string;
  is_default_for_provider?: boolean | null;
  deprecated_at?: string | null;
};

/**
 * O que o editor pode ver de uma credencial. Qualquer campo a mais aqui é um
 * convite a vazar segredo para a tela; o teste da hidratação recusa `api_key`
 * cifrada neste tipo.
 */
export type CredencialParaEditor = {
  id: string;
  provider: string;
  is_active: boolean;
  validated_at: string | null;
};

/**
 * Tira só o prefixo `provedor/` quando ele casa com o provedor desta versão.
 * `anthropic/claude-sonnet-4-6` + provider `anthropic` → `claude-sonnet-4-6`.
 * Id já nu, ou prefixo de outro provedor, permanece como está.
 */
export function modeloNudeDoCadastro(cadastro: string, provider: string): string {
  const texto = cadastro.trim();
  if (texto === "") return "";
  const prefixo = `${provider}/`;
  if (texto.startsWith(prefixo)) return texto.slice(prefixo.length);
  return texto;
}

export function escolherModeloParaEditor(args: {
  versionModel?: string | null;
  cadastroModel?: string | null;
  provider: string;
  catalogo: readonly ModeloDoCatalogo[];
}): string {
  const daVersao = args.versionModel?.trim() ?? "";
  if (daVersao !== "") return daVersao;

  const ativos = args.catalogo.filter(
    (m) => m.provider === args.provider && (m.deprecated_at == null || m.deprecated_at === ""),
  );
  const nude = modeloNudeDoCadastro(args.cadastroModel ?? "", args.provider);
  if (nude !== "" && ativos.some((m) => m.model_id === nude)) return nude;

  const padrao = ativos.find((m) => m.is_default_for_provider);
  return padrao?.model_id ?? "";
}

/**
 * Com versão, o que está gravado vence — `null` no banco é a chave da
 * instalação, e a tela usa `tokenInstalacao` para representar isso.
 *
 * Sem versão, só pré-seleciona quando há **exatamente uma** credencial ativa e
 * validada daquele provedor. Duas chaves, ou uma ainda não validada, deixam o
 * campo vazio: escolher no chute publicaria a chave errada.
 */
export function escolherCredencialParaEditor(args: {
  versionExists: boolean;
  versionCredentialId?: string | null;
  tokenInstalacao: string;
  provider: string;
  credenciais: readonly CredencialParaEditor[];
}): string {
  if (args.versionExists) {
    return args.versionCredentialId ?? args.tokenInstalacao;
  }
  const validas = args.credenciais.filter(
    (c) => c.provider === args.provider && c.is_active && Boolean(c.validated_at),
  );
  if (validas.length === 1) return validas[0]!.id;
  return "";
}

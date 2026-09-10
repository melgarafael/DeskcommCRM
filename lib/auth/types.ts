import type { ModulesState } from "@/lib/modules/config";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * Papéis dentro do tenant.
 *
 * `ai_operator` é o papel do AGENTE PUBLICADO, e existe SÓ no escopo do token
 * efêmero — nunca em `user_organizations`. Nenhuma pessoa o recebe, e o CHECK
 * daquela tabela segue com os quatro papéis humanos de propósito: é isso que
 * garante que ninguém ganhe autonomia de máquina por acidente de configuração.
 *
 * Ele senta ENTRE `agent` e `manager` porque descreve exatamente a faixa que
 * faltava: capacidades que um atendente humano não tem (configurar a operação,
 * mexer na régua de retorno) mas que o agente precisa para cumprir o invariante
 * 4 da doutrina — nenhuma demanda sem próximo passo. Abrir essas capacidades
 * para `agent` daria a uma PESSOA um poder que o produto não lhe dá pela tela;
 * fechá-las em `manager` tira do agente o que ele existe para fazer.
 *
 * `fn_role_at_least` no banco NÃO conhece este papel, e está certo assim: ela
 * consulta `fn_user_role_in_org`, que lê `user_organizations`. O agente não é
 * usuário. A RLS segue intacta.
 */
export type Role = "viewer" | "agent" | "ai_operator" | "manager" | "admin";
export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  agent: 2,
  ai_operator: 3,
  manager: 4,
  admin: 5,
};

/**
 * Compara um role (possivelmente vindo solto de uma consulta, não tipado)
 * contra um mínimo. NÃO é gate de rota — isso é `requireRole()`
 * (`lib/auth/require-role.ts`), o único lugar que decide 403 e aplica o gate
 * de MFA. Este helper existe para os usos legítimos que sobram depois de uma
 * rota já ter passado por `requireRole()`: computar um campo informativo no
 * payload (ex.: `podeEditar`) ou uma regra de escopo adicional sobre o MESMO
 * role já resolvido (ex.: "autor OU manager+"). Em ambos a decisão de ACESSO
 * À ROTA já foi tomada; isto só lê o rank — nunca decide 401/403 sozinho.
 */
export function roleAtLeast(role: string | null | undefined, min: Role): boolean {
  const rank = role ? (ROLE_RANK[role as Role] ?? 0) : 0;
  return rank >= ROLE_RANK[min];
}

/** Papéis que uma PESSOA pode ter. Espelha `user_organizations_role_check`. */
export const PAPEIS_HUMANOS: ReadonlyArray<Role> = ["viewer", "agent", "manager", "admin"];

/** Rótulo pt-BR para quem configura. `ai_operator` nunca aparece em seletor de time. */
export const ROTULO_DO_PAPEL: Record<Role, string> = {
  viewer: "Somente leitura",
  agent: "Atendente",
  ai_operator: "Assistente com autonomia de operação",
  manager: "Gerente",
  admin: "Administrador",
};

/**
 * Escopo de visualização de conversas por atendente (G4-01, spec 13 §3.5).
 * Só restringe o role `agent`; viewer/manager/admin seguem org-wide.
 */
export type VisibilityMode = "all" | "own_and_unassigned" | "own";
export const DEFAULT_VISIBILITY_MODE: VisibilityMode = "own_and_unassigned"; // G1-06a

export interface UserOrgMembership {
  interface_settings?: InterfaceSettings;
  organization_id: string;
  organization_name: string;
  role: Role;
  /**
   * Idioma padrão da organização (`organizations.locale`).
   *
   * Vem junto porque quem escolhe a organização ativa é a mesma função que
   * precisa decidir o idioma — buscá-lo depois seria uma segunda ida ao banco
   * para responder algo que a primeira já tinha em mãos.
   */
  locale?: string | null;
}

export interface AuthUser {
  support?: import("@/lib/impersonate/support").SupportContext | null;
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  is_platform_admin: boolean;
  /**
   * Idioma da interface, de `user_metadata.locale`.
   *
   * Vem no AuthUser e não numa consulta própria porque toda tela precisa dele
   * no primeiro render: buscá-lo depois faria a interface aparecer em português
   * e trocar para espanhol meio segundo depois, em toda navegação.
   */
  locale?: string | null;
  /**
   * O idioma que a interface REALMENTE usa nesta sessão — já resolvido.
   *
   * ─── Por que não bastava `locale` ──────────────────────────────────────
   *
   * `locale` é a PREFERÊNCIA de quem está logado, e ela costuma estar vazia:
   * ninguém abre o perfil antes de usar o produto. Quando está vazia, a
   * pergunta certa não é "português, então" — é "em que idioma esta empresa
   * trabalha", que é `organizations.locale`.
   *
   * Esse campo da organização existia, tinha seletor na tela de Configurações,
   * era gravado no banco… e NÃO ERA LIDO POR NINGUÉM. Medido por varredura: as
   * únicas referências eram a escrita (`app/actions/settings/updateTenant.ts`)
   * e a releitura para preencher o próprio formulário. Ou seja, exatamente o
   * defeito que originou o i18n — um seletor que não muda uma letra —, repetido
   * um andar acima e sem que ninguém percebesse.
   *
   * A ordem é: preferência da pessoa → idioma da organização → padrão do
   * produto. É ela que faz o idioma escolhido no instalador chegar a quem
   * entra: o `install.sh` grava na organização, e quem nunca abriu o perfil já
   * encontra o sistema no idioma certo.
   */
  idioma: Idioma;
  /**
   * Fuso de APRESENTAÇÃO, de `user_metadata.timezone`.
   *
   * Vem aqui pelo mesmo motivo do `locale` acima: a grade da Agenda precisa
   * dele no primeiro render, e buscá-lo depois desenharia o dia inteiro no
   * fuso errado para corrigir meio segundo depois — com os compromissos
   * pulando de posição na frente de quem está olhando.
   *
   * NÃO é o fuso da REGRA. Em que fuso as janelas de trabalho valem é
   * `attendant_availability.schedule.timezone`, e são perguntas diferentes:
   * quem está em Manaus vê a grade no horário de Manaus enquanto a jornada
   * continua valendo no fuso em que foi configurada.
   *
   * Até esta linha o campo era escrito pela tela de perfil e lido por NINGUÉM —
   * o anti-pattern "tela oferece o que o código ignora".
   */
  timezone?: string | null;
  organizations: UserOrgMembership[];
}

export interface ActiveOrg {
  modules?: ModulesState;
  interface_settings?: InterfaceSettings;
  orgId: string;
  name: string;
  role: Role;
  /**
   * Escopo de visualização da org (G4-01). Opcional: só é preenchido no client
   * context (AppLayout) para a UI do inbox decidir visões visíveis. Não é fonte
   * de autorização — a RLS (fn_can_view_conversation) é quem garante o escopo.
   */
  visibility_mode?: VisibilityMode;
  /**
   * O que ESTA organização definiu para si — CAMPO A CAMPO, e só o que ela
   * mesma definiu.
   *
   * Opcional pelo mesmo motivo de `visibility_mode`: só o layout de `/app`
   * preenche, e só para o campo cuja resolução aponta a camada da organização.
   * Campo ausente significa "vale o de cima" — o da instalação —, que é
   * exatamente o que o menu já mostrava. Por isso `nome` também é opcional: a
   * organização que definir só o logo não pode arrastar junto um `nome` que
   * ninguém escolheu ali.
   *
   * `logoUrl` TEM produtor desde a onda do upload: `camadaDaOrganizacao`
   * (`lib/branding/resolve.ts`) declara o logo a partir de
   * `settings.branding.logo_path`, gravado por `/api/v1/marca/logo`. O consumidor
   * (a barra lateral) entrou uma onda ANTES do produtor, de propósito e
   * declarado — foi o que permitiu que o upload fosse só a camada, sem reabrir a
   * casca inteira. Enquanto durou, não era campo decorativo pelo avesso: já
   * tinha teste de comportamento (`tests/unit/sidebar-nome-da-organizacao.test.tsx`).
   *
   * A rota é a que já existe: layout → `AuthProvider` → `useAuth()`. É como o
   * valor atravessa a fronteira servidor/navegador sem plumbing nova. A marca da
   * INSTALAÇÃO atravessa por outro caminho, e desde esta onda também vem do
   * banco: `app/layout.tsx` resolve a pilha e o `<PublicEnvScript/>` a injeta em
   * `window.__PUBLIC_ENV__`, de onde `branding()` a lê.
   */
  marca?: { readonly nome?: string; readonly logoUrl?: string | null };
}

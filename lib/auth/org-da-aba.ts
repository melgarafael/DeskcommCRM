/**
 * ABA NUMA ORGANIZAÇÃO, SESSÃO (COOKIE) EM OUTRA — o vocabulário comum das duas
 * metades da #2335.
 *
 * O cookie `active_org` é UM por sessão do navegador: vale para todas as abas.
 * A organização que a aba acha que tem, porém, vem das props do layout e fica
 * fixa durante a vida do documento. Trocar pelo seletor faz
 * `window.location.assign` e recarrega SÓ aquela aba — as demais seguem com a
 * organização antiga enquanto o servidor já responde pela nova.
 *
 * Metade 1 (LEITURA): `hooks/auth/InterfaceRefresh.tsx` vê
 * `organization_id` divergente e AVISA em vez de recarregar sozinho — trocar o
 * documento sem o usuário pedir apaga formulário em edição (#2313).
 * Metade 2 (ESCRITA): o servidor recusa a mutação com `CODIGO_ORG_DIVERGENTE`
 * quando a organização que a aba declarou diverge do cookie
 * (`lib/auth/require-role.ts`).
 *
 * ─── Transporte — escolha declarada na PR da #2335 ──────────────────────────
 * - Rotas `/api/v1/**`: HEADER `X-Org-Da-Aba`, carimbado pelo `apiClient`
 *   SOMENTE em método mutante. Leitura (GET) não carrega o header, então a
 *   recusa acontece só em escrita — e o ponto de validação é o `requireRole`,
 *   o gate único que toda rota /api/v1 já atravessa.
 * - Server actions: PARÂMETRO explícito, como no #2068
 *   (`requireOnboardingCtx(orgIdDaAba)`) — server action não recebe header
 *   custom do cliente. Esta PR declara a escolha; o amortecimento das server
 *   actions que ainda não recebem o parâmetro é cobertura declarada, não
 *   inventada aqui.
 */
import { ApiErrorCodes } from "@/lib/api/errors";
import type { Idioma } from "@/lib/i18n/idiomas";

/** Header enviado pelo `apiClient` em toda mutação. */
export const HEADER_ORG_DA_ABA = "X-Org-Da-Aba";

/** Código próprio da recusa — a tela o traduz no MESMO aviso da metade 1. */
export const CODIGO_ORG_DIVERGENTE = ApiErrorCodes.org_divergente;

/** Id do toast: leitura e escrita compartilham uma janela só na tela. */
export const ID_DO_AVISO_ORG_DIVERGENTE = "org-divergente";

/** O que esta aba acha que é — registrado pelo `AuthProvider` nas props. */
export interface OrgDaAba {
  orgId: string;
  nome: string | null;
  idioma: Idioma | null;
}

/**
 * Estado por DOCUMENTO (uma aba): é exatamente o que o cookie não guarda —
 * duas abas do mesmo navegador têm este valor DIFERENTE enquanto o
 * `active_org` é o mesmo para as duas.
 */
let orgDaAbaAtual: OrgDaAba | null = null;

export function definirOrgDaAba(org: OrgDaAba | null): void {
  orgDaAbaAtual = org;
}

export function orgDaAba(): OrgDaAba | null {
  return orgDaAbaAtual;
}

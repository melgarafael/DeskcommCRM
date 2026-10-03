/**
 * QUEM É OBRIGADO A CADASTRAR A VERIFICAÇÃO EM DUAS ETAPAS.
 *
 * ═══ O QUE MUDOU, E POR QUÊ ═══
 *
 * A regra era uma linha sem opção: `isPlatformAdmin || role === "admin"`. Na
 * prática isso significava que TODA instalação self-host forçava o dono a
 * configurar TOTP antes de usar o produto — e o `install.sh` cria o dono como
 * platform admin, então nem trocar de papel escapava.
 *
 * O efeito, medido percorrendo o wizard: a pessoa termina seis passos, clica em
 * "Começar a usar", e a PRIMEIRA coisa que vê é um bloqueador de tela inteira
 * pedindo um aplicativo autenticador. Um sétimo passo que a barra de progresso
 * nunca anunciou, na hora em que ela finalmente ia ver o produto funcionando.
 *
 * Decisão do dono do produto: o cadastro passa a ser OPCIONAL e ligado numa tela
 * de Configurações. Segurança que expulsa o usuário na primeira tela não protege
 * ninguém — ela só faz o produto não ser usado.
 *
 * ═══ AS DUAS PERGUNTAS, QUE NÃO SÃO A MESMA ═══
 *
 * 1. **Preciso CADASTRAR?** É política, e é o que este arquivo responde. Depende
 *    de quem decidiu exigir: a plataforma (`platform_admins.mfa_required`) ou a
 *    empresa (`organizations.settings.security.mfa_required` /
 *    `.mfa_required_min_role`).
 *
 * 2. **Preciso PROVAR agora?** É sessão, e a resposta é sempre a mesma: quem TEM
 *    fator cadastrado precisa provar. Isso NÃO depende da política — ver
 *    `mfaEmDivida` em `lib/auth/server.ts`. Antes ele começava perguntando a
 *    política, e com o cadastro opcional isso teria virado um buraco: quem
 *    ativasse a verificação por vontade própria teria o fator ignorado na
 *    sessão, que é o mesmo que não ter.
 *
 * ⚠️ `platform_admins.mfa_required` JÁ EXISTIA E NUNCA FOI LIDO. A coluna está no
 * schema, aparece na tela de admin da plataforma com um badge de sim/não, e o
 * gate ignorava: ele olhava só o booleano `is_platform_admin`. Era um controle
 * decorativo — o operador podia desmarcá-lo e nada mudava. Agora ele decide de
 * verdade.
 *
 * ═══ POR QUE O PADRÃO CONTINUA NÃO EXIGIR (#1533) ═══
 *
 * A organização agora pode pedir o segundo fator de QUALQUER nível de papel
 * (`mfa_required_min_role`), com carência (`mfa_grace_days`). Isso NÃO mexe no
 * registro acima: o padrão continua sendo **não exigir**, porque a alternativa
 * seria acordar toda organização existente obrigando a equipe inteira a cadastrar
 * TOTP sem que ninguém tenha escolhido isso. Quem quiser exigir, escolhe — e a
 * compatibilidade é literal: `mfa_required: true` SEM a chave nova continua
 * significando "só dos administradores", que é exatamente o comportamento de
 * hoje.
 */

import { ROLE_RANK, type Role } from "@/lib/auth/types";

/**
 * O que a organização pode escolher como nível mínimo. `none` = ninguém é
 * obrigado (o padrão). `ai_operator` não entra: ele não é papel de
 * `user_organizations` (ver `lib/auth/types.ts`) — é o papel do agente
 * publicado, do escopo de token, e nenhuma PESSOA o tem.
 */
export type PapelMinimoDeMfa = "none" | "admin" | "manager" | "agent" | "viewer";

const PAPEIS_MINIMOS: ReadonlyArray<PapelMinimoDeMfa> = ["none", "admin", "manager", "agent", "viewer"];

/**
 * As TRÊS saídas da política, em vez de um booleano.
 *
 * Separar `exige` de `bloqueia` é o que dá sentido ao `mfa_grace_days`: durante
 * a carência a pessoa JÁ está obrigada (não pode desligar o próprio fator), mas
 * a tela ainda não pode travar — o prazo corre e vem na própria resposta. Quando
 * `bloqueia` é `true`, não há mais prazo a anunciar, e `prazoAte` é `null`.
 */
export interface ExigenciaDeMfa {
  /** A política alcança ESTA pessoa: ela vai ter que cadastrar o fator. */
  exige: boolean;
  /** E o prazo acabou: pode travar a tela agora (o `MfaEnrollGate`). */
  bloqueia: boolean;
  /** Fim da carência que ainda corre, ou `null` quando não há carência pendente. */
  prazoAte: Date | null;
}

export interface PoliticaDeMfa {
  /** O papel na organização ativa. `undefined` = sem organização resolvida. */
  role: Role | undefined;
  isPlatformAdmin: boolean;
  /**
   * `platform_admins.mfa_required` da linha desta pessoa. `null` quando ela não
   * é platform admin (ou quando a leitura não trouxe a linha).
   */
  plataformaExige: boolean | null;
  /**
   * `organizations.settings.security.mfa_required` da organização ativa.
   * Ausente = a empresa não escolheu, e o padrão é NÃO exigir.
   */
  empresaExige: boolean;
  /**
   * `organizations.settings.security.mfa_required_min_role`. Ausente = a
   * organização só tem o booleano legado (ou nada), e aí vale o fallback
   * "true sem min_role = admin" logo abaixo.
   */
  papelMinimo?: PapelMinimoDeMfa | null;
  /** `mfa_grace_days` (0..30). Ausente = 0 = bloqueio imediato, como hoje. */
  diasDeCarencia?: number | null;
  /** `mfa_policy_changed_at` — uma das âncoras da carência. */
  mudouEm?: string | Date | null;
  /**
   * `user_organizations.accepted_at` — a OUTRA âncora: quem acabou de entrar na
   * organização ganha a carência a partir da entrada dele, não da mudança da
   * política que ele nem viu acontecer.
   */
  aceitoEm?: string | Date | null;
  /** Relógio injetável para a carência. Ausente = agora mesmo. */
  agora?: Date;
}

const NAO_EXIGE: ExigenciaDeMfa = { exige: false, bloqueia: false, prazoAte: null };
const EXIGE_BLOQUEANDO: ExigenciaDeMfa = { exige: true, bloqueia: true, prazoAte: null };

const UM_DIA_MS = 86_400_000;
/** O teto de `mfa_grace_days` é 30 — acima disso a "carência" vira não exigir. */
const TETO_DA_CARENCIA = 30;

/** Vale o que está escrito, se estiver na lista; qualquer outra coisa, `null`. */
export function papelMinimoValido(valor: unknown): PapelMinimoDeMfa | null {
  return typeof valor === "string" && (PAPEIS_MINIMOS as ReadonlyArray<string>).includes(valor)
    ? (valor as PapelMinimoDeMfa)
    : null;
}

/** jsonb livre: lixo vira 0, fracionário arredonda, e o teto é 30. */
function diasDeCarenciaValidos(valor: unknown): number {
  const n =
    typeof valor === "number"
      ? valor
      : typeof valor === "string" && valor.trim() !== ""
        ? Number(valor)
        : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return Math.min(TETO_DA_CARENCIA, Math.max(0, Math.floor(n)));
}

/** Data que dá para somar, ou `null`. `settings` é jsonb livre: "ontem" não é data. */
function dataValida(valor: unknown): Date | null {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor;
  if (typeof valor !== "string" || valor.trim() === "") return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `max(mfa_policy_changed_at, accepted_at)` — a âncora da carência desta pessoa. */
function ancoraDaCarencia(p: PoliticaDeMfa): Date | null {
  const datas = [dataValida(p.mudouEm), dataValida(p.aceitoEm)].filter((d): d is Date => d !== null);
  if (datas.length === 0) return null;
  return datas.reduce((a, b) => (b.getTime() > a.getTime() ? b : a));
}

/**
 * O nível mínimo EFETIVO desta organização.
 *
 * O fallback é a peça de compatibilidade obrigatória da issue: `mfa_required:
 * true` SEM `mfa_required_min_role` é lido como `"admin"`, que é exatamente o
 * comportamento de hoje — as duas escritas convivem no mesmo jsonb, e o booleano
 * não pode deixar de valer só porque a chave nova existe.
 */
function papelMinimoEfetivo(p: PoliticaDeMfa): PapelMinimoDeMfa {
  const escrito = papelMinimoValido(p.papelMinimo);
  if (escrito !== null) return escrito;
  return p.empresaExige ? "admin" : "none";
}

/**
 * O papel desta pessoa alcança o mínimo exigido? Compara pelo `ROLE_RANK`
 * (`lib/auth/types.ts`), então vale para os quatro papéis humanos na ordem
 * natural — `viewer` (1) < `agent` (2) < `manager` (4) < `admin` (5).
 */
function papelAlcancado(role: Role | undefined, minimo: PapelMinimoDeMfa): boolean {
  if (minimo === "none") return false;
  if (!role || role === "ai_operator") return false;
  const rankDoPapel = (ROLE_RANK as Partial<Record<Role, number>>)[role];
  const rankDoMinimo = (ROLE_RANK as Partial<Record<Role, number>>)[minimo as Role];
  if (rankDoPapel === undefined || rankDoMinimo === undefined) return false;
  return rankDoPapel >= rankDoMinimo;
}

/**
 * A política completa para ESTA pessoa, pura: sem banco, sem I/O, sem relógio
 * próprio (a menos que `agora` não venha).
 *
 * ⚠️ AS DUAS ORIGENS SOMAM, NUNCA SE ANULAM. Um platform admin cuja plataforma
 * exige continua obrigado mesmo numa empresa que não exige — a superfície dele
 * alcança todos os tenants, e não é a preferência de um deles que a libera. E um
 * admin de tenant é obrigado se a empresa dele decidiu exigir, mesmo que a
 * plataforma não exija.
 *
 * A carência é só da EMPRESA: `platform_admins.mfa_required` não tem
 * `mfa_policy_changed_at` nem `accepted_at` onde pendurar um prazo, e inventar
 * uma âncora daria ao tenant o poder de adiar a exigência da plataforma. Sem
 * âncora válida também não há carência — carência que não sabe quando começou
 * não existe, e o bloqueio é imediato.
 */
export function avaliaPoliticaDeMfa(p: PoliticaDeMfa): ExigenciaDeMfa {
  if (p.isPlatformAdmin && p.plataformaExige === true) return EXIGE_BLOQUEANDO;

  const minimo = papelMinimoEfetivo(p);
  if (!papelAlcancado(p.role, minimo)) return NAO_EXIGE;

  const dias = diasDeCarenciaValidos(p.diasDeCarencia);
  if (dias <= 0) return EXIGE_BLOQUEANDO;

  const ancora = ancoraDaCarencia(p);
  if (ancora === null) return EXIGE_BLOQUEANDO;

  const prazoAte = new Date(ancora.getTime() + dias * UM_DIA_MS);
  const agora = p.agora ?? new Date();
  // Estrito: `prazoAte` é "até AQUI", então o instante exato ainda é carência.
  if (agora.getTime() > prazoAte.getTime()) return EXIGE_BLOQUEANDO;
  return { exige: true, bloqueia: false, prazoAte };
}

/**
 * Precisa cadastrar a verificação em duas etapas? — a pergunta de sempre, agora
 * resolvida pela regra pura acima (`avaliaPoliticaDeMfa(...).exige`).
 *
 * Continua sendo o booleano de ENROLLMENT, não o de bloqueio: durante a carência
 * a pessoa `exige` mas ainda não `bloqueia`. Quem precisa decidir se a tela
 * trava chama `avaliaPoliticaDeMfa` direto.
 */
export function exigeCadastroDeMfa(p: PoliticaDeMfa): boolean {
  return avaliaPoliticaDeMfa(p).exige;
}

/**
 * A leitura de `organizations.settings` — defensiva, como a do runtime.
 *
 * ⚠️ AUSENTE É `false`, E ISSO É A DECISÃO, não um descuido. `settings` é jsonb
 * livre: toda organização que existe hoje chega aqui sem a chave, e ela precisa
 * significar "não exige" para que a mudança tenha o efeito pedido. Um default
 * `true` faria o campo novo não mudar nada.
 */
export function empresaExigeMfa(settings: unknown): boolean {
  const s = (settings as { security?: unknown } | null)?.security;
  return (s as { mfa_required?: unknown } | null | undefined)?.mfa_required === true;
}

/**
 * As CHAVES NOVAS de `organizations.settings.security`, com o padrão de cada uma.
 *
 * Mesma leitura defensiva do `empresaExigeMfa` acima, pelas mesmas razões: o
 * jsonb é livre, então "owner" não é papel, 99 dias não é carência e "ontem" não
 * é data — e nenhum dos três pode virar obrigação de alguém.
 *
 * O fallback legado (`mfa_required: true` sem `min_role` = `admin`) NÃO mora
 * aqui: esta função devolve o que está escrito, e a interpretação é da regra
 * pura (`avaliaPoliticaDeMfa`), que também enxerga `empresaExige`.
 */
export function politicaDaEmpresa(settings: unknown): {
  papelMinimo: PapelMinimoDeMfa | null;
  diasDeCarencia: number;
  mudouEm: Date | null;
} {
  const s = (settings as { security?: unknown } | null)?.security;
  const security = (
    typeof s === "object" && s !== null ? s : {}
  ) as Record<string, unknown>;
  return {
    papelMinimo: papelMinimoValido(security.mfa_required_min_role),
    diasDeCarencia: diasDeCarenciaValidos(security.mfa_grace_days),
    mudouEm: dataValida(security.mfa_policy_changed_at),
  };
}

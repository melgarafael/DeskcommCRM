/**
 * O catálogo das chaves da instalação — o que a tela mostra, em português.
 *
 * ── Por que um catálogo declarativo, e não a lista de `lib/env.ts` ───────────
 *
 * `lib/env.ts` fala com o programa; esta tela fala com uma pessoa que comprou
 * uma VPS. `RESEND_API_KEY` não diz nada a ela; "Chave do serviço de e-mail"
 * diz. Sem esta camada, o painel seria um editor de arquivo `.env` com outra
 * fonte — que é justamente o que ela não consegue usar hoje.
 *
 * ── A regra que decide o campo `controle` ────────────────────────────────────
 *
 * `edita` SÓ para chave cujo código de produção JÁ lê pelo resolvedor
 * (`valorDaInstalacao`). Enquanto o call site continuar lendo `env.X`, gravar no
 * banco não tem efeito nenhum — e um campo que aceita e ignora é PIOR que campo
 * ausente: ele mente com aparência de funcionar. Este projeto já pagou essa
 * conta uma vez, com cinco controles decorativos num PR.
 *
 * Por isso a lista de `edita` é curta de propósito e cresce junto com os call
 * sites, nunca antes deles. `tests/unit/painel-nao-promete-o-que-nao-cumpre.test.ts`
 * reprova quem adicionar `edita` sem trocar o call site.
 */

import { CHAVES_DE_CANAL_DA_INSTALACAO } from "@/lib/channels/chaves-da-instalacao";

export type GrupoDaInstalacao =
  | "email"
  | "ia"
  | "whatsapp"
  | "banco"
  | "fila"
  | "seguranca"
  | "retencao"
  | "integracao";

export type NaturezaDoValor = "segredo" | "texto" | "numero" | "liga_desliga";

/**
 * Por que uma chave NÃO é editável. O nome é o contrato: a tela mostra esta
 * razão para a pessoa, então ela precisa ser verdadeira e específica.
 */
export type MotivoDeDiagnostico =
  /** Sem ela não se alcança o banco — logo ela não pode morar nele. */
  | "de_partida"
  /** É a chave que tranca as outras; guardá-la cifrada por si mesma é circular. */
  | "chave_mestra"
  /** Fica gravada dentro do programa quando ele é montado; trocar depois não move nada. */
  | "gravada_na_montagem"
  /** O par dela vive em OUTRO contêiner: trocar aqui não bastaria. */
  | "pareada_com_conteiner"
  /** Lida quando o processo liga, e o processo que a lê não é este. */
  | "lida_no_boot_de_outro_processo";

export interface ChaveDaInstalacao {
  /** O nome da variável de ambiente — é também a chave da linha no banco. */
  readonly chave: string;
  /**
   * QUAL TELA mostra esta chave. O padrão é a tela de Credenciais
   * (`/admin/configuracao`); `"email"` a leva para `/admin/email`, ao lado do
   * servidor SMTP.
   *
   * Existe por decisão de produto (DEC-009, opção A), não por arquitetura:
   * "como o meu servidor manda e-mail" é UM assunto, e estava dividido em duas
   * telas — o servidor próprio numa, o serviço externo na outra. Quem instala
   * abria "E-mail", não achava a chave do serviço externo e concluía que ele
   * não era suportado.
   *
   * ⚠️ O que muda é o LUGAR, e só. A linha continua em `platform_config`, com a
   * mesma ação de servidor, o mesmo cofre e o mesmo catálogo: duas telas
   * mostram campos diferentes do MESMO mecanismo, e nenhuma opção aparece em
   * duas. Se um dia aparecer, o defeito não é de tela — é de catálogo.
   */
  readonly telaDona?: "credenciais" | "email";
  readonly rotulo: string;
  /** O que é, para quem não programa. Uma frase. */
  readonly explicacao: string;
  readonly grupo: GrupoDaInstalacao;
  readonly natureza: NaturezaDoValor;
  readonly controle: "edita" | "diagnostico";
  /** Obrigatório quando `controle` é `diagnostico`. */
  readonly motivo?: MotivoDeDiagnostico;
  /** O que a pessoa faz para trocar, quando não dá pela tela. */
  readonly comoTrocar?: string;
}

/**
 * ── A PRIMEIRA LEVA EDITÁVEL ────────────────────────────────────────────────
 *
 * E-mail e contatos, e a escolha não é arbitrária: a doutrina de QA do projeto
 * manda testar "com os envs opcionais AUSENTES (ex.: sem `RESEND_API_KEY`) — é o
 * estado real de um primeiro deploy, e é onde moram os piores bugs de primeira
 * impressão". Ou seja: é exatamente a configuração que falta em toda instalação
 * nova e que hoje exige SSH.
 *
 * As credenciais de IA NÃO entram nesta leva, e o motivo é bom: elas já têm um
 * caminho próprio e mais rico (`ai_provider_credentials`, cifradas POR
 * ORGANIZAÇÃO, com escada de resolução). Duplicá-las aqui criaria duas respostas
 * para "qual chave vale", que é como se cria um bug que ninguém consegue depurar.
 */
/**
 * As chaves de CANAL vêm de `lib/channels/`, e não estão escritas aqui de
 * propósito: o nome delas é o nome do provider, e a doutrina `restricao-de-canal`
 * (vigiada por `pnpm lint:channels`) proíbe nomeá-lo fora daquela fronteira.
 * Este arquivo as consome como DADOS — continua sem nomear ninguém.
 */
const DE_CANAL: readonly ChaveDaInstalacao[] = CHAVES_DE_CANAL_DA_INSTALACAO.map((c) => ({
  chave: c.chave,
  rotulo: c.rotulo,
  explicacao: c.explicacao,
  grupo: "whatsapp" as const,
  natureza: "segredo" as const,
  controle: "diagnostico" as const,
  motivo: "pareada_com_conteiner" as const,
  comoTrocar: c.comoTrocar,
}));

export const CATALOGO_DA_INSTALACAO: readonly ChaveDaInstalacao[] = [
  ...DE_CANAL,
  {
    chave: "RESEND_API_KEY",
    rotulo: "Chave do serviço de e-mail",
    explicacao:
      "Sem ela o sistema não consegue enviar e-mail nenhum — nem convite para a equipe, nem recuperação de senha.",
    grupo: "email",
    natureza: "segredo",
    controle: "edita",
    // Mora na tela E-mail, ao lado do servidor próprio (DEC-009, opção A).
    telaDona: "email",
  },
  {
    chave: "RESEND_FROM_EMAIL",
    rotulo: "Endereço que aparece como remetente",
    explicacao:
      "O e-mail que seus clientes veem como remetente. Precisa ser de um domínio verificado no serviço de e-mail.",
    grupo: "email",
    natureza: "texto",
    controle: "edita",
    // Mora na tela E-mail, ao lado do servidor próprio (DEC-009, opção A).
    telaDona: "email",
  },
  {
    chave: "SUPPORT_EMAIL",
    rotulo: "E-mail de suporte",
    explicacao: "O endereço que o sistema mostra a quem usa, quando alguém precisa de ajuda.",
    grupo: "email",
    natureza: "texto",
    controle: "edita",
  },
  {
    chave: "LGPD_DPO_EMAIL",
    rotulo: "E-mail do encarregado de dados (DPO)",
    explicacao:
      "O contato obrigatório pela LGPD para pedidos de privacidade. Aparece nos documentos legais.",
    grupo: "seguranca",
    natureza: "texto",
    controle: "edita",
  },

  // ── DIAGNÓSTICO: de partida ───────────────────────────────────────────────
  {
    chave: "NEXT_PUBLIC_SUPABASE_URL",
    rotulo: "Endereço do banco de dados",
    explicacao: "Onde ficam todos os seus dados.",
    grupo: "banco",
    natureza: "texto",
    controle: "diagnostico",
    motivo: "de_partida",
    comoTrocar:
      "Esta é a porta de entrada do banco: o sistema precisa dela para ler qualquer coisa, inclusive esta tela. Guardá-la no banco seria como trancar a chave dentro do cofre. Troca-se no arquivo de instalação do servidor.",
  },
  {
    chave: "SUPABASE_SERVICE_ROLE_KEY",
    rotulo: "Senha administrativa do banco",
    explicacao: "A credencial que dá ao sistema acesso total aos dados.",
    grupo: "banco",
    natureza: "segredo",
    controle: "diagnostico",
    motivo: "de_partida",
    comoTrocar:
      "Sem ela o sistema não lê o banco — nem esta tela. Troca-se no arquivo de instalação do servidor.",
  },

  // ── DIAGNÓSTICO: pareada com outro contêiner ──────────────────────────────
  {
    chave: "UPSTASH_REDIS_REST_TOKEN",
    rotulo: "Senha da fila de tarefas",
    explicacao: "Protege a fila que controla o ritmo dos envios e evita bloqueio do seu número.",
    grupo: "fila",
    natureza: "segredo",
    controle: "diagnostico",
    motivo: "pareada_com_conteiner",
    comoTrocar: "O par dela vive no programa da fila. Trocam-se juntas, no arquivo de instalação.",
  },
  {
    chave: "INTERNAL_SECRET",
    rotulo: "Senha das tarefas automáticas",
    explicacao:
      "Protege as rotinas que rodam sozinhas — cobrança de follow-up, limpeza, verificações.",
    grupo: "seguranca",
    natureza: "segredo",
    controle: "diagnostico",
    motivo: "pareada_com_conteiner",
    comoTrocar:
      "O agendador é um programa separado que recebe esta senha ao ligar e não consulta o banco. Trocar aqui não mudaria o agendador. A troca é no arquivo de instalação.",
  },

  // ── DIAGNÓSTICO: chave-mestra ─────────────────────────────────────────────
  {
    chave: "AI_CRED_AES_KEY",
    rotulo: "Chave que tranca as credenciais",
    explicacao:
      "É com ela que o sistema embaralha as senhas guardadas — inclusive as que você digita nesta tela.",
    grupo: "seguranca",
    natureza: "segredo",
    controle: "diagnostico",
    motivo: "chave_mestra",
    comoTrocar:
      "Esta é a chave do cofre. Guardá-la dentro do próprio cofre não protegeria nada — e é por isso que ela fica no arquivo do servidor, fora do banco: assim, uma cópia de segurança do banco que vaze não abre nada. Se você perdê-la, as senhas guardadas não voltam.",
  },
  {
    chave: "LGPD_SIGNING_KEY",
    rotulo: "Chave que assina os documentos de privacidade",
    explicacao: "Assina digitalmente os relatórios de dados que a LGPD obriga a entregar.",
    grupo: "seguranca",
    natureza: "segredo",
    controle: "diagnostico",
    motivo: "chave_mestra",
    comoTrocar:
      "É uma chave de assinatura, não uma configuração: trocá-la invalida a conferência dos documentos já assinados. Fica no arquivo de instalação.",
  },

  // ── DIAGNÓSTICO: lida no boot de outro processo ───────────────────────────
  {
    chave: "AGENT_DISPATCH_CONSUMER",
    rotulo: "Modo de distribuição das conversas da IA",
    explicacao: "Decide como o programa de segundo plano pega as conversas para responder.",
    grupo: "ia",
    natureza: "texto",
    controle: "diagnostico",
    motivo: "lida_no_boot_de_outro_processo",
    comoTrocar:
      "Quem lê esta opção é o programa de segundo plano, uma única vez, quando liga — e ele não pergunta ao banco. Mostrar um campo aqui daria a impressão de que mudou, sem mudar nada. A troca é no arquivo de instalação, seguida de reinício.",
  },
] as const;

export function chavesDoGrupo(grupo: GrupoDaInstalacao): readonly ChaveDaInstalacao[] {
  return CATALOGO_DA_INSTALACAO.filter((c) => c.grupo === grupo);
}

export function chavesEditaveis(): readonly ChaveDaInstalacao[] {
  return CATALOGO_DA_INSTALACAO.filter((c) => c.controle === "edita");
}

export function acharChave(chave: string): ChaveDaInstalacao | undefined {
  return CATALOGO_DA_INSTALACAO.find((c) => c.chave === chave);
}

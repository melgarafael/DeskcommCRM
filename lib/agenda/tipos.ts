/**
 * O VOCABULÁRIO DA AGENDA — uma lista por conceito, e o banco espelha esta.
 *
 * Cada constante abaixo é a fonte do CHECK correspondente na migration 0176.
 * O emissor usa a CONSTANTE, nunca a string literal: é assim que um valor novo
 * chega ao banco e ao TypeScript no mesmo commit, e é o que
 * `tests/invariants/agenda-vocabulario.test.ts` mede.
 *
 * ⚠️ A FORMA destas declarações não é estilo, é requisito de instrumento.
 * O extrator que lê vocabulário de TypeScript (o de
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`, que o nosso imita)
 * reconhece exatamente duas formas: `type X = "a" | "b";` e
 * `const X = ["a","b"] as const`. Ele para no primeiro `]`, então uma lista de
 * OBJETOS — que seria o jeito natural de casar valor com rótulo — é ilegível
 * para ele. Daí a separação: a lista de CÓDIGOS é crua, e o rótulo em pt-br
 * mora num `Record` à parte, cuja exaustividade quem cobra é o compilador.
 */

import type { ActivityType } from "@/lib/leads/activity-vocabulary";

/**
 * O que esta organização marca. Espelha os nichos que o onboarding já usa
 * (`lib/onboarding/pacotes-de-funil.ts`): clínica, imobiliária, serviços,
 * curso, loja, genérico.
 */
export const CATEGORIAS_DE_AGENDAMENTO = [
  "consulta",
  "procedimento",
  "retorno",
  "visita",
  "vistoria",
  "reuniao",
  "call",
  "orcamento",
  "demonstracao",
  "outro",
] as const;
export type CategoriaDeAgendamento = (typeof CATEGORIAS_DE_AGENDAMENTO)[number];

export const ROTULO_DA_CATEGORIA: Record<CategoriaDeAgendamento, string> = {
  consulta: "Consulta",
  procedimento: "Procedimento",
  retorno: "Retorno",
  visita: "Visita",
  vistoria: "Vistoria",
  reuniao: "Reunião",
  call: "Call",
  orcamento: "Orçamento",
  demonstracao: "Demonstração",
  outro: "Outro",
};

/** Onde o compromisso acontece — e é isto que decide o que a tela pergunta. */
export const LOCAIS_DE_AGENDAMENTO = [
  "in_person",
  "phone",
  "whatsapp",
  "video_link",
  "google_meet",
] as const;
export type LocalDeAgendamento = (typeof LOCAIS_DE_AGENDAMENTO)[number];

export const ROTULO_DO_LOCAL: Record<LocalDeAgendamento, string> = {
  in_person: "Presencial",
  phone: "Telefone",
  whatsapp: "WhatsApp",
  video_link: "Link de vídeo",
  google_meet: "Google Meet",
};

/** O que cada local exige que a pessoa preencha ao marcar. */
export const CAMPO_EXIGIDO_PELO_LOCAL: Record<LocalDeAgendamento, "endereco" | "url" | null> = {
  in_person: "endereco",
  phone: null,
  whatsapp: null,
  video_link: "url",
  google_meet: null,
};

/**
 * O estado do compromisso, na língua de quem usa.
 *
 * `no_show` é o único termo que não tem tradução curta em pt-br e por isso o
 * rótulo abaixo diz "Não compareceu" — a tela nunca mostra o código.
 */
export const SITUACOES_DO_AGENDAMENTO = [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
] as const;
export type SituacaoDoAgendamento = (typeof SITUACOES_DO_AGENDAMENTO)[number];

export const ROTULO_DA_SITUACAO: Record<SituacaoDoAgendamento, string> = {
  pending: "Aguardando confirmação",
  confirmed: "Confirmado",
  cancelled: "Cancelado",
  completed: "Realizado",
  no_show: "Não compareceu",
};

/**
 * As duas situações em que o compromisso ainda está DE PÉ.
 *
 * É a lista que responde "este lead tem consulta marcada?" — a pergunta que o
 * motor de follow-up e o Radar de Risco fazem antes de cobrar alguém, e que o
 * índice parcial `calendar_appointments_org_vivos_idx` serve. Cobrar "ainda
 * tem interesse?" de quem marcou para amanhã é o tipo de erro que faz
 * desinstalar o produto.
 */
export const SITUACAO_SEGURA_O_LEAD: Record<SituacaoDoAgendamento, boolean> = {
  pending: true,
  confirmed: true,
  cancelled: false,
  completed: false,
  no_show: false,
};

/**
 * As situações em que o compromisso ainda está DE PÉ, derivadas da decisão
 * acima e não escritas à mão.
 *
 * ⚠️ Aqui havia `["pending", "confirmed"]` — um array de literais —, e a
 * diferença não é estilo. Provado sabotando: acrescentei `"reagendado"` ao
 * vocabulário sem tocar em nada mais, e o array passou CALADO, enquanto os
 * `Record` exaustivos reprovaram nomeando o que faltava. Um estado novo entraria
 * no produto sem ninguém decidir se ele segura o lead — e quem paga é o motor de
 * follow-up, cobrando "ainda tem interesse?" de quem tem consulta marcada.
 *
 * O `Record` obriga a DECISÃO, não a cobertura: o compilador não deixa
 * acrescentar situação sem responder a pergunta. O achado é do @DevVivo, que
 * pagou o mesmo defeito em `SITUACOES_QUE_OCUPAM` e escreveu a regra que separa
 * os dois casos — dar consumidor a um símbolo não o torna vivo; o que importa é
 * o que QUEBRA se ele estiver errado.
 */
export const SITUACOES_VIVAS: readonly SituacaoDoAgendamento[] =
  SITUACOES_DO_AGENDAMENTO.filter((s) => SITUACAO_SEGURA_O_LEAD[s]);

/**
 * Quem marcou.
 *
 * Os valores seguem `crm_lead_activities.actor_kind` e NÃO o par
 * `human`/`agent` que a outra convenção do repo usa, porque é na timeline do
 * lead que esta autoria aparece na tela: gravar `human` aqui e `user` lá faria
 * a tela mostrar duas palavras para a mesma pessoa. `sync` é o único
 * acréscimo, e não é ator do produto — significa que a linha nasceu de um
 * evento que já existia na agenda externa.
 */
export const AUTORES_DO_AGENDAMENTO = ["user", "ai", "system", "contact", "sync"] as const;
export type AutorDoAgendamento = (typeof AUTORES_DO_AGENDAMENTO)[number];

export const ROTULO_DO_AUTOR: Record<AutorDoAgendamento, string> = {
  user: "Marcado pela equipe",
  ai: "Marcado pelo atendente de IA",
  system: "Marcado pelo sistema",
  contact: "Marcado pelo próprio cliente",
  sync: "Veio da agenda conectada",
};

/** Por qual porta o agendamento entrou. */
export const ORIGENS_DO_AGENDAMENTO = ["ui", "mcp", "google_sync", "public_page"] as const;
export type OrigemDoAgendamento = (typeof ORIGENS_DO_AGENDAMENTO)[number];

/**
 * O estado da agenda conectada.
 *
 * São os MESMOS sete valores de `tenant_integrations.status` — mesma pergunta,
 * mesma palavra. Não inventamos `needs_reauth`: o repo já tem `token_expired`.
 * E `rate_limited` entra porque uma API de calendário o produz o tempo todo,
 * ao contrário da integração de e-commerce que estreou este vocabulário.
 */
export const SITUACOES_DA_CONEXAO = [
  "connecting",
  "healthy",
  "token_expired",
  "scope_missing",
  "disconnected",
  "rate_limited",
  "error",
] as const;
export type SituacaoDaConexao = (typeof SITUACOES_DA_CONEXAO)[number];

export const ROTULO_DA_SITUACAO_DA_CONEXAO: Record<SituacaoDaConexao, string> = {
  connecting: "Conectando",
  healthy: "Conectada",
  token_expired: "Reconecte sua agenda",
  scope_missing: "Falta permissão de calendário",
  disconnected: "Desconectada",
  rate_limited: "O Google pediu para esperar",
  error: "Com erro",
};

/**
 * As situações em que o calendário conectado NÃO deve contar como ocupação.
 *
 * Fonte que não responde é pior que fonte nenhuma: contá-la faria a agenda
 * marcar em cima de compromisso real que ela não consegue mais enxergar.
 */
export const CONEXAO_CONTA_COMO_OCUPACAO: Record<SituacaoDaConexao, boolean> = {
  // ⚠️ A PERGUNTA NÃO É "esta conexão é confiável?" — É "ALGUÉM NOS PEDIU PARA
  // DEIXAR DE CONTAR?". A primeira versão deste mapa respondia a errada, e por isso
  // três linhas estavam invertidas.
  //
  // O que decide é QUEM escolheu o estado. `estadoDaConexaoApos` (google/erros.ts) só
  // grava `token_expired`, `scope_missing`, `error`, `healthy` e `rate_limited` — todos
  // decididos pelo SISTEMA, e em todos o compromisso segue existindo na agenda do
  // Google: o que parou foi a ATUALIZAÇÃO, não a existência. Não contar ali oferece um
  // horário ocupado, e o paciente chega e o médico não está (DECISÃO 3.2).
  //
  // `disconnected` é o único estado que uma PESSOA decide — a rota de desconectar é o
  // único ponto do produto que o grava. Aí sim para de contar: alguém pediu.
  //
  // A regra numa linha: BLOQUEIA, A MENOS QUE UM HUMANO TENHA MANDADO PARAR.
  connecting: false, // ainda não houve leitura: não há intervalo a contar
  healthy: true,
  rate_limited: true,
  token_expired: true,
  scope_missing: true,
  disconnected: false, // o único decidido por gente
  error: true,
};

/**
 * As situações em que o calendário conectado NÃO deve contar como ocupação —
 * derivadas da decisão acima, pelo mesmo motivo de `SITUACOES_VIVAS`.
 *
 * `rate_limited` conta: o Google pediu para esperar, mas o que ele já nos contou
 * continua verdadeiro. `connecting` não conta porque ainda não contou nada.
 * Fonte que não responde é pior que fonte nenhuma — contá-la faria a agenda
 * marcar em cima de compromisso real que ela não enxerga mais.
 */
export const CONEXOES_QUE_NAO_CONTAM: readonly SituacaoDaConexao[] =
  SITUACOES_DA_CONEXAO.filter((s) => !CONEXAO_CONTA_COMO_OCUPACAO[s]);

/** Quem fornece a agenda conectada. */
export const PROVEDORES_DE_AGENDA = ["google_calendar"] as const;
export type ProvedorDeAgenda = (typeof PROVEDORES_DE_AGENDA)[number];

/**
 * O provider do Google, para quem CONSULTA — e não só para quem tipa.
 *
 * ⚠️ ESTE SÍMBOLO EXISTE PORQUE A CONSTANTE ACIMA ERA ÓRFÃ. Ela estava aqui com
 * ZERO consumidores de produção (medido), enquanto três consultas filtravam por
 * `"google"` — um valor que o CHECK de `calendar_connections.provider` PROÍBE
 * existir. Elas casavam zero linhas por construção, e o efeito foi a conexão do
 * Google ficar invisível na v1.9.0: o botão "Conectar Google" não sumia depois de
 * conectar, a ida ao Google nunca saía, e desconectar respondia 404.
 *
 * Símbolo canônico que ninguém importa não é fonte da verdade — é documentação
 * que o compilador não confere. Um valor tipado que os call sites de fato usam é.
 *
 * A varredura que prende isso é `tests/unit/consulta-usa-o-vocabulario-do-banco`,
 * e ela é a segunda guarda de propósito: `tests/invariants/agenda-vocabulario`
 * compara o CHECK do banco com a constante e fica VERDE, porque o valor errado
 * não estava em nenhum dos dois — estava no literal dentro do `.eq()`.
 */
export const PROVEDOR_GOOGLE: ProvedorDeAgenda = "google_calendar";

/** O que o Google diz sobre um evento ocupar ou não a hora. */
export const TRANSPARENCIAS_EXTERNAS = ["opaque", "transparent"] as const;
export type TransparenciaExterna = (typeof TRANSPARENCIAS_EXTERNAS)[number];

/** O estado de um evento na agenda de fora. */
export const SITUACOES_EXTERNAS = ["confirmed", "tentative", "cancelled"] as const;
export type SituacaoExterna = (typeof SITUACOES_EXTERNAS)[number];

/**
 * O vínculo do agendamento com o negócio, em `crm_lead_links`.
 *
 * `target_kind` já aceitava `'appointment'` no CHECK daquela tabela antes desta
 * feature existir. `link_kind`, ao contrário, é coluna SEM CHECK — vocabulário
 * aberto, e é por isso que ela fica fora do invariante de vocabulário, que só
 * cobre coluna que já tem CHECK. O que a prende é esta constante: quem escreve
 * o vínculo usa daqui, nunca a string solta.
 */
export const ALVO_DE_VINCULO_DO_AGENDAMENTO = "appointment" as const;
export const VINCULO_DE_AGENDAMENTO = "scheduled" as const;

/**
 * O `entity_kind` do compromisso no `event_log`.
 *
 * É a TABELA no singular (`calendar_appointments` → `calendar_appointment`), e
 * não o `appointment` do vínculo acima: são vocabulários de tabelas diferentes,
 * e o motor de regras compara este valor contra `EXPECTED_ENTITY_KIND` para
 * decidir se o evento é dele. Aproximar as duas strings porque "parecem a mesma
 * coisa" faria o motor descartar todo gatilho de agenda em silêncio, como
 * `entity_kind_mismatch` — que é exatamente o defeito que aquele guard existe
 * para pegar em `lead` vs `crm_lead`.
 */
export const ENTIDADE_DO_AGENDAMENTO = "calendar_appointment" as const;

/**
 * O nome a usar quando o tipo do compromisso não pôde ser lido.
 *
 * ⚠️ É FALLBACK, NÃO PADRÃO. Ele descreve a categoria, não o atendimento, e
 * nenhuma condição de automação escrita por um operador vai casar com ele de
 * propósito. Existe só para o caso real de o tipo ter sido apagado depois do
 * compromisso ter nascido — o caminho normal lê `calendar_event_types.name`.
 *
 * Enquanto esta string era digitada como literal dentro dos handlers, ela ERA o
 * caminho normal em três dos quatro gatilhos, e o efeito foi uma condição
 * decorativa: a tela oferece "Tipo de atendimento contém …", a pessoa configura,
 * salva, e a regra nunca dispara porque o payload sempre dizia "Agendamento".
 */
export const NOME_GENERICO_DO_TIPO = "Agendamento" as const;

/**
 * O tipo de atividade que o agendamento emite na timeline do lead.
 *
 * `crm_lead_activities.type` é vocabulário ABERTO e não tem CHECK — de
 * propósito: um clone com tipo legado quebraria no `update.sh`. O que dá
 * garantia aqui é o compilador, através da união `ActivityType` de
 * `lib/leads/activity-vocabulary.ts`.
 *
 * ⚠️ `crm_lead_activities.lead_id` é NOT NULL, então um agendamento de contato
 * que ainda não virou lead NÃO consegue emitir atividade. O produto já resolveu
 * isso uma vez: `emitAgentActivityForContact` resolve o lead ativo a partir do
 * contato e, quando não consegue rotear, grava em `event_log` em vez de perder
 * o evento. Quem emitir daqui reusa aquele caminho, não inventa um terceiro.
 */
export const ATIVIDADES_DA_AGENDA = [
  "appointment_scheduled",
  "appointment_rescheduled",
  "appointment_cancelled",
  "appointment_completed",
  "appointment_no_show",
] as const satisfies readonly ActivityType[];
export type AtividadeDaAgenda = (typeof ATIVIDADES_DA_AGENDA)[number];

/**
 * ⚠️ O `satisfies` ACIMA É A AMARRA — não é decoração de tipo.
 *
 * Esta lista vive aqui; `ActivityType` vive em
 * `lib/leads/activity-vocabulary.ts`, e é ele que `emitLeadActivity` exige. Por
 * um tempo as duas não se conheciam: esta tinha ZERO consumidor e nenhum dos
 * cinco valores estava lá — duplicação sem source of truth declarado, o
 * anti-pattern nº 2 do `CLAUDE.md`, dentro de um arquivo que existe para ser a
 * fonte única.
 *
 * Com o `satisfies`, acrescentar valor aqui e esquecer de lá não compila. E a
 * forma importa: uma variável-guarda separada também reprova, mas o erro aponta
 * para a LINHA DA GUARDA, e quem o recebe precisa descer três níveis de
 * aninhamento para achar qual valor era. O `satisfies` aponta para o VALOR:
 *
 *   Type '"appointment_inventado"' is not assignable to type 'ActivityType'
 *
 * (Medido pelo Arquiteto com `tsc` de verdade, sabotando as duas formas, e
 * reproduzido aqui. Ele também conferiu que o `satisfies` não quebra o extrator
 * do invariante de vocabulário — o regex casa `] as const` e para antes dele.)
 */

/**
 * A TRILHA de cor da pessoa — o número, não a cor.
 *
 * ⚠️ Aqui havia oito hex literais, e estavam errados. A cor mora em
 * `app/globals.css`, nas variáveis `--agenda-pessoa-1..8`, e cada trilha tem
 * hex DIFERENTE por tema — medido: a trilha 1 é `#ac4d40` no claro e `#f89080`
 * noutro bloco. Um hex guardado aqui (ou numa coluna do banco) seria o segundo
 * lugar para a mesma verdade, e o tema escuro ficaria de fora.
 *
 * O argumento é do @VPS, no cabeçalho de `components/agenda/paleta.ts`, e ele
 * está certo: este módulo escolhe QUAL trilha, nunca QUE cor. Quem traduz
 * trilha em cor é `corDaTrilha()`, do lado da tela, que devolve a variável CSS.
 */
export const TRILHAS_DA_AGENDA = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type TrilhaDaAgenda = (typeof TRILHAS_DA_AGENDA)[number];

/**
 * A trilha de quem ainda não escolheu uma — estável, para a mesma pessoa não
 * trocar de cor entre um carregamento e outro.
 *
 * Deriva do `user_id` e não da posição na lista de membros, e a diferença é
 * concreta: derivar da posição faz todo mundo trocar de cor quando alguém entra
 * na equipe.
 *
 * A pessoa nasce sem trilha escolhida de propósito — ninguém deveria precisar
 * configurar cor antes de ver a própria agenda funcionando.
 */
export function trilhaPadraoDoMembro(userId: string): TrilhaDaAgenda {
  let soma = 0;
  for (let i = 0; i < userId.length; i += 1) {
    soma = (soma * 31 + userId.charCodeAt(i)) % 1_000_003;
  }
  const trilha = TRILHAS_DA_AGENDA[soma % TRILHAS_DA_AGENDA.length];
  // O índice é sempre válido (módulo do tamanho), mas o TypeScript não sabe
  // disso com `noUncheckedIndexedAccess`.
  return trilha ?? TRILHAS_DA_AGENDA[0];
}

/**
 * As trilhas de uma EQUIPE, sem duas pessoas na mesma cor.
 *
 * ⚠️ `trilhaPadraoDoMembro` sozinha não resolve isto, e não é defeito dela: ela é
 * um hash módulo 8, e hash dá ESTABILIDADE (a mesma pessoa sempre na mesma cor),
 * nunca DISTINÇÃO. Com 5 pessoas e 8 trilhas, a chance de pelo menos uma colisão
 * passa de 60% — e medido nesta organização, duas pessoas caíram na trilha 7.
 *
 * O sintoma é o que o sistema de cores existe para impedir: na grade, duas
 * pessoas viram uma só, e quem olha não distingue de quem é o compromisso.
 *
 * ─── Por que não ordenar e distribuir 1..8 ───────────────────────────────
 *
 * Porque aí a cor de cada um passa a depender de QUEM MAIS está na lista: entra
 * alguém novo e a equipe inteira troca de cor. A cor deixaria de ser aprendível,
 * que é a razão de ela existir.
 *
 * ─── O que esta função faz ───────────────────────────────────────────────
 *
 * Parte do hash — todo mundo fica na cor de sempre — e resolve APENAS as
 * colisões, avançando para a próxima trilha livre. Quem chegou primeiro na
 * ordem estável (o id) mantém a sua; só quem colidiu se move. Trocar a ordem de
 * entrada não muda o resultado, porque a ordenação é pelo id e não pela chegada.
 *
 * Com mais pessoas do que trilhas, a repetição volta — e aí é inevitável: são
 * oito cores. Quando isso acontecer, a resposta é mais trilhas na paleta, não
 * mais lógica aqui.
 */
export function trilhasDaEquipe(userIds: readonly string[]): Map<string, TrilhaDaAgenda> {
  const resultado = new Map<string, TrilhaDaAgenda>();
  const ocupadas = new Set<TrilhaDaAgenda>();
  // Ordem estável e independente de como a lista chegou.
  for (const id of [...userIds].sort()) {
    if (resultado.has(id)) continue;
    const inicio = TRILHAS_DA_AGENDA.indexOf(trilhaPadraoDoMembro(id));
    let escolhida = trilhaPadraoDoMembro(id);
    for (let passo = 0; passo < TRILHAS_DA_AGENDA.length; passo += 1) {
      const candidata = TRILHAS_DA_AGENDA[(inicio + passo) % TRILHAS_DA_AGENDA.length];
      if (candidata !== undefined && !ocupadas.has(candidata)) {
        escolhida = candidata;
        break;
      }
    }
    ocupadas.add(escolhida);
    resultado.set(id, escolhida);
  }
  return resultado;
}

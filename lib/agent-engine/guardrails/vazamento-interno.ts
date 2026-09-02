/**
 * Detector determinístico de VAZAMENTO DE VOCABULÁRIO INTERNO — a "rede" descrita em
 * `docs/doctrine/separacao-fala-e-operacao.md`. Dispara quando a candidata a envio
 * carrega, para o CLIENTE FINAL, palavra que só existe dentro do sistema: nome de
 * ferramenta, nome de tabela/coluna, papel de acesso, termo de arquitetura ou erro cru.
 *
 * ⚠️ POR QUE EXISTE, medido com LLM real (`gpt-5.6-terra`), três vazamentos:
 *   - `Role 'agent' insufficient (required: 'manager')` virou "seu perfil atual é agent,
 *     e essa alteração exige permissão de manager";
 *   - uma `description` com "(webhook_sources)" virou "nenhuma entrada automática de
 *     contatos (webhook) configurada";
 *   - depois de limpar a description, o vazamento VOLTOU pelo `name` da tool
 *     (`crm_list_webhook_sources`). `name` é contrato de wire e não se renomeia — só se
 *     fecha não mostrando.
 * A cura é o Conversador nunca ter visto esse vocabulário (turno 1 / turno 2 da doutrina).
 * Isto aqui é a REDE: vale sozinha porque transforma "acho que vaza" em NÚMERO medido,
 * antes de qualquer refatoração.
 *
 * ═══ A REGRA CENTRAL: caçar FORMA, nunca SIGNIFICADO DE NEGÓCIO ═══
 *
 * Um detector que cace o SENTIDO ("etapa", "funil", "marcador") banindo palavra de
 * negócio destrói a conversa — e não é hipótese: `fn_seed_default_pipeline_for_org`
 * (`supabase/baseline.sql`) cria etapas chamadas "Aguardando pagamento", "Em separação",
 * "Entregue"; nome de etapa é vocabulário do CLIENTE, e o tenant renomeia à vontade.
 * Pior: a frase-modelo que este repo documenta como o resultado CORRETO —
 *   «A etapa "Retorno pos-cirurgico" ainda não existe no funil, mas não consigo criá-la
 *    por aqui. Peça para alguém do time adicioná-la no fim do funil.»
 * — contém "etapa" e "funil". Um gate que cace essas palavras bane a única resposta boa
 * documentada. Por isso todas as regras abaixo caçam FORMA (identificador técnico) ou
 * palavra de arquitetura que não tem tradução de negócio nenhuma.
 *
 * ═══ O NÚMERO: uma sonda de 102 frases reais, 5 nichos ═══
 *
 * A primeira versão deste detector calava **27 das 102** frases de uma sonda de
 * atendimento brasileiro real (clínica, loja, imobiliária, infoproduto, serviços) — 24
 * delas legítimas. Um gate que cala 1 em cada 4 mensagens boas é pior que gate nenhum: o
 * time desliga, e junto vai a rede. Sete correções depois, medido no mesmo corpus: **11
 * barradas, 8 falso-positivo**, sem perder nenhum dos vazamentos medidos nem os controles.
 *
 * Cada correção tem o seu bloco de comentário abaixo, e três padrões se repetem — valem
 * como aviso para a próxima regra que alguém for acrescentar aqui:
 *   1. **Regra que descasca antes de proteger** vira buraco silencioso (o `@` sumindo do
 *      token antes da checagem de endereço).
 *   2. **Palavra inglesa que também é palavra portuguesa** (`role`/rolar, `agent`/agente)
 *      só sobrevive em contexto — e o contexto não pode ser feito de palavra portuguesa
 *      comum (`papel`, `perfil`), senão volta a calar.
 *   3. **Normalizar cedo demais destrói o sinal**: a caixa era a única coisa que separava
 *      `crm_list_leads` de `PED_2024_001`, e era apagada antes da varredura.
 *
 * Calibração congelada em `tests/unit/vazamento-interno-detector.test.ts`: as frases da
 * sonda que NÃO podem barrar, os vazamentos medidos e os controles que DEVEM barrar, e o
 * resíduo de falso-positivo ACEITO — congelado, não escondido. Regressão reprova o CI.
 */
import { TOOL_CATALOG, catalogEntry } from '@/lib/mcp/tools/catalog';
import { CHANNEL_CAPABILITIES } from '@/lib/channels/capabilities';

/** Categoria da regra que pegou o termo — vai ao trace (rótulo nosso, nunca o corpo). */
export type CategoriaVazamento = 'snake_case' | 'tool' | 'papel' | 'arquitetura' | 'erro_cru';

export interface VazamentoInterno {
  achou: boolean;
  /**
   * Os termos detectados, em ordem de aparição, sem repetição. Servem ao VETO: ele
   * nomeia o que barrou e ensina o que escrever no lugar (um veto que só nega faz o
   * modelo tentar de novo igual). NÃO vão ao log — são trecho da candidata.
   */
  termos: string[];
  /** Categorias acionadas, ordenadas. É isto (não o termo) que pode ir ao trace. */
  categorias: CategoriaVazamento[];
}

/** Uma regra de texto: `re` acha, `rotulo` nomeia (ausente = usa o próprio trecho casado). */
interface RegraTexto {
  readonly categoria: CategoriaVazamento;
  readonly re: RegExp;
  readonly rotulo?: string;
}

/**
 * (D) ARQUITETURA PURA — palavras que descrevem o encanamento e não têm significado de
 * negócio nenhum em pt-BR. `payload`/`schema` nunca são a palavra que um cliente usa; se
 * aparecem na mensagem, vieram do sistema. Plural opcional porque "webhooks configurados"
 * é a forma mais provável de vazar.
 *
 * `api` ficou de FORA de propósito: além de aparecer em copy legítima de empresa de
 * tecnologia, o repo já foi mordido por casá-la como substring dentro de "rapidamente".
 * Aqui TODA regra usa fronteira de palavra — mas o custo/benefício de `api` não paga.
 *
 * ⚠️ CINCO PALAVRAS SAÍRAM DESTA LISTA, medidas numa sonda de 102 frases reais de
 * atendimento brasileiro (5 nichos). Todas pela MESMA razão do `api`, e todas com o mesmo
 * placar: ZERO vazamento medido, ≥1 falso-positivo medido.
 *   - `backend`, `json`, `sdk` — quem VENDE tecnologia diz isso ao cliente dele: "modulo 4
 *     é sobre backend", "o curso cobre JSON", "tem um SDK pronto". Copy legítima.
 *   - `supabase`, `postgres` — são o nome dos NOSSOS fornecedores de infra. Um curso que
 *     ensina "Supabase e Postgres do zero" é fala do tenant, não do sistema.
 * O critério para tirar não é gosto: é o placar. Palavra com vazamento MEDIDO fica (ver
 * `webhook` abaixo); palavra sem vazamento medido e com FP medido sai.
 *
 * `webhook` FICOU, e a decisão é assimétrica de propósito. É a única palavra desta lista
 * com vazamento MEDIDO com LLM real ("nenhuma entrada automática de contatos (webhook)
 * configurada" — o modelo parafraseando `webhook_sources`). Tirá-la reabre exatamente o
 * defeito que este módulo veio fechar. O custo aceito está registrado: para o tenant
 * AGÊNCIA — que revende integração e diz "a gente configura o webhook do seu sistema" — o
 * gate cobra uma reescrita. É FP conhecido, e a saída certa para ele é lista por
 * organização, deliberadamente NÃO implementada aqui (config sem demanda medida é
 * especulação; o fail-safe de `MAX_VETOS_DE_VOCABULARIO_INTERNO` já garante que o custo
 * do FP é um turno a mais, nunca um cliente mudo).
 */
const PALAVRAS_ARQUITETURA = [
  'webhook',
  'endpoint',
  'payload',
  'uuid',
  'schema',
  'mcp',
  'rls',
  'migration',
  'pointer',
  'enrollment',
] as const;

/**
 * Os nomes de provider de canal — DERIVADOS de `lib/channels/`, nunca escritos aqui.
 *
 * ⚠️ ESTE ARQUIVO JÁ FOI REPROVADO POR ESCREVER UM NOME DE PROVIDER À MÃO, e a ironia é
 * literal: o detector de vocabulário interno vazava vocabulário interno. Quem
 * pegou foi `pnpm lint:channels` no CI (doutrina `restricao-de-canal`,
 * invariante 1: nome de provider só vive em `lib/channels/`, INCLUSIVE em comentário)
 * — não os testes, não
 * o typecheck, não o lint padrão.
 *
 * Derivar em vez de copiar é a mesma decisão que já vale para os nomes de tool
 * logo acima: provider novo entra na cobertura sozinho, e a lista não envelhece
 * mentindo. `lib/channels/capabilities.ts` importa só tipos — não arrasta peso
 * para dentro deste módulo puro.
 */
const PROVIDERES_DE_CANAL = Object.keys(CHANNEL_CAPABILITIES);

/**
 * (C) PAPEL/PERMISSÃO — o vocabulário de controle de acesso. Nenhuma destas é palavra
 * portuguesa: "manager"/"scope"/"insufficient" são do sistema, e `admin` com fronteira
 * de palavra não casa "administração"/"administrativo".
 *
 * DUAS palavras da lista original saíram daqui para a caça EM CONTEXTO (abaixo), pela
 * MESMA razão — são inglês que existe em pt-BR:
 *   - `agent` está a uma letra de "agente", a palavra mais comum do domínio deste
 *     produto ("nosso agente de IA");
 *   - `role` é o imperativo de *rolar*. **Medido**: uma sonda com frases reais de
 *     atendimento pegou `\brole\b` barrando "Role a tela pra baixo que aparece o botão"
 *     — instrução legítima, cliente mudo. Não era hipótese.
 * Nenhuma das duas custa nada em contexto: os três vazamentos medidos carregam
 * `manager`/`insufficient`/`perfil` junto, e esses continuam disparando sozinhos.
 */
const PALAVRAS_PAPEL = ['manager', 'insufficient', 'requiresrole', 'scope'] as const;

/**
 * `admin` saiu da alternação simples acima porque as regras de texto rodam sobre o CORPO
 * INTEIRO — sem a proteção por token que a regra (A) tem. Resultado medido: `\badmin\b`
 * casava DENTRO de `admin@minhaloja.com.br`, e o e-mail que o cliente PEDIU virava
 * mensagem calada. É o mesmo falso-positivo que `pareceEnderecoOuArquivo` já evita no
 * snake_case, e a cura é a mesma ideia: `admin` colado a `@`, ou seguido de `.` + letra
 * (domínio), é endereço — não papel de acesso.
 *
 * `admin` SOLTO continua barrando ("vou pedir pro admin liberar seu acesso"), e isso é
 * decisão, não resíduo: `admin` é literalmente o vocabulário de controle de acesso que
 * este gate existe para não deixar chegar ao cliente, e a saída em português — "o
 * administrador da conta" — já passa (está na calibração desde o primeiro dia, e
 * `\badmin\b` nunca casou "administrador").
 */
const RE_ADMIN = /(?<![\w@.])admins?\b(?!@|\.[a-z])/g;

/**
 * Vizinhança que torna `agent` inequivocamente de PAPEL/ACESSO. Inclui `papel`/`perfil`
 * porque o vazamento medido é exatamente "seu perfil atual é agent".
 */
const CTX_PAPEL_AGENT = '(?:manager|admin|insufficient|required|scope|permissao\\w*|papel|perfil)';

/**
 * O MESMO contexto, menos `papel` e `perfil` — e a diferença é a correção mais reincidente
 * deste módulo. `role` é o imperativo de *rolar*, e "role a tela … perfil" / "role a tela …
 * papel timbrado" são instrução de atendimento comuníssima: a sonda de 102 frases pegou
 * QUATRO mensagens legítimas caladas por esta única sobreposição, em três nichos
 * diferentes. `papel` e `perfil` são palavras portuguesas ordinárias; usá-las como prova
 * de que `role` é substantivo inglês foi o erro.
 *
 * Custo do corte: ZERO nos vazamentos medidos. Os três que carregam `role` trazem
 * `manager`/`insufficient`/`required` junto («Role 'agent' insufficient (required:
 * 'manager')», «a role exigida e manager»), e esses continuam disparando — mais a forma
 * citada (`role '…'`), que nunca é o verbo.
 */
const CTX_PAPEL_ROLE = '(?:manager|admin|insufficient|required|scope|permissao\\w*)';

/**
 * Casa `palavra` só quando um termo de papel/acesso está a ≤24 caracteres, nos DOIS
 * sentidos (a mesma frase com a ordem trocada é a mesma frase). A lacuna não cruza fim
 * de sentença — senão o "perfil" de uma oração casaria com o "agent" de outra.
 */
function comContextoDePapel(palavra: string, ctx: string, extra?: string): RegExp {
  const alternativas = [
    `\\b${palavra}\\b[^.!?\\n]{0,24}?\\b${ctx}\\b`,
    `\\b${ctx}\\b[^.!?\\n]{0,24}?\\b${palavra}\\b`,
    ...(extra === undefined ? [] : [extra]),
  ];
  return new RegExp(alternativas.join('|'), 'g');
}

/** Alternação com fronteira de palavra e plural opcional. Nunca substring. */
function alternacao(palavras: ReadonlyArray<string>): RegExp {
  return new RegExp(`\\b(?:${palavras.join('|')})s?\\b`, 'g');
}

/** `nome.ts|tsx|sql` — só com barra de caminho antes, ou com palavra de erro por perto. */
const ARQ = '[a-z0-9_-]+\\.(?:ts|tsx|sql)';
const CTX_ERRO = '(?:erro\\w*|error|falh\\w*|exception|stack|trace)';
const RE_ARQUIVO_DE_CODIGO = new RegExp(
  [
    `[a-z0-9_.-]*\\/[a-z0-9_./-]*${ARQ}\\b`,
    `\\b${CTX_ERRO}\\b[^.!?\\n]{0,32}?\\b${ARQ}\\b`,
    `\\b${ARQ}\\b[^!?\\n]{0,32}?\\b${CTX_ERRO}\\b`,
  ].join('|'),
  'g',
);

const REGRAS: ReadonlyArray<RegraTexto> = [
  { categoria: 'arquitetura', re: alternacao([...PALAVRAS_ARQUITETURA, ...PROVIDERES_DE_CANAL]) },
  { categoria: 'papel', re: alternacao(PALAVRAS_PAPEL) },
  { categoria: 'papel', rotulo: 'admin', re: RE_ADMIN },
  // (C-bis) as duas ambíguas, só em contexto de papel. "seu perfil atual é agent" é a
  // frase medida que nenhuma outra regra pega sozinha.
  { categoria: 'papel', rotulo: 'agent', re: comContextoDePapel('agent', CTX_PAPEL_AGENT) },
  // `role` ganha também a forma citada — `Role 'agent'`, exatamente como o erro cru
  // chegou ao modelo. Aspa depois de "role" nunca é o verbo rolar.
  {
    categoria: 'papel',
    rotulo: 'role',
    re: comContextoDePapel('roles?', CTX_PAPEL_ROLE, '\\broles?\\b\\s*[\'"«]'),
  },
  { categoria: 'papel', rotulo: 'permissão insuficiente', re: /\bpermissao\w*\s+insuficiente\w*\b/g },
  // (C-ter) HTTP 403 só em contexto de status. `\b403\b` sozinho barraria "R$ 403,00" —
  // um preço vira mensagem calada, e preço é justamente o que este produto conversa.
  //
  // `codigo|code` saiu da alternância por medição: "Seu codigo e 403" é código de
  // rastreio/verificação/pedido, o uso mais banal de "código" no atendimento brasileiro —
  // e o único que a palavra `codigo` acrescentava era esse. `erro|error|status|http`
  // cobrem a forma em que o 403 realmente vaza (e cobrem o vazamento medido "erro 403").
  {
    categoria: 'papel',
    rotulo: '403',
    re: /\b(?:erro|error|status|http)\b[^.!?\n]{0,12}?\b403\b|\b403\b\s*(?:forbidden|unauthorized)\b/g,
  },
  // (E2) IDENTIFICADOR OPACO — a segunda porta, achada medindo turno real: um UUID
  // de usuário chegou à tela do cliente. Detector de PALAVRA não pega isto, porque
  // não há palavra: é FORMA.
  //
  // O formato 8-4-4-4-12 hex não colide com nada que o cliente reconheça — número
  // de pedido (`2026-00815`), NUIT e data têm outra forma, e todos foram
  // medidos passando limpo. Um identificador assim NUNCA significa nada para quem
  // lê: se o agente precisa referenciar algo, referencia pelo nome ou pelo número
  // que o cliente conhece.
  {
    categoria: 'erro_cru',
    rotulo: 'identificador interno',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  // (E3) CÓDIGO DE ERRO OPACO — a outra metade da terceira porta: o código veio do
  // DADO que a tool devolveu, não do nome dela.
  //
  // Os códigos canônicos com underscore (`lead_not_found`) já caem na regra (A) de
  // snake_case — medido. Aqui ficam só os que ESCAPAM dela: SQLSTATE do Postgres e
  // código do PostgREST.
  //
  // ⚠️ SQLSTATE EXIGE VIZINHANÇA DE ERRO. Cinco dígitos soltos são ambíguos: o
  // pedido `2026-00815` do cliente tem cinco. Sem o contexto, o gate barraria a
  // frase que o cliente mais precisa ouvir.
  {
    categoria: 'erro_cru',
    rotulo: 'código de erro do banco',
    re: /\b(?:erro|error|falh\w+|code|código|codigo)\b[^.!?\n]{0,20}?\b\d{5}\b|\b\d{5}\b[^.!?\n]{0,12}?\b(?:erro|error)\b/gi,
  },
  { categoria: 'erro_cru', rotulo: 'código PostgREST', re: /\bPGRST\d{3}\b/gi },
  // (E) ERRO CRU — o texto que a máquina escreveu para a máquina.
  { categoria: 'erro_cru', rotulo: 'Error:', re: /\berror\s*:/g },
  { categoria: 'erro_cru', re: /\b(?:typeerror|referenceerror|syntaxerror|rangeerror)\b/g },
  { categoria: 'erro_cru', rotulo: 'duplicate key value', re: /\bduplicate key value\b/g },
  { categoria: 'erro_cru', rotulo: 'null value in column', re: /\bnull value in column\b/g },
  // stack trace: a linha "    at algo (arquivo:12:5)". Exige o `at` no começo da linha E
  // o par linha:coluna — só `:\d+:\d+` casaria "(das 8:00:00)".
  { categoria: 'erro_cru', rotulo: 'stack trace', re: /(?:^|\n)\s*at\s+\S+[^\n]*:\d+:\d+/g },
  // nome de arquivo de código. Fica FORA da regra (A) de propósito: lá, token com ponto
  // colado é excluído para não confundir e-mail/URL com identificador.
  //
  // ⚠️ EXIGE CAMINHO OU VIZINHANÇA DE ERRO — a extensão sozinha não prova nada, medido:
  // `.ts` é também container de vídeo do mundo real ("seu arquivo gravacao.ts não abriu,
  // manda em mp4?") e `.sql` é material de curso ("baixa o script banco.sql e roda"). As
  // duas frases são de tenants deste produto, não do sistema. O que denuncia o arquivo
  // NOSSO é a barra do caminho (`lib/guardrails/before-send.ts`) ou o erro ao lado —
  // porque o vazamento que interessa é o stack/log cru, não a menção a um arquivo.
  { categoria: 'erro_cru', rotulo: 'arquivo de código', re: RE_ARQUIVO_DE_CODIGO },
];

/**
 * (B) NOMES DE TOOL — DERIVADOS em runtime do catálogo MCP, nunca copiados: tool nova
 * entra sozinha, e uma lista copiada envelhece no dia seguinte.
 *
 * ⚠️ Duas escolhas de acoplamento, ambas medidas:
 *
 * 1. Deriva do `TOOL_CATALOG` (hoje 51 capacidades `crm_*` — o comentário dizia 31, medido
 *    e corrigido; é justamente o número que o código NÃO usa, por isso envelheceu calado)
 *    porque `lib/mcp/tools/catalog` é
 *    client-safe por contrato do próprio módulo — zero zod, zero supabase, zero
 *    next/headers; o grafo de runtime dele é só dado. Importar daqui não arrasta nada.
 * 2. NÃO deriva de `AGENT_TOOL_DEFS` (as 12 nativas), que vive em
 *    `lib/agent-engine/agent/inbound-turn.ts`. Importá-lo criaria ciclo
 *    (inbound-turn → before-send → este módulo → inbound-turn) E arrastaria o motor
 *    inteiro (AI SDK, pg, canal) para dentro de um detector puro. As 12 são todas
 *    snake_case, então a regra (A) já as pega — e quem PROVA isso é
 *    `tests/unit/vazamento-interno-detector.test.ts`, que importa `AGENT_TOOL_DEFS` (um
 *    teste pode pagar o peso) e exige que cada uma seja detectada. Tool nativa nova que
 *    escape reprova o CI.
 *
 * Uma tool de PALAVRA ÚNICA (sem `_`) seria perigosa aqui — banir uma palavra solta é o
 * erro que a regra central proíbe. Hoje as 43 têm `_`; o teste acima trava isso.
 */
const NOMES_DE_TOOL = TOOL_CATALOG.map((t) => t.name);
const RE_NOMES_DE_TOOL = new RegExp(`\\b(?:${NOMES_DE_TOOL.join('|')})\\b`, 'g');

/**
 * (A) SNAKE_CASE — a regra de maior alcance e menor falso-positivo. Nenhuma frase
 * natural em pt-BR tem underscore no meio de uma palavra; todo identificador técnico
 * desta base tem. Pega as 43 tools, as ~96 tabelas, colunas e slugs (`em_separacao`).
 *
 * ⚠️ EXIGE MINÚSCULAS, e por isso a varredura desta regra roda sobre o texto com a CAIXA
 * PRESERVADA (as outras rodam sobre o normalizado). É a correção de maior rendimento
 * medido, e não é heurística de gosto — é uma diferença estrutural entre dois mundos:
 *   - identificador técnico desta base é sempre lowercase. VERIFICADO no HEAD, não
 *     deduzido: 31 nomes de tool no `TOOL_CATALOG`, 12 em `AGENT_TOOL_DEFS`, 343 colunas e
 *     59 tabelas em `supabase/baseline.sql` (65 somando `supabase/migrations/`) — ZERO com
 *     maiúscula. Exigir minúsculas não solta nenhuma tool, tabela nem coluna. O que segura
 *     essa premissa contra o futuro é um teste sobre as tools no arquivo de calibração;
 *     tabela/coluna nova em maiúscula quebraria antes o resto do repo.
 *   - código de NEGÓCIO é gritado em maiúsculas: `PED_2024_001`, `CUPOM_VERAO10`,
 *     `#BLACK_FRIDAY`. Eram falso-positivo porque a varredura inteira rodava sobre o texto
 *     já em minúsculas — a informação que separa os dois mundos morria antes de ser usada.
 * O preço é um falso-negativo estreito: um vazamento GRITADO (`CRM_LIST_LEADS`) escapa.
 * Não é o que se mede na prática — o modelo copia o nome do wire, e o wire é minúsculo.
 */
const RE_SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Token que é endereço (e-mail/URL) ou nome de arquivo — fora da regra (A).
 *
 * O underscore em `contato_vendas@empresa.com` ou em `site.com/promo_verao` é do
 * endereço, não do sistema; barrar um e-mail que o cliente PEDIU seria o falso-positivo
 * mais caro possível. A cauda `.xx`/`.xx.yy` cobre domínio e extensão de arquivo (o
 * arquivo de código continua sendo pego pela regra (E), que existe para isso).
 *
 * `crm_leads.organization_id` NÃO cai aqui de propósito: a cauda depois do último ponto
 * tem underscore, não parece TLD — e um par tabela.coluna é exatamente o que se quer pegar.
 */
function pareceEnderecoOuArquivo(token: string): boolean {
  return token.includes('@') || token.includes('/') || /\.[a-z]{2,4}(?:\.[a-z]{2,3})?$/.test(token);
}

/**
 * Remove diacríticos (NFD) e PRESERVA a caixa. É esta a base das duas visões do texto: a
 * regra (A) varre esta (a caixa é o dado que separa `crm_leads` de `PED_2024_001`), as
 * demais varrem a versão em minúsculas. Como só diferem por `toLowerCase()`, os índices
 * batem — e `posicao` só ordena os achados.
 */
function semDiacriticos(body: string): string {
  return body.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

interface Achado {
  termo: string;
  categoria: CategoriaVazamento;
  posicao: number;
}

/**
 * Varre os tokens separados por espaço em busca de identificador snake_case (regra A).
 *
 * Trabalha por TOKEN, não por regex sobre o texto todo, porque a exclusão de
 * e-mail/URL/arquivo precisa enxergar o token INTEIRO — um lookbehind sobre o texto
 * corrido erraria a fronteira e a pontuação de fim de frase ("em_separacao.") viraria
 * falso-negativo silencioso.
 */
function achaSnakeCase(texto: string): Achado[] {
  const achados: Achado[] = [];
  const tokenRe = /\S+/g;
  for (const t of texto.matchAll(tokenRe)) {
    const bruto = t[0];
    const inicio = t.index;
    // MENÇÃO e HASHTAG são vocabulário de rede social, nunca identificador de sistema —
    // nenhuma tool, tabela ou coluna começa com `@` ou `#`. Este teste vem ANTES do
    // descascamento porque era exatamente aí que estava o bug (ver abaixo).
    if (bruto.startsWith('@') || bruto.startsWith('#')) continue;
    // Descasca só a pontuação de fora; `_` é caractere de palavra e fica.
    const core = bruto.replace(/^[^A-Za-z0-9_]+/, '').replace(/[^A-Za-z0-9_]+$/, '');
    if (core === '') continue;
    // ⚠️ Testa o token BRUTO **e** o descascado, e a ordem importa. O bug medido: o
    // descascamento tirava o `@` de fora do token ANTES de `pareceEnderecoOuArquivo`
    // rodar, então `@loja_da_ana` chegava aqui como `loja_da_ana` — a proteção de
    // endereço nunca disparava e o @ do Instagram do cliente virava "identificador de
    // sistema". Sonda que expôs a incoerência: `@loja_da_ana` barrava enquanto
    // `instagram.com/loja_da_ana`, o MESMO nome, passava.
    if (pareceEnderecoOuArquivo(bruto.toLowerCase()) || pareceEnderecoOuArquivo(core.toLowerCase())) {
      continue;
    }
    for (const m of core.matchAll(RE_SNAKE_CASE)) {
      achados.push({ termo: m[0], categoria: 'snake_case', posicao: inicio + m.index });
    }
  }
  return achados;
}

/**
 * True se a candidata leva vocabulário interno ao cliente. Determinístico, sem I/O.
 * Vazio/whitespace = false.
 */
export function detectarVazamentoInterno(body: string): VazamentoInterno {
  if (body.trim() === '') return { achou: false, termos: [], categorias: [] };
  // Duas visões do MESMO texto: a regra (A) precisa da caixa (ver `RE_SNAKE_CASE`), todas
  // as outras precisam da uniformidade de minúsculas.
  const comCaixa = semDiacriticos(body);
  const texto = comCaixa.toLowerCase();

  const achados: Achado[] = achaSnakeCase(comCaixa);
  for (const m of texto.matchAll(RE_NOMES_DE_TOOL)) {
    achados.push({ termo: m[0], categoria: 'tool', posicao: m.index });
  }
  for (const regra of REGRAS) {
    for (const m of texto.matchAll(regra.re)) {
      achados.push({ termo: regra.rotulo ?? m[0], categoria: regra.categoria, posicao: m.index });
    }
  }
  if (achados.length === 0) return { achou: false, termos: [], categorias: [] };

  achados.sort((a, b) => a.posicao - b.posicao);
  const termos: string[] = [];
  const categorias = new Set<CategoriaVazamento>();
  for (const a of achados) {
    if (!termos.includes(a.termo)) termos.push(a.termo);
    categorias.add(a.categoria);
  }
  return { achou: true, termos, categorias: [...categorias].sort() };
}

/**
 * O veto escrito para o MODELO — nomeia o termo E diz a SAÍDA.
 *
 * Um veto que só nega faz o modelo tentar de novo igual, e o turno morre em silêncio
 * (o oposto do invariante 4 do sistema vivo). Quando o termo é uma tool conhecida, o
 * `rotulo` do catálogo (já em português, escrito para o humano que configura o agente)
 * entra como a tradução que faltava — a mesma ideia de `lib/mcp/recusa-para-o-modelo.ts`.
 *
 * Não manda "ofereça que alguém do time verifique" de propósito: essa saída trombaria
 * com o `casePromiseGate`, que veta promessa-de-humano sem caso aberto. Um veto que
 * empurra o modelo para o veto seguinte não ensina, só empurra o problema.
 */
export function renderVetoDeVazamento(termos: readonly string[]): string {
  const partes = termos.slice(0, 3).map((t) => {
    const entrada = catalogEntry(t);
    return entrada === undefined ? `"${t}"` : `"${t}" (é o nome interno de «${entrada.rotulo.toLowerCase()}»)`;
  });
  return (
    `Sua mensagem leva vocabulário INTERNO do sistema ao cliente: ${partes.join(', ')}. ` +
    'Quem lê é o cliente da empresa: ele não tem acesso ao sistema e não conhece ferramenta, ' +
    'tabela, campo, papel de acesso nem código de erro — ler isso quebra a confiança dele. ' +
    'REESCREVA a MESMA mensagem trocando o termo técnico pelo EFEITO na vida dele: diga o que ' +
    'você conseguiu ou não conseguiu fazer, em português de gente, ou simplesmente omita o ' +
    'detalhe interno. Se o termo era a razão de você não conseguir algo, diga apenas que não ' +
    'conseguiu — sem nomear o motivo interno.'
  );
}

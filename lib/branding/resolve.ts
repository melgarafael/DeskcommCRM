/**
 * O resolvedor da marca — quem junta as camadas de configuração e NUNCA lança.
 *
 * "Nunca lança" não é zelo: este módulo é chamado no `app/layout.tsx`, que
 * embrulha o produto inteiro. Uma exceção aqui não deixa a marca feia — deixa
 * TODAS as telas em 500, inclusive o login, inclusive a tela onde o operador
 * corrigiria o valor que quebrou. O caminho degradado é sempre "o produto se
 * pinta com a cor dele", que é uma instalação funcionando.
 *
 * Isso NÃO é engolir erro (o repo proíbe, e com razão): toda recusa devolve um
 * `MotivoDaMarca` junto do resultado. O motivo é dado, não é log perdido —
 * quem o chama decide se o mostra, registra ou ignora.
 *
 * ── Para onde o motivo SAI (invariante 7 da doutrina Sistema Vivo) ────────────
 *
 * Nesta fase ele sai por dois lugares, e nenhum deles é um `return` que morre:
 *   (1) `app/layout.tsx` registra os motivos no logger estruturado, uma vez por
 *       resolução distinta (a derivação é memoizada, então não vira ruído por
 *       requisição);
 *   (2) o objeto atravessa inteiro para quem chamar.
 * Na fase seguinte, a tela de marca (`/app/settings/tenant/branding`, já
 * inventariada em `docs/design-system/screen-flow/03-screen-inventory.md:149`)
 * consome `motivos` como a lista de avisos ao lado do seletor de cor: é ali que
 * o revendedor descobre POR QUE o amarelo dele virou outro tom, em vez de
 * concluir que o produto está quebrado.
 */

import { resolveBranding, type Branding } from "@/lib/branding";

import { derivarMarca, type CodigoDeMotivo, type Marca, type Regua, type Tema } from "./contraste";
import { logoDaCamada } from "./logo";
import { normalizarHex } from "./rampa";
import {
  ALGORITMO_ATUAL,
  ehPapelConhecido,
  envelopeDeSemente,
  esquemaDaCorDaMarca,
  FORMATO_ATUAL,
  type PapelDaSemente,
} from "./schema";

/** Códigos que nascem da RESOLUÇÃO (os da derivação vêm de `contraste.ts`). */
export type CodigoDaResolucao =
  | "cor_ausente"
  | "envelope_malformado"
  | "semente_invalida"
  | "formato_desconhecido"
  | "algoritmo_desconhecido"
  | "papel_desconhecido"
  | "papel_nao_pinta"
  | "derivacao_falhou";

/**
 * Mesma disciplina do `Motivo` de `contraste.ts`: emite FORMA, nunca
 * IDENTIDADE. Nenhum campo carrega o hex da marca de ninguém — com a tabela por
 * organização (fase seguinte) esses motivos passam a conviver num log só, e a
 * cor de uma empresa não tem por que aparecer no diagnóstico de outra.
 */
export type MotivoDaMarca = {
  readonly codigo: CodigoDaResolucao | CodigoDeMotivo;
  /** Qual camada produziu o motivo (`env`, `organizacao`, …). */
  readonly origem: string;
  readonly tema: Tema | null;
  readonly alvo: string | null;
  readonly detalhe: string;
};

/**
 * Uma camada de configuração. Campos ausentes NÃO apagam a camada de baixo —
 * é isso que "precedência por campo" quer dizer: quem configurou só o logo
 * continua com o nome que já tinha.
 */
export type CamadaDeMarca = {
  readonly origem: string;
  readonly nome?: string | null;
  readonly logoUrl?: string | null;
  readonly logoDarkUrl?: string | null;
  /**
   * O envelope CRU, como veio da fonte — `unknown` de propósito: validar é
   * trabalho do resolvedor, e uma camada que já entregasse validado esconderia
   * de onde o dado inválido veio.
   */
  readonly cor?: unknown;
};

export type CorResolvida = {
  /** O hex do cliente, normalizado. Vai para `--color-brand` mesmo sem pintar. */
  readonly semente: string;
  readonly papel: PapelDaSemente | "desconhecido";
  /** Os tokens derivados. `null` quando a semente não pinta o produto. */
  readonly derivada: Marca | null;
};

export type MarcaResolvida = Branding & {
  readonly cor: CorResolvida | null;
  /** De qual camada veio cada campo — o que torna a precedência auditável. */
  readonly origens: {
    readonly nome: string;
    readonly logoUrl: string;
    readonly logoDarkUrl?: string;
    readonly cor: string;
  };
  readonly motivos: readonly MotivoDaMarca[];
};

const PADRAO = "padrao";

/**
 * Tira qualquer hex de um texto livre antes de ele virar `detalhe`.
 *
 * A mensagem de exceção é o que torna uma falha diagnosticável — descartá-la
 * deixaria o registro completo por fora e inútil por dentro. Mas ela pode
 * conter o valor que a causou (`hexParaRgb` lança com o valor no texto), e a
 * regra de não vazar identidade vale para o caminho de erro também.
 */
function semIdentidade(texto: string): string {
  return texto.replace(/#[0-9a-fA-F]{3,8}/g, "#…");
}

/** O primeiro valor não-vazio, na ordem das camadas. `null` = ninguém definiu. */
function primeiroDefinido(
  camadas: readonly CamadaDeMarca[],
  ler: (c: CamadaDeMarca) => string | null | undefined,
): { valor: string; origem: string } | null {
  for (const camada of camadas) {
    const valor = (ler(camada) ?? "").trim();
    if (valor.length > 0) return { valor, origem: camada.origem };
  }
  return null;
}

/**
 * Cache da derivação, por régua e por semente.
 *
 * A derivação percorre até 21 deslocamentos × todos os pares × 2 temas, e o
 * `app/layout.tsx` a chamaria em TODA requisição para um valor que muda uma vez
 * por deploy. `WeakMap` na régua (e não um `Map` global por hex) porque teste e
 * preview passam réguas diferentes: cachear só pelo hex devolveria a marca de
 * uma régua ao chamador de outra. A chave externa é FRACA; o `Map` interno não
 * é, e é por isso que ele tem teto — ver `TETO_DE_SEMENTES`.
 */
const memoria = new WeakMap<Regua, Map<string, Marca>>();

/**
 * Quantas sementes distintas cada régua guarda.
 *
 * O comentário acima dizia, até esta fase, "1 nesta fase (o `.env`), uma por
 * organização na fase seguinte" — e ESTA é a fase seguinte: é ela que transforma
 * "uma semente por instalação" em "uma por organização". Um `Map` sem poda passa
 * a crescer com o número de empresas que abrem uma tela, num processo que a VPS
 * mantém vivo por semanas, e cada `Marca` carrega a rampa de 11 stops nos dois
 * temas mais os motivos. Entregar a camada da organização sem o teto seria criar
 * o vazamento e documentá-lo.
 *
 * 64, e não 8: o teto precisa ser maior que a quantidade de organizações que um
 * mesmo processo pinta em rajada, senão o cache vira despejo e a derivação volta
 * a rodar por requisição — que é exatamente o custo que ele existe para evitar.
 *
 * FIFO e não LRU, de propósito: LRU exige tocar a ordem a cada LEITURA (delete +
 * set), isto é, escrita no caminho de render mais quente do produto, para ganhar
 * pouco num cache cujo conteúdo muda uma vez por configuração. Quem cai fora é
 * rederivado no render seguinte — o custo do erro é uma derivação, não um bug.
 */
const TETO_DE_SEMENTES = 64;

function derivarComCache(semente: string, regua: Regua): Marca {
  let porSemente = memoria.get(regua);
  if (!porSemente) {
    porSemente = new Map();
    memoria.set(regua, porSemente);
  }
  const guardada = porSemente.get(semente);
  if (guardada) return guardada;
  const nova = derivarMarca(semente, regua);
  porSemente.set(semente, nova);
  if (porSemente.size > TETO_DE_SEMENTES) {
    // `Map` preserva a ordem de INSERÇÃO, então a primeira chave é a mais antiga.
    const maisAntiga = porSemente.keys().next().value;
    if (maisAntiga !== undefined) porSemente.delete(maisAntiga);
  }
  return nova;
}

/**
 * Valida um envelope cru e, se ele pintar, deriva os tokens.
 *
 * Devolve `null` em `cor` quando a camada não tem nada a dizer sobre cor —
 * assim o chamador sabe que pode continuar descendo as camadas.
 */
function resolverCor(
  cru: unknown,
  origem: string,
  regua: Regua,
): { cor: CorResolvida | null; motivos: MotivoDaMarca[] } {
  const motivos: MotivoDaMarca[] = [];
  const anotar = (codigo: CodigoDaResolucao, detalhe: string, alvo: string | null = null) => {
    motivos.push({ codigo, origem, tema: null, alvo, detalhe });
  };

  // Campo presente e vazio é anomalia (jsonb `{}`, `null` gravado); campo
  // AUSENTE é a instalação de fábrica e não merece aviso nenhum — avisar sobre o
  // caso normal ensina o operador a ignorar avisos.
  if (cru === null || (typeof cru === "object" && Object.keys(cru).length === 0)) {
    anotar("cor_ausente", "a camada declara cor, mas sem conteúdo");
    return { cor: null, motivos };
  }
  if (cru === undefined) return { cor: null, motivos };

  const lido = esquemaDaCorDaMarca.safeParse(cru);
  if (!lido.success) {
    // A distinção que importa para quem lê o diagnóstico: `semente_invalida` é
    // "o operador digitou uma cor errada" (o campo é string e não passou no
    // validador de hex — `code: "custom"`, do `.refine`); qualquer outra coisa,
    // inclusive campo AUSENTE ou de tipo errado no mesmo caminho, é forma do
    // envelope. Sem o `code`, um envelope sem `semente_hex` seria reportado como
    // cor mal digitada, e o operador iria procurar o erro no lugar errado.
    const noHex = lido.error.issues.some((i) => i.path[0] === "semente_hex" && i.code === "custom");
    if (noHex) {
      anotar("semente_invalida", "semente_hex não é um hex de cor (#rgb ou #rrggbb)");
    } else {
      const campos = [
        ...new Set(lido.error.issues.map((i) => i.path.join(".") || "(raiz)")),
      ].sort();
      anotar("envelope_malformado", `campos fora da forma esperada: ${campos.join(", ")}`);
    }
    return { cor: null, motivos };
  }

  const envelope = lido.data;

  // `format` governa o SIGNIFICADO dos campos. Se ele mudou, ler `semente_hex`
  // seria adivinhar — e o dano de pintar o produto inteiro com uma cor mal lida
  // é maior que o de não pintar. Cair no padrão do produto é a ação segura.
  if (envelope.format !== FORMATO_ATUAL) {
    anotar(
      "formato_desconhecido",
      `formato ${envelope.format} não é o desta versão (${FORMATO_ATUAL}); ` +
        `a cor do produto permanece`,
    );
    return { cor: null, motivos };
  }

  // `algo` é o oposto: o que se grava é ENTRADA, então esta versão sabe derivar
  // a partir dela mesmo que outra versão tenha gravado. Anotar e seguir é o
  // caminho certo — é justamente o que faz um rollback manter a marca no ar.
  if (envelope.algo !== ALGORITMO_ATUAL) {
    anotar(
      "algoritmo_desconhecido",
      `derivação gravada na versão ${envelope.algo}; esta instalação deriva na ` +
        `${ALGORITMO_ATUAL} e usa a semente como entrada`,
    );
  }

  const semente = normalizarHex(envelope.semente_hex);
  const papel = envelope.papel_da_semente;

  if (!ehPapelConhecido(papel)) {
    // Falhar fechado na AÇÃO (não pintar o produto com uma cor cujo alcance não
    // se entende) e aberto na INFORMAÇÃO (a identidade continua disponível em
    // `--color-brand`, que é inerte: nenhum componente muda de cor por ela).
    anotar(
      "papel_desconhecido",
      "papel da semente não é conhecido nesta versão; a cor não pinta a interface",
      "--color-brand",
    );
    return { cor: { semente, papel: "desconhecido", derivada: null }, motivos };
  }

  if (papel !== "accent") {
    anotar(
      "papel_nao_pinta",
      "a semente foi configurada só como identidade; a interface segue com a cor do produto",
      "--color-brand",
    );
    return { cor: { semente, papel, derivada: null }, motivos };
  }

  try {
    const derivada = derivarComCache(semente, regua);
    for (const m of derivada.motivos) {
      motivos.push({ codigo: m.codigo, origem, tema: m.tema, alvo: m.alvo, detalhe: m.detalhe });
    }
    return { cor: { semente, papel, derivada }, motivos };
  } catch (erro) {
    // Não é `catch` que silencia: o motivo sai com a mensagem real (sem o hex).
    // Existe porque a alternativa é a exceção subir até o layout e derrubar o
    // produto inteiro por causa de uma cor.
    anotar("derivacao_falhou", semIdentidade(erro instanceof Error ? erro.message : String(erro)));
    return { cor: { semente, papel, derivada: null }, motivos };
  }
}

/**
 * Junta as camadas, da MAIS específica para a MAIS genérica.
 *
 * O padrão do produto é o fundo implícito da pilha — não é uma camada que se
 * passa, é o que sobra quando ninguém definiu nada.
 *
 * Uma cor inválida numa camada de cima NÃO apaga a cor válida de baixo: ela é
 * anotada e a busca continua descendo. Numa instalação de revendedor, uma
 * organização que grava lixo tem de cair na marca do revendedor, não na nossa.
 */
export function resolverMarca(camadas: readonly CamadaDeMarca[], regua: Regua): MarcaResolvida {
  const nome = primeiroDefinido(camadas, (c) => c.nome);
  const logo = primeiroDefinido(camadas, (c) => c.logoUrl);
  const base = resolveBranding(nome?.valor, logo?.valor);
  // Uma camada com logo próprio encerra a herança do par: a empresa não pode
  // ganhar o logo escuro de OUTRA marca só porque enviou apenas o padrão.
  let logoEscuro: { valor: string; origem: string } | undefined;
  for (const camada of camadas) {
    const escuro = camada.logoDarkUrl?.trim();
    if (escuro) {
      logoEscuro = { valor: escuro, origem: camada.origem };
      break;
    }
    if (camada.logoUrl?.trim()) break;
  }

  const motivos: MotivoDaMarca[] = [];
  let cor: CorResolvida | null = null;
  let origemDaCor = PADRAO;

  for (const camada of camadas) {
    if (!("cor" in camada)) continue;
    const tentativa = resolverCor(camada.cor, camada.origem, regua);
    motivos.push(...tentativa.motivos);
    if (tentativa.cor) {
      cor = tentativa.cor;
      origemDaCor = camada.origem;
      break;
    }
  }

  return {
    ...base,
    ...(logoEscuro ? { logoDarkUrl: logoEscuro.valor } : {}),
    cor,
    origens: {
      nome: nome?.origem ?? PADRAO,
      logoUrl: logo?.origem ?? PADRAO,
      ...(logoEscuro ? { logoDarkUrl: logoEscuro.origem } : {}),
      cor: origemDaCor,
    },
    motivos,
  };
}

/**
 * A forma da linha de `platform_branding` que o RESOLVEDOR precisa conhecer.
 *
 * Só os três campos que viram marca. `fallback_at`, `seeded_from_env` e
 * companhia são ESTADO da instalação e não entram aqui de propósito: o
 * resolvedor não decide nada com eles, e um tipo que carrega o que não usa vira
 * o lugar onde a próxima pessoa acrescenta lógica que não deveria existir aqui.
 * A linha completa vive em `lib/branding/instalacao.ts`.
 *
 * Campos opcionais para o mesmo motivo do `.catchall` do `schema.ts`: código
 * novo lendo linha velha (ou o contrário) não pode quebrar o layout.
 */
export type LinhaDaInstalacao = {
  readonly app_name?: string | null;
  readonly logo_url?: string | null;
  /**
   * O ARQUIVO subido pela tela, dentro do bucket `brand-logos`. Caminho, nunca
   * URL — a razão está no cabeçalho de `lib/branding/logo.ts` (DIRC-C: a URL é
   * função determinística do caminho, e gravá-la amarraria a marca ao host do
   * projeto Supabase de hoje).
   *
   * Convive com `logo_url` em vez de substituí-lo, e a ordem entre os dois é
   * `logoDaCamada`: o arquivo vence a URL colada. `logo_url` continua existindo
   * porque é a rede de rollback — o `agent.sh` reverte a IMAGEM, nunca o banco,
   * então uma instalação pode voltar a rodar código que não conhece esta coluna.
   */
  readonly logo_path?: string | null;
  readonly logo_dark_path?: string | null;
  readonly accent_hex?: string | null;
};

/**
 * A camada do BANCO — a configuração viva da instalação, acima do `.env`.
 *
 * Fica ACIMA do ambiente na pilha porque é ela que o operador edita sem SSH.
 * O `.env` continua embaixo, e não é redundância: é a rede de segurança do
 * rollback. O `agent.sh` do kit, em falha de update, reverte só o `APP_IMAGE` —
 * não o schema e não o `git checkout` —, então o clone fica com CÓDIGO ANTIGO
 * sobre BANCO NOVO. Código antigo não conhece esta camada; com o `.env` intacto
 * ele degrada para o valor da instalação em vez de perder a marca.
 *
 * `null` (tabela ausente, banco fora do ar, linha ainda não semeada) devolve uma
 * camada que não fala de nada — e não uma camada que APAGA a de baixo. É a
 * diferença entre "o banco não respondeu" e "o operador limpou a marca".
 */
export function camadaDaInstalacao(linha: LinhaDaInstalacao | null): CamadaDeMarca {
  if (!linha) return { origem: "banco" };
  const hex = (linha.accent_hex ?? "").trim();
  // O arquivo subido vence a URL colada, DENTRO desta camada — ver `logoDaCamada`.
  const logoUrl = logoDaCamada(linha.logo_path, linha.logo_url);
  const logoDarkUrl = logoDaCamada(linha.logo_dark_path, null);
  // Mesma regra do `.env`: campo vazio é ausência de configuração, não cor com
  // defeito. Sem isto, uma linha semeada de um `.env` sem cor emitiria
  // `cor_ausente` em toda instalação de fábrica — e aviso no caso normal ensina
  // o operador a ignorar avisos.
  if (hex.length === 0) {
    return {
      origem: "banco",
      nome: linha.app_name,
      logoUrl,
      ...(logoDarkUrl ? { logoDarkUrl } : {}),
    };
  }
  return {
    origem: "banco",
    nome: linha.app_name,
    logoUrl,
    ...(logoDarkUrl ? { logoDarkUrl } : {}),
    cor: envelopeDeSemente(hex),
  };
}

/**
 * A camada do `.env` — a SEMENTE, e a que nunca deixa de existir.
 *
 * Mesmo quando a tabela por organização entrar, é esta camada que pinta o login,
 * o e-mail de convite e o erro 500: telas onde ainda não há organização
 * resolvida (6 dos 8 call sites de `lib/branding` já estão nessa situação).
 *
 * Recebe a fonte, não a procura: é o que permite testar a precedência sem mexer
 * em `process.env` — mesmo desenho de `resolveBranding` em `lib/branding.ts`.
 */
export function camadaDoAmbiente(fonte: {
  APP_NAME?: string;
  APP_LOGO_URL?: string;
  APP_ACCENT_HEX?: string;
}): CamadaDeMarca {
  const hex = (fonte.APP_ACCENT_HEX ?? "").trim();
  // Chave declarada e vazia (`APP_ACCENT_HEX=`) é o estado que o `install.sh`
  // deixa quando o operador não responde — o mesmo caso que `resolveBranding`
  // trata para o nome. Não é cor ausente com defeito, é instalação de fábrica:
  // a camada simplesmente não fala sobre cor.
  if (hex.length === 0) return { origem: "env", nome: fonte.APP_NAME, logoUrl: fonte.APP_LOGO_URL };
  return {
    origem: "env",
    nome: fonte.APP_NAME,
    logoUrl: fonte.APP_LOGO_URL,
    cor: envelopeDeSemente(hex),
  };
}

/**
 * O que fica gravado em `organizations.settings.branding` — a marca do cliente
 * final do revendedor, como o RESOLVEDOR precisa conhecer.
 *
 * Campos opcionais pelo mesmo motivo de `LinhaDaInstalacao` e do `.catchall` do
 * `schema.ts`: o kit self-host põe código VELHO sobre dado NOVO por construção
 * (o `update.sh` aplica o baseline antes de puxar a imagem, e o rollback do
 * `agent.sh` reverte só o `APP_IMAGE`). Um tipo que exigisse as chaves faria o
 * leitor velho quebrar num jsonb que o novo escreveu — e este código roda no
 * caminho de render.
 */
export type MarcaDaOrganizacao = {
  readonly app_name?: string | null;
  readonly accent_hex?: string | null;
  /**
   * O logo DESTA organização — caminho dentro de `brand-logos`, sob o prefixo do
   * próprio `organization_id`. Sem `logo_url` par: aqui não há herança de `.env`
   * a preservar (a chave `APP_LOGO_URL` é da instalação), então uma URL colada
   * por organização seria contrato novo sem consumidor. Quem não subiu arquivo
   * continua com o logo da instalação, pela precedência por campo.
   */
  readonly logo_path?: string | null;
  readonly logo_dark_path?: string | null;
};

/**
 * A camada da ORGANIZAÇÃO — o cliente do revendedor, acima de tudo.
 *
 * Fica no TOPO da pilha porque é a marca que a empresa mostra para os próprios
 * atendentes; a da instalação continua embaixo e continua valendo campo a campo
 * (quem definiu só a cor mantém o nome do revendedor).
 *
 * `logoUrl` É PRODUZIDO AQUI — e esta linha é o produtor que faltava. Até a onda
 * anterior, `ActiveOrg.marca.logoUrl` (`lib/auth/types.ts`) e a condição
 * `origens.logoUrl === "organizacao"` (`app/app/layout.tsx`) existiam sem
 * ninguém do outro lado: o consumidor entrou antes do produtor, de propósito e
 * declarado, para que o upload por organização fosse só esta camada e não mais
 * uma passada pela casca inteira. `null` aqui é NEUTRO — `primeiroDefinido`
 * ignora valor vazio e desce para a instalação —, então a organização que não
 * subiu arquivo continua com o logo do revendedor.
 *
 * Hex vazio devolve camada SEM a chave `cor`, e não `cor: null`: medido em
 * `resolverCor` (:183-187), `null` emite `cor_ausente` e a chave AUSENTE desce
 * calada. Uma fábrica que devolvesse `?? null` acenderia aviso em TODA
 * organização que não configurou marca — o ruído que :180-182 diz querer evitar,
 * e que é como um operador aprende a ignorar aviso.
 *
 * Recebe a marca já lida, e não vai buscá-la: mesmo desenho de
 * `camadaDaInstalacao` e `camadaDoAmbiente`, e é o que permite testar a
 * precedência sem banco. Quem lê o jsonb é `lib/branding/organizacao.ts`.
 */
export function camadaDaOrganizacao(marca: MarcaDaOrganizacao | null): CamadaDeMarca {
  if (!marca) return { origem: "organizacao" };
  const hex = (marca.accent_hex ?? "").trim();
  const logoUrl = logoDaCamada(marca.logo_path, null);
  const logoDarkUrl = logoDaCamada(marca.logo_dark_path, null);
  if (hex.length === 0)
    return {
      origem: "organizacao",
      nome: marca.app_name,
      logoUrl,
      ...(logoDarkUrl ? { logoDarkUrl } : {}),
    };
  return {
    origem: "organizacao",
    nome: marca.app_name,
    logoUrl,
    ...(logoDarkUrl ? { logoDarkUrl } : {}),
    cor: envelopeDeSemente(hex),
  };
}

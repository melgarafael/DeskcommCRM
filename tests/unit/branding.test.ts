import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { prefixoDoArquivo } from "@/components/auth/RecoveryCodesPanel";
import { DEFAULT_APP_NAME, resolveBranding } from "@/lib/branding";

const RAIZ = process.cwd();

describe("resolveBranding", () => {
  it("cai no padrão quando não há marca configurada", () => {
    expect(resolveBranding(undefined, undefined)).toEqual({
      name: DEFAULT_APP_NAME,
      logoUrl: null,
      initial: "D",
    });
  });

  it("trata string vazia e só-espaços como ausência de marca", () => {
    // `install.sh` grava a chave declarada mesmo quando o operador não responde
    // (APP_NAME=), então "vazio" chega como string — não como undefined. Tratar
    // isso como marca válida deixaria a interface sem nome nenhum.
    expect(resolveBranding("", "").name).toBe(DEFAULT_APP_NAME);
    expect(resolveBranding("   ", "   ").name).toBe(DEFAULT_APP_NAME);
    expect(resolveBranding("   ", "   ").logoUrl).toBeNull();
  });

  it("usa a marca configurada e deriva a inicial", () => {
    const b = resolveBranding("  Vendas Turbo  ", "  https://cdn.exemplo.com/logo.svg  ");
    expect(b.name).toBe("Vendas Turbo");
    expect(b.logoUrl).toBe("https://cdn.exemplo.com/logo.svg");
    expect(b.initial).toBe("V");
  });

  it("mantém o nome mas dispensa o logo quando só o nome é configurado", () => {
    const b = resolveBranding("Acme CRM", undefined);
    expect(b.name).toBe("Acme CRM");
    expect(b.logoUrl).toBeNull();
  });

  it("não parte code point ao derivar a inicial", () => {
    // `[0]` cru devolveria metade do par substituto e renderizaria caractere
    // inválido na sidebar recolhida.
    expect(resolveBranding("🚀 Foguete", null).initial).toBe("🚀");
    expect(resolveBranding("Ótimo CRM", null).initial).toBe("Ó");
  });
});

describe("guarda de white-label (self-host)", () => {
  const branding = fs.readFileSync(path.join(RAIZ, "lib/branding.ts"), "utf8");
  const publicEnvScript = fs.readFileSync(
    path.join(RAIZ, "app/public-env-script.tsx"),
    "utf8",
  );
  const layoutRaiz = fs.readFileSync(path.join(RAIZ, "app/layout.tsx"), "utf8");

  it("não usa prefixo NEXT_PUBLIC_ para a marca", () => {
    // POR QUE ESTE TESTE EXISTE: a convenção do Next empurra qualquer valor lido
    // no browser para NEXT_PUBLIC_*, e alguém vai "corrigir" isso um dia. Mas
    // NEXT_PUBLIC_* é queimada no bundle durante o `next build`, e o self-hoster
    // roda uma imagem PRÉ-BUILDADA: a marca dele nunca apareceria. O defeito
    // passaria em typecheck, lint e em toda a suíte, funcionaria em dev e na
    // Vercel, e falharia apenas na VPS de quem a feature existe para servir.
    expect(branding).not.toMatch(/NEXT_PUBLIC_APP_(NAME|LOGO_URL)/);
    expect(publicEnvScript).not.toMatch(/NEXT_PUBLIC_APP_(NAME|LOGO_URL)/);
  });

  it("injeta a marca em runtime pelo PublicEnvScript", () => {
    // Sem estas duas chaves no payload, os client components (Sidebar,
    // AdminSidebar) caem no padrão e só a marca do servidor muda — a instalação
    // ficaria com o nome do revendedor no título da aba e o nosso na sidebar.
    //
    // As duas liam `env.APP_NAME` / `env.APP_LOGO_URL` — o arquivo de instalação
    // CRU — e a consequência foi medida: `platform_branding.logo_url` e
    // `MarcaDeSaida.logoUrl` existiam sem nenhum leitor, porque o único render de
    // logo do produto (`components/shell/Sidebar.tsx`) lê daqui. O operador
    // salvava um valor que nada mostrava, e a tela dizia "salvo". Passam a vir da
    // marca RESOLVIDA (banco acima, `.env` embaixo).
    expect(publicEnvScript).toMatch(/APP_NAME:\s*marca\.name/);
    expect(publicEnvScript).toMatch(/APP_LOGO_URL:\s*marca\.logoUrl/);
  });

  it("a marca do payload vem do resolvedor, e não do `.env` por outro nome", () => {
    // As duas asserções de cima passariam com um `marca` montado ali mesmo a
    // partir de `env` — o defeito voltaria com outra roupa e o gate ficaria
    // verde. Estas duas fecham as pontas: nenhuma chave de marca sai de `env`
    // dentro do script, e quem preenche a prop é o layout raiz, com a MESMA
    // função que o título da aba e o CSS já usam.
    expect(publicEnvScript).not.toMatch(/APP_(NAME|LOGO_URL):\s*env\./);
    expect(layoutRaiz).toMatch(/<PublicEnvScript\s+marca=\{/);
    expect(layoutRaiz).toMatch(/marcaResolvida\(\)/);
  });

  it("o layout raiz resolve a marca UMA vez para os quatro consumidores", () => {
    // Guarda de vacuidade das duas de cima: se `marcaResolvida` deixasse de ser
    // a fonte da aba ou do CSS, o casamento de `marcaResolvida()` acima
    // continuaria verdadeiro e mediria um resolvedor que só o script usa — que é
    // exatamente a divergência ("aba com uma marca, barra com outra") que o
    // cabeçalho daquela função existe para impedir.
    expect(
      layoutRaiz.match(/await marcaResolvida\(\)/g) ?? [],
      "os quatro consumidores do layout raiz são `generateMetadata` (aba), " +
        "`EstiloDaMarca` (cor), `MarcaNoNavegador` (`window.__PUBLIC_ENV__`) e " +
        "`MarcaDosClientComponents` (o contexto que os `\"use client\"` leem). " +
        "Consumidor a mais é legítimo — atualize o número. Consumidor a MENOS " +
        "significa que alguém voltou a montar a pilha por fora.",
    ).toHaveLength(4);
  });

  it("os client components recebem a marca por PROP, não por fonte só-do-navegador", () => {
    // POR QUE ESTE CASO EXISTE: a asserção `APP_NAME: marca.name` acima ficou
    // verde enquanto o produto emitia React #418 em 7 de 7 telas de `/app/ai/*`.
    // Ela mede o que chega ao NAVEGADOR, e o defeito era o outro lado: o SSR de
    // um `"use client"` não tem `window`, então `branding()` lia `process.env` e
    // renderizava `<span>` onde o cliente hidratava `<img>`.
    //
    // O que fecha a ponta é a marca atravessar por PROP — a mesma rota de
    // `user`/`activeOrg`. As duas asserções são o par mínimo: o provedor existe
    // no layout raiz E ele envolve `children` (um provedor montado ao lado, sem
    // envolver a árvore, deixaria todo consumidor no padrão do produto).
    expect(layoutRaiz).toMatch(/<MarcaDaInstalacaoProvider\s+marca=\{/);
    expect(layoutRaiz).toMatch(/<MarcaDosClientComponents>\s*\n\s*<ThemeProvider>\{children\}/);
  });
});

describe("nome do arquivo de códigos de recuperação", () => {
  // Este arquivo fica anos na pasta de downloads do usuário: é o artefato de
  // marca mais duradouro que o produto entrega, e nenhuma atualização conserta
  // o que já foi baixado. Por isso o prefixo sai da marca da instalação.

  it("deriva o prefixo da marca, sem acento e sem espaço", () => {
    expect(prefixoDoArquivo("Vendas Turbo")).toBe("vendas-turbo");
    expect(prefixoDoArquivo("Ótima Gestão")).toBe("otima-gestao");
    expect(prefixoDoArquivo(DEFAULT_APP_NAME)).toBe("deskcommcrm");
  });

  it("não devolve hífen pendurado nem repetido", () => {
    // `-recovery-codes.txt` vem logo depois: sobra de hífen viraria "acme--…".
    expect(prefixoDoArquivo("  Acme // CRM!  ")).toBe("acme-crm");
  });

  it("cai em 'crm' quando a marca não tem caractere aproveitável", () => {
    // Sem isto o `download` sairia vazio e o browser inventaria "download.txt" —
    // o usuário perderia de vista o arquivo com os códigos de recuperação dele.
    expect(prefixoDoArquivo("🚀")).toBe("crm");
    expect(prefixoDoArquivo("")).toBe("crm");
  });
});

/**
 * A catraca da marca — congela o que já vaza, reprova o que vazar de novo.
 *
 * A versão anterior deste gate ficava VERDE enquanto a marca vazava, por dois
 * furos independentes, e os dois só apareceram quando alguém foi olhar:
 *
 *  1. o padrão era `/Deskcomm/` — **case-sensitive**. Passavam
 *     `support@deskcomm.com.br` (tela de conta suspensa), `suporte@deskcomm.app`
 *     (tela de cobrança) e `deskcommcrm-recovery-codes.txt` (o arquivo que o
 *     usuário baixa e guarda por anos). Endereço e nome de arquivo são
 *     minúsculos por natureza — ou seja, o gate era cego justamente na forma em
 *     que a marca de fato aparece;
 *  2. a varredura cobria só `app/` e `components/`, e só `.tsx`. Ficavam fora
 *     `lib/` inteiro (e-mail de convite, rodapé do PDF de LGPD, remetente) e
 *     todo arquivo `.ts` — inclusive `app/actions/auth/enrollMfa.ts`, que está
 *     DENTRO de `app/` e escapava pela extensão. Esse é o pior deles: o nome vai
 *     para o app autenticador e fica no celular do usuário para sempre.
 *
 * MECANISMO. A varredura é `/deskcomm/i` sobre `.ts` e `.tsx` de `app/`,
 * `components/`, `lib/` e `workers/`. Cada arquivo com ocorrência precisa de uma
 * entrada em `MARCA_CONGELADA` com categoria, motivo escrito e o conjunto EXATO
 * de marcas encontradas. Arquivo novo reprova; marca nova em arquivo já
 * congelado reprova; marca que sumiu também reprova, e a correção é apagar a
 * linha da lista — é assim que ela só encolhe.
 *
 * MARCA ≠ PROTOCOLO — a distinção que precisa estar escrita, não subentendida.
 * Boa parte das ocorrências abaixo NÃO é marca: é identificador técnico.
 * `X-Deskcomm-Signature` é contrato de fio com receptores de terceiros, o cookie
 * `sb-deskcomm-auth` é a sessão de quem já está logado. Quem "completar o
 * whitelabel" renomeando isso derruba integração de cliente em produção — em
 * silêncio, porque o receptor não erra: ele apenas deixa de reconhecer. Por isso
 * a categoria é campo obrigatório: sem ela, a lista viraria uma pilha de
 * pendências indistinguíveis e alguém trataria contrato como pendência.
 */

type CategoriaDeMarca =
  /** Contrato de fio: alguém FORA deste processo casa a string por igualdade
   *  (header de webhook, nome do servidor MCP, user-agent). Nunca renomear. */
  | "PROTOCOLO"
  /** Chave de cookie, de storage do browser ou de contêiner. Não sai para
   *  terceiro, mas renomear desloga a base instalada ou perde estado local. */
  | "INFRA"
  /** Vazamento real de marca, visível ao usuário final. Declara a fase que o
   *  resolve — pendência sem prazo é pendência esquecida. */
  | "DIVIDA"
  /** Só desenvolvimento: fixture de teste. Não embarca na imagem. */
  | "DEV"
  /** A definição do nome padrão do produto. Tem de existir em UM lugar. */
  | "PADRAO";

type EntradaDeMarca = {
  categoria: CategoriaDeMarca;
  /** Por que esta ocorrência pode ficar. Quem adiciona linha aqui escreve isto. */
  motivo: string;
  /** Fase que remove a ocorrência. Obrigatório — e só faz sentido — em `DIVIDA`. */
  fase?: number;
  /** Conjunto EXATO de marcas do arquivo, como `marcasNoTexto` as normaliza. */
  marcas: string[];
};

const MARCA_CONGELADA: Record<string, EntradaDeMarca> = {
  // ─── PROTOCOLO — contrato de fio. Renomear quebra integração alheia. ───
  "app/api/v1/webhooks/in/[token]/route.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "header que o webhook de ENTRADA exige de quem envia. Renomear invalida a assinatura de todo integrador já configurado, e o sintoma para ele é 401 sem explicação",
    marcas: ["x-deskcomm-signature"],
  },
  "lib/automation/actions/call-webhook.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "headers do webhook de SAÍDA. O receptor do cliente lê o nome exato para rotear e para conferir o HMAC; renomear faz o payload chegar e ser descartado calado",
    marcas: ["x-deskcomm-event", "x-deskcomm-signature"],
  },
  "lib/automation/actions/call-webhook.test.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "é a guarda do contrato acima: este teste é o que reprova quem renomear o header. Trocar a string aqui para 'limpar a marca' desarmaria a única proteção que o contrato tem",
    marcas: ["x-deskcomm-event", "x-deskcomm-signature", "x-deskcomm-signature"],
  },
  "lib/mcp/server.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "nome do servidor MCP, que o cliente (Claude Desktop e afins) grava na própria configuração. Renomear derruba as conexões já configuradas de quem usa",
    marcas: ["deskcomm-crm"],
  },
  "lib/supabase/admin.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "`X-Client-Info` enviado ao Supabase — identifica o cliente nos logs e na telemetria DELES. Não é texto de interface e nunca chega ao usuário",
    marcas: ["deskcomm-crm"],
  },
  "lib/wacalls/events-bridge.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "X-Client-Id enviado ao processo WaCalls (spec 18) — identifica o worker como o operador dono da conexão SSE nos logs e na lógica de exclusividade de chamada dele. Não é texto de interface e nunca chega ao usuário",
    marcas: ["deskcomm-worker"],
  },
  "lib/nuvemshop/config.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "User-Agent exigido pela Nuvemshop, que identifica a aplicação registrada na plataforma deles. Trocar pelo nome do revendedor descreveria uma aplicação que não existe lá",
    marcas: ["deskcommcrm"],
  },
  "lib/agenda/google/evento.ts": {
    categoria: "PROTOCOLO",
    motivo:
      "sufixo do `iCalUID` e prefixo das `extendedProperties` que GRAVAMOS dentro do Google Calendar do cliente. É por essa string que reconhecemos, meses depois, quais eventos daquela agenda vieram do CRM — e é o que impede o laço de eco. Trocar pela marca do revendedor faz todo evento já criado deixar de ser reconhecido, e o sintoma é compromisso fantasma ocupando horário, sem erro nenhum",
    marcas: ["deskcomm", "deskcomm.app"],
  },

  // ─── INFRA — cookie/storage/contêiner. Renomear desloga ou perde estado. ───
  "app/layout.tsx": {
    categoria: "INFRA",
    motivo:
      "chave de localStorage do tema, lida no script anti-flash. Renomear faz todo mundo voltar ao tema claro no próximo acesso — e o par com lib/theme.tsx tem de mudar junto",
    marcas: ["deskcomm-theme"],
  },
  "lib/theme.tsx": {
    categoria: "INFRA",
    motivo: "a mesma chave de localStorage do script do layout; as duas são um par só",
    marcas: ["deskcomm-theme"],
  },
  "lib/supabase/browser.ts": {
    categoria: "INFRA",
    motivo:
      "nome do cookie de sessão. Renomear invalida a sessão de todo usuário logado no momento da atualização — o `update.sh` do clone viraria um logout em massa",
    marcas: ["sb-deskcomm-auth"],
  },
  "lib/supabase/server.ts": {
    categoria: "INFRA",
    motivo: "o mesmo cookie de sessão, lido no servidor; tem de casar com o do browser",
    marcas: ["sb-deskcomm-auth"],
  },
  "lib/impersonate/cookie.ts": {
    categoria: "INFRA",
    motivo:
      "nome do cookie de impersonação. Renomear deixa órfã a sessão de suporte já aberta, e o operador fica preso na conta do tenant sem o cookie que o traz de volta",
    marcas: ["deskcomm-impersonate"],
  },
  "lib/impersonate/cookie-edge.ts": {
    categoria: "INFRA",
    motivo: "o mesmo cookie de impersonação, na cópia que o middleware edge consegue importar",
    marcas: ["deskcomm-impersonate"],
  },

  "hooks/ai/useDebugToggle.ts": {
    categoria: "INFRA",
    motivo:
      "chave de localStorage do modo de depuração das citações da IA — irmã de `deskcomm-theme` em lib/theme.tsx. Não é texto de interface: renomear só faz quem já tinha o modo ligado perdê-lo, e o par leitura/escrita teria de mudar junto",
    marcas: ["deskcomm.show_ai_citations"],
  },

  // ─── DIVIDA — vazamento real. Cada linha declara a fase que a apaga. ───
  "lib/email/templates/ai-budget-alarm.tsx": {
    categoria: "DIVIDA",
    fase: 7,
    motivo:
      "template sem caminho de produção: sem rota em app/api/v1/cron/, sem linha no docker/scheduler/entrypoint.sh e, desde a limpeza do teto de orçamento (0159), sem chamador NENHUM — o único era workers/ai-budget-checker.cron.ts, que foi apagado por nunca ter tido agendador. Marcar isto não muda nada que um usuário veja, e a única 'prova' possível seria invocar a função à mão — o que prova a função, não o produto. Sai quando o alarme ganhar cron de verdade (ou quando o template for apagado junto)",
    marcas: ["deskcommcrm"],
  },

  // ─── DEV — fixture de teste; não embarca. ───
  "lib/agent-engine/agent/draft-reply.test.ts": {
    categoria: "DEV",
    motivo: "nome de agente numa fixture de teste ('Bot Deskcomm'); não sai da suíte",
    marcas: ["deskcomm"],
  },
  "lib/system/changelog.test.ts": {
    categoria: "DEV",
    motivo:
      "fixture que reproduz o CHANGELOG real, incluindo as URLs do repositório no GitHub. A marca aqui é o nome do repositório upstream, que o clone não renomeia",
    marcas: ["deskcommcrm", "deskcommcrm", "deskcommcrm"],
  },

  // ─── PADRAO — a marca padrão precisa existir em algum lugar. ───
  "lib/branding.ts": {
    categoria: "PADRAO",
    motivo:
      "é a DEFINIÇÃO de DEFAULT_APP_NAME — o valor que aparece quando o operador não configurou marca nenhuma. Se esta linha sumir, some o padrão",
    marcas: ["deskcommcrm"],
  },
};

/**
 * As raízes varridas — e a FRONTEIRA, escrita, porque foi a ausência dela que
 * deixou `hooks/` de fora até alguém ir olhar.
 *
 * O critério é UM: código que EMBARCA na imagem e cujo texto pode alcançar o
 * usuário final. Por isso entram `app/`, `components/`, `lib/`, `workers/` —
 * e `hooks/`, que tem 112 arquivos, é importada por 171 arquivos de `app` e
 * `components`, e emite `toast` direto na tela. Ficou fora só porque a lista
 * nasceu enumerando o que alguém lembrou, e enumeração sem critério não avisa
 * quando fica incompleta.
 *
 * Ficam FORA, com motivo:
 *  - `scripts/` (14 ocorrências, todas fixture de dev e prosa de log) e
 *    `tests/`: não embarcam na imagem — o `Dockerfile` copia `.next/standalone`,
 *    `.next/static` e `public/`;
 *  - `evidence/` e `loop/`: ferramental de sessão, mesma razão;
 *  - `types/`: um único `.d.ts`, sem string de runtime (medido: 0 ocorrências);
 *  - `app/design/`: é o showcase interno do design system, a única tela em que
 *    o nome do produto é o assunto da página.
 */
const RAIZES_VARRIDAS = ["app", "components", "hooks", "lib", "workers"] as const;

/**
 * Extrai as marcas de um texto, uma por ocorrência.
 *
 * Casa `deskcomm` em qualquer caixa e leva junto o identificador inteiro em volta
 * (`x-deskcomm-signature`, `support@deskcomm.com.br`), porque é o identificador —
 * não a palavra solta — que distingue contrato de fio de vazamento de marca.
 *
 * Linha que ABRE com `//`, `*` ou `/*` é comentário e não conta: comentário não
 * chega ao usuário, e contá-lo encheria a lista de entradas inertes até ninguém
 * mais ler as que importam. O teste olha só o início da linha DE PROPÓSITO —
 * procurar `//` em qualquer posição descartaria `"https://deskcomm.app"`, que é
 * exatamente um vazamento de verdade.
 */
/**
 * As linhas de um fonte que CONTAM — a regra de comentário em um lugar só.
 *
 * Linha que ABRE com `//`, `*` ou `/*` é comentário e não conta: comentário não
 * chega ao usuário, e contá-lo encheria a lista de entradas inertes até ninguém
 * mais ler as que importam. O teste olha só o início da linha DE PROPÓSITO —
 * procurar `//` em qualquer posição descartaria `"https://deskcomm.app"`, que é
 * exatamente um vazamento de verdade.
 *
 * NÃO se reaproveita onde a fonte não é TypeScript: o comentário de HTML
 * (`<!-- -->`) atravessa linhas e o de TOML abre com `#`. A varredura de
 * `supabase/templates/*.html` e `config.toml` tem as próprias funções de
 * limpeza, logo abaixo, e o porquê está escrito lá.
 */
function linhasQueContam(fonte: string): string[] {
  const uteis: string[] = [];
  for (const linha of fonte.split("\n")) {
    const inicio = linha.trimStart();
    if (inicio.startsWith("//") || inicio.startsWith("*") || inicio.startsWith("/*")) continue;
    uteis.push(linha);
  }
  return uteis;
}

/**
 * Extrai as marcas de um texto, uma por ocorrência.
 *
 * Casa `deskcomm` em qualquer caixa e leva junto o identificador inteiro em volta
 * (`x-deskcomm-signature`, `support@deskcomm.com.br`), porque é o identificador —
 * não a palavra solta — que distingue contrato de fio de vazamento de marca.
 */
function marcasNoTexto(fonte: string): string[] {
  const achadas: string[] = [];
  for (const linha of linhasQueContam(fonte)) {
    for (const casada of linha.matchAll(/[\w@.-]*deskcomm[\w@.-]*/gi)) {
      // Pontuação encostada (o ponto final de "no DeskcommCRM.") não faz parte
      // do identificador e faria a lista mudar por causa de uma vírgula.
      achadas.push(casada[0].toLowerCase().replace(/^[.-]+/, "").replace(/[.-]+$/, ""));
    }
  }
  return achadas.sort();
}

/**
 * Host dentro de URL. Exigir rótulo final de LETRAS (`\.[a-z]{2,}`) é o que
 * dispensa, de uma vez e sem linha de allowlist nenhuma, `http://.../`,
 * `http://localhost:3000`, `http://waha:3000` e TODO IP literal — `127.0.0.1`,
 * `10.0.0.5`, `169.254.1.1`: nenhum deles termina em TLD alfabético.
 */
const HOST_EM_URL = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;

/**
 * Host NU, e só quando é o CONTEÚDO de uma string (`"meet.google.com"`).
 *
 * Fora de aspas ele é identificador, e a forma "em qualquer contexto" foi medida
 * antes de ser descartada: casa `logger.info(` (37 linhas), `auth.organization_id`
 * e `message.received` — 339 linhas e 160 "hosts" na superfície que embarca,
 * quase todos falsos. A lista de TLDs é a parte heurística desta forma, e ela é
 * explícita de propósito: um `[a-z]{2,}` genérico é o que produz os 160.
 *
 * O `(?![a-z0-9_-])` depois do TLD é carregador, e as duas metades dele vêm de
 * medição, não de gosto:
 *  - sem ele, `auth.organization_id` casa como `auth.org`;
 *  - sem o `_`, os nomes de evento de auditoria casam em bloco — medido na
 *    `main`: `onboarding.ai_configured`, `ai.org_memory_published`,
 *    `channel.ai_access_updated`, `conversation.ai_paused`,
 *    `lgpd.store_redact_received` e `env.APP_NAME` (6 falsos, todos com `_`
 *    logo depois do "TLD"). `_` não existe em nome de host, então barrá-lo não
 *    esconde host nenhum.
 */
const HOST_NU_EM_STRING =
  /["'`](?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com\.br|com|net|org|io|app|dev|ai|co|cloud|br|me|tv|edu|gov|info|xyz|site|online|shop|store))(?![a-z0-9_-])/gi;

/**
 * Host que não é terceiro porque não resolve para ninguém: TLD reservado para
 * documentação e teste (RFC 6761) e o próprio `example.com` com os irmãos
 * (RFC 2606). `exemplo`/`ejemplo` NÃO entram aqui de propósito — `mi-gateway.ejemplo.com`
 * está no código que embarca como amostra de campo, e amostra se DECLARA
 * (categoria `AMOSTRA`), não se ignora em silêncio.
 */
const TLDS_RESERVADOS = /\.(test|invalid|local|localhost|example)$/i;
const EXAMPLE_RFC2606 = /(^|\.)example\.(com|net|org)$/i;

/**
 * Extrai os hosts de terceiro de um texto — distintos, em minúsculas, em ordem.
 *
 * Distintos (e não uma por ocorrência, como `marcasNoTexto`) porque a lista de
 * hosts declarados é por HOST, não por arquivo: o segundo call site de um
 * endpoint já declarado não pede linha nova, e é isso que impede a catraca de
 * virar churn de allowlist a cada arquivo que passa a chamar `api.openai.com`
 * (medido: ele aparece em 5 arquivos, `graph.facebook.com` em 6).
 *
 * Duas formas, as duas medidas na calibração da #287: URL (`HOST_EM_URL`) e host
 * nu em string (`HOST_NU_EM_STRING`). A terceira — host nu em QUALQUER contexto —
 * está medida e rejeitada acima.
 */
function hostsNoTexto(fonte: string): string[] {
  const achados = new Set<string>();
  for (const linha of linhasQueContam(fonte)) {
    for (const m of linha.matchAll(HOST_EM_URL)) {
      const host = m[1];
      if (host) achados.add(host.toLowerCase());
    }
    for (const m of linha.matchAll(HOST_NU_EM_STRING)) {
      const host = m[1];
      if (host) achados.add(host.toLowerCase());
    }
  }
  return [...achados].filter((h) => !TLDS_RESERVADOS.test(h) && !EXAMPLE_RFC2606.test(h)).sort();
}

/**
 * Os arquivos varridos de uma raiz.
 *
 * As duas opções existem porque as varreduras divergem em DOIS pontos, e cada
 * divergência tem motivo medido — não é preferência:
 *
 *  - `app/design` fica FORA da catraca de marca (lá o nome do produto é o ASSUNTO
 *    da página) e DENTRO da de host, cujo critério é outro: "embarca na imagem".
 *    `app/design` embarca. Medido: 0 hosts lá hoje, então entrar custa zero.
 *  - os `*.test.ts(x)` ficam FORA da catraca de host: fixture não embarca (o
 *    `Dockerfile` copia `.next/standalone`, `.next/static` e `public/`), e com
 *    eles dentro os hosts a declarar subiam de 21 para 61 — `localhost` em 44
 *    arquivos, `crm.exemplo.com` em 12 linhas de fixture. Allowlist de fixture
 *    afoga o sinal que a catraca existe para dar.
 */
function arquivosVarridos(
  dir: string,
  opcoes: { comDesign?: boolean; comTeste?: boolean } = {},
): string[] {
  // `comTeste` default TRUE de propósito: a catraca de marca conta os arquivos
  // de teste (três deles estão em MARCA_CONGELADA como dívida declarada). Quem
  // quer fixture fora — a de host — passa `comTeste: false` explicitamente.
  const comDesign = opcoes.comDesign ?? false;
  const comTeste = opcoes.comTeste ?? true;
  const alvos: string[] = [];
  for (const entrada of fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entrada.name);
    if (!comDesign && rel.startsWith("app/design")) continue;
    if (entrada.isDirectory()) {
      alvos.push(...arquivosVarridos(rel, opcoes));
      continue;
    }
    if (!rel.endsWith(".ts") && !rel.endsWith(".tsx")) continue;
    if (!comTeste && /\.(test|spec)\.tsx?$/.test(rel)) continue;
    alvos.push(rel);
  }
  return alvos;
}

describe("catraca de marca hardcoded", () => {
  const porRaiz = new Map(RAIZES_VARRIDAS.map((r) => [r, arquivosVarridos(r)]));
  const alvos = [...porRaiz.values()].flat();
  const encontrado = new Map<string, string[]>();
  for (const arquivo of alvos) {
    const marcas = marcasNoTexto(fs.readFileSync(path.join(RAIZ, arquivo), "utf8"));
    if (marcas.length > 0) encontrado.set(arquivo, marcas);
  }

  it("a varredura alcança as cinco raízes — senão o resto não prova nada", () => {
    // Guarda de vacuidade com nome. `workers/` hoje não tem NENHUMA ocorrência
    // fora de comentário: sem esta asserção, uma varredura que nem descesse lá
    // devolveria a mesma lista vazia e passaria como se estivesse vigiando.
    for (const [raiz, arquivos] of porRaiz) {
      expect(arquivos.length, `${raiz}/ não devolveu arquivo nenhum`).toBeGreaterThan(0);
    }
    expect(alvos.length).toBeGreaterThan(500);
    expect(alvos.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(100);
    expect(alvos.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(100);
  });

  it("pega a marca em qualquer caixa e dentro de identificador", () => {
    // O furo nº 1 do gate antigo, agora com asserção: `/Deskcomm/` deixava passar
    // as três formas de baixo, que são as formas em que a marca de fato aparece.
    expect(marcasNoTexto(`a.download = "deskcommcrm-recovery-codes.txt";`)).toEqual([
      "deskcommcrm-recovery-codes.txt",
    ]);
    expect(marcasNoTexto(`href="mailto:suporte@deskcomm.app"`)).toEqual(["suporte@deskcomm.app"]);
    expect(marcasNoTexto(`const k = "sb-DESKCOMM-auth";`)).toEqual(["sb-deskcomm-auth"]);
  });

  it("ignora comentário, mas não confunde `//` de URL com comentário", () => {
    // A regra de comentário é uma exceção, e exceção sem guarda vira buraco:
    // procurar `//` em qualquer posição da linha esconderia justamente a URL.
    expect(marcasNoTexto(`  // fala do DeskcommCRM`)).toEqual([]);
    expect(marcasNoTexto(` * fala do DeskcommCRM`)).toEqual([]);
    expect(marcasNoTexto(`const u = "https://deskcomm.app/x";`)).toEqual(["deskcomm.app"]);
    expect(marcasNoTexto(`fetch(url); // manda pro DeskcommCRM`)).toEqual(["deskcommcrm"]);
  });

  it("nenhum arquivo fora da lista fixa a marca", () => {
    const novos = [...encontrado.keys()].filter((f) => !(f in MARCA_CONGELADA));
    expect(
      novos,
      `Marca hardcoded em arquivo que não está congelado.\n` +
        `Use branding() de lib/branding.ts — ou, se for identificador técnico\n` +
        `(header, cookie, storage), declare em MARCA_CONGELADA com categoria e motivo:\n` +
        novos.map((f) => `  ${f}  ${JSON.stringify(encontrado.get(f))}`).join("\n"),
    ).toEqual([]);
  });

  it("arquivo congelado não ganhou nem perdeu marca sem a lista acompanhar", () => {
    const divergentes: string[] = [];
    for (const [arquivo, entrada] of Object.entries(MARCA_CONGELADA)) {
      const atual = encontrado.get(arquivo) ?? [];
      const congelado = [...entrada.marcas].sort();
      if (JSON.stringify(atual) !== JSON.stringify(congelado)) {
        divergentes.push(`  ${arquivo}\n    lista: ${JSON.stringify(congelado)}\n    disco: ${JSON.stringify(atual)}`);
      }
    }
    expect(
      divergentes,
      `O conjunto de marcas mudou num arquivo congelado.\n` +
        `Ganhou marca: é ocorrência NOVA — tire do código.\n` +
        `Perdeu marca: a dívida encolheu — atualize (ou apague) a linha da lista.\n` +
        divergentes.join("\n"),
    ).toEqual([]);
  });

  it("a lista não guarda arquivo que já não tem marca nenhuma", () => {
    // É o que força a lista a ENCOLHER: quem limpar um arquivo é obrigado a
    // apagar a linha, em vez de deixar a pendência morta ocupando espaço.
    const obsoletos = Object.keys(MARCA_CONGELADA).filter((f) => !encontrado.has(f));
    expect(
      obsoletos,
      `Estes arquivos não têm mais marca — apague a linha de MARCA_CONGELADA:\n` +
        obsoletos.map((f) => `  ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("toda entrada declara categoria e explica o porquê", () => {
    const validas: CategoriaDeMarca[] = ["PROTOCOLO", "INFRA", "DIVIDA", "DEV", "PADRAO"];
    const ruins = Object.entries(MARCA_CONGELADA)
      .filter(([, e]) => !validas.includes(e.categoria) || e.motivo.trim().length < 40)
      .map(([f]) => f);
    expect(ruins, `entrada sem categoria válida ou sem justificativa escrita:\n  ${ruins.join("\n  ")}`).toEqual([]);
  });

  it("a Fase 4 fechou: sobra uma dívida, e ela declara por que sobrou", () => {
    // As três regras acima forçam a lista a ENCOLHER, mas nada impedia que ela
    // voltasse a CRESCER: uma `DIVIDA` nova entra sem ninguém notar, porque
    // acrescentar linha à allowlist é o caminho de menor resistência de quem
    // está com pressa. Este caso trava o conjunto pelo NOME, não pelo tamanho —
    // contar só o número deixaria trocar uma dívida por outra em silêncio.
    const dividas = Object.entries(MARCA_CONGELADA)
      .filter(([, e]) => e.categoria === "DIVIDA")
      .map(([arquivo]) => arquivo);
    expect(
      dividas,
      "a Fase 4 zerou as dívidas de marca, exceto o alarme de orçamento de IA " +
        "(que não tem caminho de produção). Dívida nova aqui precisa de decisão, " +
        "não de mais uma linha na lista.",
    ).toEqual(["lib/email/templates/ai-budget-alarm.tsx"]);
  });

  it("toda DIVIDA nomeia a fase que a resolve, e só DIVIDA tem fase", () => {
    // Pendência sem prazo é pendência esquecida — e categoria que não é dívida
    // com "fase" declarada seria alguém tratando contrato de fio como pendência.
    const semFase = Object.entries(MARCA_CONGELADA)
      .filter(([, e]) => (e.categoria === "DIVIDA") !== (typeof e.fase === "number"))
      .map(([f]) => f);
    expect(semFase, `DIVIDA sem fase, ou fase declarada onde não é dívida:\n  ${semFase.join("\n  ")}`).toEqual([]);
  });
});

/**
 * A SEGUNDA varredura: os arquivos que o GoTrue lê, e que a primeira nunca viu.
 *
 * A catraca de cima varre `.ts`/`.tsx` de `app|components|hooks|lib|workers` —
 * o código que embarca na imagem. Ela é cega para `supabase/templates/*.html` e
 * `supabase/config.toml`, e essa cegueira tinha consequência medida: dava para
 * zerar a lista de dívidas, ver a suíte inteira verde, e o cliente do
 * revendedor continuar recebendo "Confirme seu e-mail — DeskcommCRM" no
 * PRIMEIRO e-mail que ele abre na vida.
 *
 * Estes arquivos não são renderizados por nenhum TypeScript nosso: quem os
 * renderiza é o GoTrue, um processo de terceiro. Não há resolvedor a chamar —
 * o texto é empurrado por API pelo `hostgator-setup-kit/marca-emails.sh`, que
 * substitui os `__PLACEHOLDER__`. Por isso a guarda aqui é diferente em
 * NATUREZA da de cima: lá ela cobra `branding()`; aqui ela cobra placeholder.
 *
 * ⚠️ A REGRA DE COMENTÁRIO NÃO SE REAPROVEITA. `marcasNoTexto` ignora linha que
 * ABRE com `//`, `*` ou `/*`. Comentário de HTML é `<!-- … -->`, atravessa
 * várias linhas e as linhas do meio não abrem com nada. Copiar a função sem
 * ajustar faria a marca DENTRO de um comentário contar como vazamento e a marca
 * de verdade, na mesma linha de um `-->`, passar.
 */
describe("catraca de marca no que o GoTrue renderiza", () => {
  /** Comentário de HTML é um TRECHO, não um prefixo de linha. */
  function semComentariosHtml(fonte: string): string {
    return fonte.replace(/<!--[\s\S]*?-->/g, "");
  }

  /**
   * TOML: só linha que ABRE com `#`. Um `#` no meio da linha não é tratado como
   * comentário DE PROPÓSITO — `#506d48` dentro de uma string seria decapitado, e
   * uma marca depois dele sumiria. Contar demais aqui custa uma linha de
   * allowlist; contar de menos custa a marca vazando com o gate verde.
   */
  function semComentariosToml(fonte: string): string {
    return fonte
      .split("\n")
      .filter((linha) => !linha.trimStart().startsWith("#"))
      .join("\n");
  }

  const ALVOS: { arquivo: string; limpar: (f: string) => string }[] = [
    { arquivo: "supabase/templates/confirmation.html", limpar: semComentariosHtml },
    { arquivo: "supabase/templates/recovery.html", limpar: semComentariosHtml },
    { arquivo: "supabase/config.toml", limpar: semComentariosToml },
  ];

  const CONGELADO_SUPABASE: Record<string, EntradaDeMarca> = {
    "supabase/config.toml": {
      categoria: "DEV",
      motivo:
        "config do Supabase LOCAL (o `supabase start` de dev e do CI). NÃO embarca na imagem e NÃO alcança clone nenhum: um self-hoster usa um projeto na nuvem do Supabase, cuja config de auth vem do marca-emails.sh, ou um GoTrue próprio, que lê env. `project_id` ainda nomeia os contêineres locais (supabase_auth_deskcomm-crm) e os assuntos são o que a suíte local envia",
      marcas: ["deskcomm-crm", "deskcommcrm", "deskcommcrm"],
    },
  };

  const encontradoAqui = new Map<string, string[]>();
  for (const { arquivo, limpar } of ALVOS) {
    const marcas = marcasNoTexto(limpar(fs.readFileSync(path.join(RAIZ, arquivo), "utf8")));
    if (marcas.length > 0) encontradoAqui.set(arquivo, marcas);
  }

  it("os arquivos varridos existem e os modelos têm placeholder", () => {
    // Vacuidade em duas pontas. Se os arquivos sumissem de lugar, a varredura
    // devolveria vazio e os casos abaixo passariam vigiando o nada; e se os
    // modelos perdessem o `__APP_NAME__`, "sem marca" passaria a significar
    // "sem nome nenhum no e-mail", que é outro defeito com o mesmo sintoma.
    for (const { arquivo } of ALVOS) {
      expect(fs.existsSync(path.join(RAIZ, arquivo)), `${arquivo} sumiu`).toBe(true);
    }
    for (const modelo of ["supabase/templates/confirmation.html", "supabase/templates/recovery.html"]) {
      const texto = fs.readFileSync(path.join(RAIZ, modelo), "utf8");
      expect(texto, `${modelo} não substitui a marca`).toContain("__APP_NAME__");
      expect(texto, `${modelo} não substitui o accent`).toContain("__ACCENT__");
    }
  });

  it("comentário de HTML não conta, e `-->` no meio da linha não engole o resto", () => {
    expect(marcasNoTexto(semComentariosHtml("<!-- fala do DeskcommCRM -->"))).toEqual([]);
    expect(marcasNoTexto(semComentariosHtml("<!--\n  DeskcommCRM\n  em várias linhas\n-->"))).toEqual([]);
    // O caso que a regra de `//` erraria: marca REAL depois do fecho.
    expect(marcasNoTexto(semComentariosHtml("<!-- nota --> Sua conta no DeskcommCRM"))).toEqual([
      "deskcommcrm",
    ]);
    // E a marca fora de comentário nenhum continua contando.
    expect(marcasNoTexto(semComentariosHtml("<p>conta no DeskcommCRM</p>"))).toEqual(["deskcommcrm"]);
  });

  it("comentário de TOML não conta, mas `#` dentro de string não vira comentário", () => {
    expect(marcasNoTexto(semComentariosToml("# Supabase CLI config — DeskcommCRM"))).toEqual([]);
    expect(marcasNoTexto(semComentariosToml('cor = "#506d48"  # DeskcommCRM'))).toEqual([
      "deskcommcrm",
    ]);
    expect(marcasNoTexto(semComentariosToml('subject = "Olá — DeskcommCRM"'))).toEqual(["deskcommcrm"]);
  });

  it("nenhum arquivo do GoTrue fixa a marca fora da lista", () => {
    const novos = [...encontradoAqui.keys()].filter((f) => !(f in CONGELADO_SUPABASE));
    expect(
      novos,
      `Marca hardcoded em arquivo que o GoTrue renderiza.\n` +
        `Use o placeholder __APP_NAME__ (quem substitui é hostgator-setup-kit/marca-emails.sh):\n` +
        novos.map((f) => `  ${f}  ${JSON.stringify(encontradoAqui.get(f))}`).join("\n"),
    ).toEqual([]);
  });

  it("a lista do GoTrue não guarda arquivo que já não tem marca", () => {
    const obsoletos = Object.keys(CONGELADO_SUPABASE).filter((f) => !encontradoAqui.has(f));
    expect(obsoletos, `apague a linha destes de CONGELADO_SUPABASE:\n  ${obsoletos.join("\n  ")}`).toEqual([]);
  });

  it("arquivo congelado do GoTrue não mudou de conjunto sem a lista acompanhar", () => {
    for (const [arquivo, entrada] of Object.entries(CONGELADO_SUPABASE)) {
      expect(encontradoAqui.get(arquivo) ?? [], arquivo).toEqual([...entrada.marcas].sort());
    }
  });

  it("os dois modelos de e-mail não têm marca nenhuma — é o estado que se defende", () => {
    // Explícito, e não só implícito na ausência de linha na allowlist: é ESTE
    // caso que falha quando alguém reescreve "no DeskcommCRM" num template.
    expect(encontradoAqui.has("supabase/templates/confirmation.html")).toBe(false);
    expect(encontradoAqui.has("supabase/templates/recovery.html")).toBe(false);
  });
});

/**
 * A TERCEIRA varredura: host de terceiro.
 *
 * A catraca acima é cega para URL sem a marca. O caso medido é o #266: um
 * `HTTP-Referer` com o domínio pessoal do contribuidor foi parar na chamada de
 * TODO self-hoster, e a varredura da época só olhava `deskcomm` — o `X-Title`
 * ficava coberto pela marca, o domínio sozinho passava verde. Host de terceiro
 * no código que embarca é a mesma falha por outro nome: o domínio de alguém
 * viaja na imagem que o cliente instala, e ninguém vê.
 *
 * Tudo aqui foi MEDIDO na `main` antes de virar régua — catraca nova se calibra
 * antes de virar catraca, senão ela nasce ruidosa e o time aprende a ignorá-la:
 *
 *  - superfície: `app|components|hooks|lib|workers`, o que o `Dockerfile` copia
 *    para a imagem (`.next/standalone`, `.next/static`, `public/`) — a MESMA da
 *    catraca de marca, mais `app/design` (embarca) e menos os `*.test.ts(x)`
 *    (fixture não embarca). 1717 arquivos.
 *  - régua crua sobre a `main`: 21 hosts, NENHUM vazamento — todos endpoint de
 *    fornecedor, painel de fornecedor, amostra de campo ou identificador de fio.
 *    Cada um está declarado abaixo com categoria e motivo, e é o julgamento
 *    deles que esta catraca passa a defender.
 *  - o que a régua NÃO pega, de propósito e com medição: host nu FORA de aspas
 *    (339 linhas e 160 "hosts" na superfície, quase todos identificador
 *    pontuado — `logger.info(`, `auth.organization_id`, `message.received`) e
 *    host com TLD fora da lista explícita de `HOST_NU_EM_STRING`. As duas são a
 *    fronteira conhecida desta catraca; a alternativa foi medida e é pior.
 *  - lista por HOST, não por arquivo: o segundo call site de um endpoint já
 *    declarado não pede linha nova (`api.openai.com` aparece em 5 arquivos,
 *    `graph.facebook.com` em 6). `FORNECEDOR` pode crescer — provider novo é
 *    provider novo. `CONSOLE`, `AMOSTRA`, `PLATAFORMA` e `PROTOCOLO` são
 *    conjunto FECHADO fixado por nome, porque é nessas que a pressa tentaria
 *    declarar um vazamento para seguir em frente.
 */
type CategoriaDeHost =
  /** Endpoint do fornecedor: PARA ONDE o código fala. Pode crescer. */
  | "FORNECEDOR"
  /** Painel/documentação do fornecedor: onde o usuário busca a credencial DELE. */
  | "CONSOLE"
  /** Amostra de formato em campo de formulário. Chega à tela — por isso se declara. */
  | "AMOSTRA"
  /** Host de plataforma ACEITO na entrada (validação), não destino de chamada. */
  | "PLATAFORMA"
  /** Identificador de fio que gravamos; quem reconhece é código de fora. */
  | "PROTOCOLO";

type EntradaDeHost = { categoria: CategoriaDeHost; motivo: string };

const HOSTS_DECLARADOS: Record<string, EntradaDeHost> = {
  // ── prospecção (PR #963): destino de chamada do crawler ──
  "api.apify.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da plataforma que roda o crawler do Google Places (`lib/prospecting/provider.ts`). É o destino do request, com a chave da PRÓPRIA organização — trocar pelo domínio do revendedor quebraria a chamada, e esconder o nome não esconde para onde o dado vai.",
  },
  // ── identificador de fio: NÃO é destino de chamada nem texto de tela ──────
  "s.whatsapp.net": {
    categoria: "PROTOCOLO",
    motivo:
      "sufixo do JID do WhatsApp. Aparece em `lib/waha/resolve-contact-whatsapp-id.ts` desde antes desta régua existir, num `endsWith` que distingue `@lid`, `@c.us` e `@s.whatsapp.net` — é o protocolo do WhatsApp falando, não endereço que o produto chama nem palavra de interface. Trocar pela marca do revendedor faz o CRM deixar de reconhecer o identificador que o próprio WhatsApp manda.",
  },
  // ── destino de chamada: o código fala com eles, sempre foi assim ──────────
  "api.openai.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da API da OpenAI (embeddings da busca e transcrição de áudio). É o destino do request: trocar pelo domínio do revendedor faria a chamada não chegar a lugar nenhum.",
  },
  "api.anthropic.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da API da Anthropic (contagem de tokens e a prova de credencial da tela de configuração). Mesma razão: é o destino, não texto de interface.",
  },
  "openrouter.ai": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da OpenRouter nos três caminhos que falam com ela (runtime, catálogo de modelos e prova de crédito). O `HTTP-Referer` da atribuição NÃO mora aqui — sai de env (OPENROUTER_APP_URL), e quem o defende é tests/unit/openrouter-atribuicao.test.ts.",
  },
  "api.deepseek.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da API da DeepSeek (OpenAI-compatível) no registry de produção, no runtime de ensaio, no validador de chave e na prova de crédito. É o destino do request, não texto de interface; trocar pelo domínio do revendedor faria a chamada não chegar.",
  },
  "generativelanguage.googleapis.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da API Gemini (visão e tradução). Domínio do fornecedor, sem alternativa que não seja proxy nosso.",
  },
  "graph.facebook.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da Graph API do WhatsApp Cloud — 6 arquivos: envio de template, sincronização de modelos, validação de credencial, conversões e insights. É contrato da Meta, não escolha nossa.",
  },
  "www.googleapis.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint das APIs do Google que a agenda usa (calendar/v3, oauth2/v4, userinfo). O projeto é do cliente; o domínio é do fornecedor.",
  },
  "oauth2.googleapis.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint de token do OAuth do Google — o par de `accounts.google.com` no fluxo de autorização da agenda, e também do Google Ads (`lib/plataformas-de-anuncio/google/token.ts`).",
  },
  "googleads.googleapis.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint da Google Ads API, para onde `lib/plataformas-de-anuncio/google/conversions.ts` reporta a venda de volta ao anúncio que trouxe o lead. Irmão de `graph.facebook.com` no eixo da Meta: é contrato do fornecedor, não escolha nossa — a conta de anúncios é do cliente, o domínio é do Google.",
  },
  "accounts.google.com": {
    categoria: "FORNECEDOR",
    motivo:
      "tela de consentimento do OAuth do Google: é para lá que o usuário é REDIRECIONADO para autorizar a agenda. Endereço do fornecedor por definição.",
  },
  "api.tiendanube.com": {
    categoria: "FORNECEDOR",
    motivo: "endpoint da API da Nuvemshop/Tiendanube (ordens e catálogo do e-commerce do cliente).",
  },
  "www.tiendanube.com": {
    categoria: "FORNECEDOR",
    motivo:
      "base de autorização do OAuth da Nuvemshop — para onde o lojista é mandado autorizar o aplicativo. Sem ela, a integração não conecta.",
  },
  "zernio.com": {
    categoria: "FORNECEDOR",
    motivo:
      "endpoint padrão do adapter do canal de mensagens, com override por ZERNIO_API_BASE_URL. Fixo de propósito: instalação que não configura nada tem de funcionar.",
  },
  // ── painel do fornecedor: texto de tela apontando para o endereço DELE ────
  "platform.openai.com": {
    categoria: "CONSOLE",
    motivo:
      "painel onde o usuário gera a PRÓPRIA chave da OpenAI. O endereço é do fornecedor e é a informação que a tela tem de dar — mandar para outro lugar seria pior.",
  },
  "console.anthropic.com": {
    categoria: "CONSOLE",
    motivo: "painel de chaves da Anthropic. Mesmo caso: é de onde a credencial do usuário sai.",
  },
  "platform.deepseek.com": {
    categoria: "CONSOLE",
    motivo:
      "painel onde o usuário gera a PRÓPRIA chave da DeepSeek (`ondePegarAChave` em lib/ai/pontos/provedores.ts). Endereço do fornecedor, não nosso.",
  },
  "aistudio.google.com": {
    categoria: "CONSOLE",
    motivo: "Google AI Studio — onde o usuário cria a chave do Gemini.",
  },
  "partners.tiendanube.com": {
    categoria: "CONSOLE",
    motivo:
      "portal de parceiros da Nuvemshop, onde o operador registra o aplicativo e pega client id e secret. Endereço da plataforma, não nosso.",
  },
  // ── amostra de formato: mostra o que digitar, não é destino ──────────────
  "wa.me": {
    categoria: "AMOSTRA",
    motivo:
      "o encurtador de link do próprio WhatsApp, num exemplo de link GERADO pela tela de Conversões (issue #924): é o formato que quem opera vai colar no botão da landing page. Não é destino de chamada — o produto nunca fala com `wa.me`; quem abre o link é o visitante do site, no navegador dele. E não é marca nossa que um revendedor troque: o endereço é da Meta, e trocá-lo faria o link não abrir conversa nenhuma. Fica AMOSTRA porque chega à TELA, que é a razão de a régua exigir declaração em vez de silêncio.",
  },
  "meusistema.com": {
    categoria: "AMOSTRA",
    motivo:
      "placeholder do campo de URL do webhook de saída: mostra o FORMATO do que digitar. A doutrina já trata endereço de rede em tela como exemplo técnico (tests/unit/i18n-espanhol-cobre-a-tela.test.ts).",
  },
  "tusitio.com": {
    categoria: "AMOSTRA",
    motivo:
      "placeholder do campo de URL de redirecionamento do webhook: mesma natureza — amostra de formato, não destino que o produto busca.",
  },
  "mi-gateway.ejemplo.com": {
    categoria: "AMOSTRA",
    motivo:
      "placeholder do campo de base URL de gateway OpenAI-compatible na tela de provedores: amostra do formato aceito.",
  },
  "000000000000-xxxxxxxx.apps.googleusercontent.com": {
    categoria: "AMOSTRA",
    motivo:
      "placeholder do campo de client id do Google: exibe o FORMATO do identificador (e o host que ele carrega) para quem vai criar a credencial no console.",
  },
  // ── entrada conferida e identificador de fio ─────────────────────────────
  "meet.google.com": {
    categoria: "PLATAFORMA",
    motivo:
      "host do Google Meet aceito na validação do link de reunião (`meetVideoUrl`): é entrada que o produto CONFERE, não endereço que ele busca. Sem a linha, qualquer host passaria por link de reunião.",
  },
  "deskcomm.app": {
    categoria: "PROTOCOLO",
    motivo:
      "sufixo do iCalUID gravado no Google Calendar do cliente (lib/agenda/google/evento.ts). Identificador de fio que reconhecemos meses depois — já congelado como PROTOCOLO pela catraca de marca.",
  },
};

describe("catraca de host de terceiro no código que embarca", () => {
  const alvos = RAIZES_VARRIDAS.flatMap((raiz) =>
    arquivosVarridos(raiz, { comDesign: true, comTeste: false }),
  );
  /** host → arquivos onde aparece, para a falha apontar onde ele mora. */
  const encontrados = new Map<string, string[]>();
  for (const arquivo of alvos) {
    for (const host of hostsNoTexto(fs.readFileSync(path.join(RAIZ, arquivo), "utf8"))) {
      encontrados.set(host, [...(encontrados.get(host) ?? []), arquivo]);
    }
  }

  it("a varredura alcança o código que embarca — senão o resto não prova nada", () => {
    expect(alvos.length).toBeGreaterThan(800);
    expect(alvos.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(200);
    expect(alvos.filter((f) => /\.(test|spec)\.tsx?$/.test(f))).toEqual([]);
    // Canário: `api.openai.com` está no código desde antes desta catraca. Se o
    // extrator quebrar (regex, regra de comentário, forma da string), o conjunto
    // esvazia, TODOS os casos abaixo passam e a catraca vira decoração — foi
    // assim que a varredura antiga ficava verde enquanto o domínio vazava.
    expect(
      encontrados.has("api.openai.com"),
      "canário: o extrator parou de achar o que sempre achou",
    ).toBe(true);
  });

  it("pega host de terceiro no formato do #266 — o caso que a régua antiga deixava passar", () => {
    // O contrafactual da issue, com o `X-Title` fora de propósito: a catraca de
    // marca pega o X-Title (é a marca) e não pegava o domínio sozinho.
    expect(
      hostsNoTexto('headers: { "HTTP-Referer": "https://crm.do-contribuidor.com.br" }'),
    ).toEqual(["crm.do-contribuidor.com.br"]);
    expect(hostsNoTexto('const BASE = "https://api.do-contribuidor.com.br/v1";')).toEqual([
      "api.do-contribuidor.com.br",
    ]);
    expect(hostsNoTexto("const BASE = `https://api.do-contribuidor.com.br/v1`;")).toEqual([
      "api.do-contribuidor.com.br",
    ]);
  });

  it("pega host NU quando ele é o conteúdo de uma string — e não identificador pontuado", () => {
    expect(hostsNoTexto('url.hostname === "meet.google.com"')).toEqual(["meet.google.com"]);
    expect(hostsNoTexto('placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"')).toEqual([
      "000000000000-xxxxxxxx.apps.googleusercontent.com",
    ]);
    // Os falsos medidos da forma "em qualquer contexto" — é por causa deles que
    // o host nu só vale dentro de aspas, e é o `(?![a-z0-9_-])` que impede
    // `auth.organization_id` de casar como `auth.org`.
    expect(hostsNoTexto("logger.info(evento);")).toEqual([]);
    expect(hostsNoTexto('audit("auth.organization_id", { org });')).toEqual([]);
    expect(hostsNoTexto('emit("message.received", payload);')).toEqual([]);
    expect(hostsNoTexto('localStorage.getItem("deskcomm.show_ai_citations")')).toEqual([]);
    // Os 6 falsos que a PRIMEIRA versão da régua produziu na `main`: nomes de
    // evento de auditoria cujo prefixo termina num "TLD" (`ai`, `org`, `app`,
    // `store`) seguido de `_`. Nenhum deles é host, e é o `_` no lookahead que
    // os separa de um host de verdade.
    expect(hostsNoTexto('action: "onboarding.ai_configured",')).toEqual([]);
    expect(hostsNoTexto('action: "ai.org_memory_published",')).toEqual([]);
    expect(hostsNoTexto('action: "channel.ai_access_updated",')).toEqual([]);
    expect(hostsNoTexto('action: "conversation.ai_paused",')).toEqual([]);
    expect(hostsNoTexto('action: "lgpd.store_redact_received",')).toEqual([]);
    expect(hostsNoTexto("`env.APP_NAME` cru")).toEqual([]);
  });

  it("host que não resolve — loopback, IP, serviço do Docker, sentinela — não pede linha", () => {
    expect(hostsNoTexto('const u = "http://localhost:3000/api";')).toEqual([]);
    expect(hostsNoTexto('fetch("http://waha:3000/api");')).toEqual([]);
    expect(hostsNoTexto('const s = "http://127.0.0.1:54321";')).toEqual([]);
    expect(hostsNoTexto('const s = "https://10.0.0.5/x";')).toEqual([]);
    expect(hostsNoTexto('const s = "https://169.254.169.254/latest/meta-data";')).toEqual([]);
    expect(hostsNoTexto('const s = "http://.../";')).toEqual([]);
    expect(hostsNoTexto('const s = "https://crm.exemplo.test";')).toEqual([]);
    expect(hostsNoTexto('const s = "https://x.example.com/v1";')).toEqual([]);
  });

  it("não conta host em comentário, e não confunde o `//` da URL com comentário", () => {
    expect(hostsNoTexto("  // o endpoint é https://api.openai.com/v1")).toEqual([]);
    expect(hostsNoTexto(" * https://api.openai.com/v1/docs")).toEqual([]);
    expect(hostsNoTexto('const u = "https://api.openai.com/v1";')).toEqual(["api.openai.com"]);
  });

  it("nenhum host de terceiro fora da lista declarada", () => {
    const novos = [...encontrados.keys()].filter((h) => !(h in HOSTS_DECLARADOS));
    expect(
      novos,
      "Host de terceiro hardcoded no código que embarca (a imagem que o cliente instala).\n" +
        "Se é endereço do fornecedor (o código FALA com ele) ou painel dele (o usuário busca a\n" +
        "credencial lá), declare em HOSTS_DECLARADOS com categoria e motivo. Se é amostra de\n" +
        "formato de campo, declare como AMOSTRA — ela chega à tela, então se declara em vez de\n" +
        "se ignorar. E se é o domínio de alguém — o seu, o de um contribuidor, o do cliente de\n" +
        "vocês, o de um serviço de teste —, tire do código: foi exatamente o #266.\n\n" +
        novos
          .map((h) => {
            const onde = encontrados.get(h) ?? [];
            const lista = onde.slice(0, 4).join(", ") + (onde.length > 4 ? ", …" : "");
            return `  ${h}  →  ${lista}`;
          })
          .join("\n"),
    ).toEqual([]);
  });

  it("a lista não guarda host que saiu do código", () => {
    const obsoletos = Object.keys(HOSTS_DECLARADOS).filter((h) => !encontrados.has(h));
    expect(
      obsoletos,
      "Estes hosts não aparecem mais no código que embarca — apague a linha de HOSTS_DECLARADOS:\n" +
        obsoletos.map((h) => `  ${h}`).join("\n"),
    ).toEqual([]);
  });

  it("toda entrada declara categoria válida e explica o porquê", () => {
    const categorias: CategoriaDeHost[] = [
      "FORNECEDOR",
      "CONSOLE",
      "AMOSTRA",
      "PLATAFORMA",
      "PROTOCOLO",
    ];
    for (const [host, entrada] of Object.entries(HOSTS_DECLARADOS)) {
      expect(categorias, `${host}: categoria desconhecida`).toContain(entrada.categoria);
      expect(
        entrada.motivo.length,
        `${host}: motivo curto demais para servir de rastro`,
      ).toBeGreaterThan(40);
    }
  });

  it("só FORNECEDOR pode crescer — o resto é conjunto fechado", () => {
    // A pressa descreveria o vazamento como AMOSTRA (ou chamaria um domínio
    // pessoal de CONSOLE) e seguiria em frente. Estas categorias não são
    // destino de chamada, então crescem só por decisão explícita: a lista
    // abaixo é fixada por NOME, e mexer nela é editar teste, no diff.
    const fechadas = Object.entries(HOSTS_DECLARADOS)
      .filter(([, entrada]) => entrada.categoria !== "FORNECEDOR")
      .map(([host]) => host)
      .sort();
    expect(
      fechadas,
      "Categoria fechada ganhou host novo. Se o código FALA com ele, é FORNECEDOR; se não, " +
        "o crescimento tem de ser uma decisão escrita aqui — não mais uma linha na lista.",
    ).toEqual([
      "000000000000-xxxxxxxx.apps.googleusercontent.com",
      "aistudio.google.com",
      "console.anthropic.com",
      "deskcomm.app",
      "meet.google.com",
      "meusistema.com",
      "mi-gateway.ejemplo.com",
      "partners.tiendanube.com",
      "platform.deepseek.com",
      "platform.openai.com",
      // Decisão escrita, que é o que esta lista cobra: `s.whatsapp.net` é o
      // sufixo do JID do WhatsApp, lido em `lib/waha/resolve-contact-whatsapp-id.ts`
      // desde antes desta régua. Não é destino de chamada (o código fala com o
      // WAHA, não com esse host) nem texto de tela — é o identificador que o
      // protocolo manda. Entrou aqui porque a régua nova do #914 passou a
      // enxergá-lo, e não porque o produto ganhou host novo.
      "s.whatsapp.net",
      "tusitio.com",
      // Exemplo de link do WhatsApp gerado pela tela de Conversões (#924). Está
      // aqui, e não em FORNECEDOR, porque o produto NÃO fala com esse host: quem
      // abre o link é o visitante do site. Crescimento escrito, como a regra pede.
      "wa.me",
    ]);
  });

  it("o filtro de fixture e a fronteira do app/design funcionam", () => {
    const comTeste = arquivosVarridos("hooks", { comTeste: true });
    const semTeste = arquivosVarridos("hooks", { comTeste: false });
    expect(semTeste.length).toBeGreaterThan(0);
    expect(comTeste.length).toBeGreaterThan(semTeste.length);
    expect(semTeste.filter((f) => /\.(test|spec)\.tsx?$/.test(f))).toEqual([]);
    // `app/design` entra na varredura de host (embarca) e fica fora da de marca.
    expect(
      arquivosVarridos("app", { comDesign: true }).some((f) => f.startsWith("app/design")),
    ).toBe(true);
    expect(arquivosVarridos("app").some((f) => f.startsWith("app/design"))).toBe(false);
  });
});

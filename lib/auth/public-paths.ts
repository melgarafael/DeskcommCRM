import { PORTAS_DE_TOKEN } from "@/lib/auth/portas-de-token";

/**
 * Paths that bypass auth check in middleware.
 * Match precedence: array order. First match wins.
 */
export const PUBLIC_PATHS: RegExp[] = [
  // Link público persistido: org e destino são resolvidos exclusivamente no servidor.
  /^\/api\/v1\/rastreio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/$/,
  /^\/login(\/.*)?$/,
  /^\/signup$/,
  /^\/auth\/confirm$/,
  // A VOLTA DA ENTRADA COM GOOGLE (issue #1388). Quem chega aqui é o NAVEGADOR
  // que o Google devolveu, via 302 do GoTrue — navegação vinda de outro site,
  // onde o cookie de sessão (`sameSite: "strict"`) não viaja por definição.
  // Sem esta linha o `proxy` responde 307 para `/login` antes de a rota
  // existir, e o fluxo NUNCA completa: mesma classe medida na v1.8.0, em
  // produção, com o callback da agenda (`GET /api/v1/agenda/google/callback`
  // → 401 `unauthenticated`).
  //
  // A identidade NÃO vem da sessão: vem do `code` que o GoTrue assinou, trocado
  // por sessão DENTRO da rota (`exchangeCodeForSession`), que só fecha se o
  // verificador de PKCE gravado na ida voltar — em cookie `Lax`, ver
  // `createClientDeEntradaComGoogle`. Âncora `$` de propósito: nenhum sub-path
  // futuro nasce público de carona.
  /^\/auth\/callback$/,
  // Retorno de OAuth social: documento público sem efeitos que reconecta a
  // navegação interna para manter os cookies de sessão sob SameSite=Strict.
  /^\/auth\/social-return$/,
  // Volta da página de cadastro do provedor parceiro (conexão do número por um
  // clique): mesma natureza da linha acima — documento sem efeito que só repassa
  // à tela autenticada. O segmento é o estado assinado, no formato exato de
  // `FORMATO_DO_ESTADO` (lib/channels/estado-da-volta.ts): nenhum outro sub-path
  // nasce público de carona.
  /^\/auth\/partner-return\/[A-Za-z0-9_-]{20,600}\.[0-9a-f]{64}$/,
  // Volta do provedor de pagamento (checkout, portal): mesma natureza da linha
  // acima — vem de outro site, o cookie Strict não viaja, e a rota é só a ponte
  // para um destino FIXO (`app/cobranca/volta/route.ts`), sem efeito.
  /^\/cobranca\/volta$/,
  /^\/403$/,
  /^\/admin\/forbidden$/,
  /^\/404$/,
  /^\/500$/,
  /^\/503$/,
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/webhooks\//,
  /^\/api\/v1\/cron\//,
  // Landing page de captura de clique do Google Ads (migration 0306). Quem
  // chega aqui é o NAVEGADOR de quem clicou no anúncio — nunca tem, e não
  // pode ter, cookie de sessão nossa. Sem esta linha o proxy devolve 401
  // antes de a rota existir, e todo clique pago vira um erro em vez de um
  // redirect pro WhatsApp. Âncorado num segmento só (`[^/]+$`): um sub-path
  // futuro sob `/google/` não nasce público de carona.
  /^\/api\/v1\/anuncios\/google\/[^/]+$/,
  // A irmã da Meta (UTMs da landing → `[ref:]`), mesma natureza e mesma âncora.
  // Faltava esta linha: a rota existia, o script do site apontava os botões
  // para ela, e todo visitante recebia 401 do proxy em vez do WhatsApp —
  // medido em produção em 02/10/2026.
  /^\/api\/v1\/anuncios\/meta\/[^/]+$/,
  // Heartbeat do agente do host (bearer INTERNAL_SECRET/INTERNAL_CRON_SECRET,
  // checado dentro da própria rota) — sem cookie de sessão, igual /cron/.
  /^\/api\/v1\/system\/agent$/,
  // Provisionamento de organização por sistema externo: Bearer do segredo da
  // instalação (`TENANT_PROVISIONING_SECRET`), checado dentro da rota, que
  // responde 404 enquanto o segredo não existe. Sem cookie, igual /cron/.
  /^\/api\/v1\/tenants\/provision$/,
  // Relógio Hobby (GitHub Actions / cron-job.org). Auth é Bearer na própria
  // rota — sem isto o proxy devolve 401 e o follow-up waiting_reply nunca anda.
  /^\/api\/v1\/system\/relogio\/tick$/,
  // VOLTAS DE CONSENTIMENTO OAuth. O provedor devolve o NAVEGADOR para cá, e
  // essa navegação vem de outro site — o cookie de sessão é `sameSite: "strict"`
  // e, por definição, não viaja nela. Sem estas duas linhas o `proxy` responde
  // 401 antes de a rota existir, e o fluxo NUNCA completa: medido na v1.8.0, em
  // produção, `GET /api/v1/agenda/google/callback` → 401 `unauthenticated`.
  //
  // A identidade não vem da sessão e sim do `state` assinado (HMAC de
  // `INTERNAL_SECRET`), com nonce de uso único; no caso do Google, somado a um
  // cookie de vínculo `SameSite=Lax` (`lib/agenda/google/vinculo.ts`) que prova
  // que o navegador que volta é o que saiu. Mesma natureza de
  // `/api/v1/system/relogio/tick`, logo acima: a auth mora DENTRO da rota.
  //
  // Ancorados com `$` de propósito — `/^\/api\/v1\/agenda\/google\// deixaria
  // qualquer sub-path futuro nascer público de carona.
  /^\/api\/v1\/agenda\/google\/callback$/,
  // OAuth POR CONTATO de servidor MCP externo (migration 9095). Quem chega é o
  // navegador do CLIENTE FINAL — nunca teve sessão nossa. A autoridade é o
  // `state` de `mcp_oauth_pedidos` (256 bits, uso único, 10 min, amarrado a
  // organização/servidor/contato/conversa), conferido DENTRO das rotas; nada
  // da URL escolhe tenant. `iniciar` aceita um segmento só, em forma de state;
  // `callback` um só, em forma de UUID (o servidor, conferido contra o state).
  /^\/api\/v1\/mcp-oauth\/callback\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  /^\/api\/v1\/mcp-oauth\/iniciar\/[A-Za-z0-9_-]{43}$/,
  // Volta do consentimento do Google Ads. Mesma natureza das duas linhas
  // acima: a identidade vem do `state` assinado
  // (`lib/plataformas-de-anuncio/google/estado.ts`), não da sessão — quem
  // volta do Google não tem, e não pode ter, o cookie.
  /^\/api\/v1\/plataformas-de-anuncio\/google\/callback$/,
  /^\/api\/v1\/integrations\/nuvemshop\/callback$/,
  /^\/api\/internal\//,
  /^\/api\/mcp(\/.*)?$/,
  // GET /api/v1/contacts aceita SESSÃO ou Bearer `dsk_...` (api_tokens) — a
  // MESMA dualidade de `/api/mcp` acima. Sem esta entrada, o proxy responde
  // 401 antes de o Bearer chegar à rota, porque `getUser()` aqui só enxerga
  // cookie. A auth de verdade (sessão OU token, org nunca vinda do cliente)
  // mora DENTRO da rota (`app/api/v1/contacts/route.ts`), igual aos casos de
  // `/api/v1/system/agent` e `/api/v1/cron/` acima — "público" aqui quer dizer
  // "o proxy não decide", não "sem autenticação". Ancorado com `$`: só o
  // `GET` da listagem, não `/api/v1/contacts/import`, que ainda não tem suporte
  // a Bearer. (O `[id]` passou a ter, pela linha LOGO ABAIXO — #4517.)
  /^\/api\/v1\/contacts$/,
  // A FICHA EDITADA POR TOKEN (#4517). `PATCH /api/v1/contacts/{id}` cobra o
  // escopo PRÓPRIO `contacts:write` e resolve a identidade por
  // `lib/api/auth-dual.ts` DENTRO da rota, com a organização saindo da LINHA DO
  // TOKEN. Sem esta linha, todo Bearer recebe 401 do proxy antes do handler e a
  // porta é inalcançável em produção, por mais correta que a rota esteja.
  //
  // O segmento é FORMA DE UUID, nunca `[^/]+`: os irmãos literais de
  // `/api/v1/contacts/` (`bulk`, `duplicates`, `export`, `import`, `merge`) não
  // têm porta de token, e um padrão largo os tornaria públicos de carona.
  /^\/api\/v1\/contacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // FOTO DO CONTATO SERVER-TO-SERVER (issue #3420). Mesma dualidade da
  // listagem logo acima: sessão de navegador OU Bearer `dsk_…` com escopo
  // `contacts:read`, resolvido por `lib/api/auth-dual.ts` DENTRO da rota
  // (`app/api/v1/contacts/[id]/avatar/route.ts`), com a organização saindo da
  // LINHA DO TOKEN e nunca do path. Existe porque quem pede a foto por aqui é
  // um servidor (um painel próprio seguindo o 307 para o bucket), não uma tela.
  // Sem esta linha o proxy devolve 401 ao Bearer antes do handler — a tela não
  // muda (ela entra por cookie pelo `/api/v1/contacts` de cima), só a porta do
  // token deixa de ser inalcançável.
  //
  // O segmento do id é FORMA DE UUID, nunca `[^/]+`: `/api/v1/contacts/` tem
  // irmãos LITERAIS no mesmo nível (`bulk`, `duplicates`, `export`, `import`,
  // `merge`), nenhum deles com suporte a Bearer, que um padrão largo tornaria
  // público por engano. Âncora `$`: nenhum sub-path futuro de `/avatar` nasce
  // público de carona.
  /^\/api\/v1\/contacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/avatar$/i,
  // COMANDOS DE CONVERSA POR TOKEN (#4517). Pausar/retomar a IA e fechar/reabrir
  // são as três coisas que a integração fazia por transferência — e transferir
  // troca o responsável do negócio, que é justamente o que a issue pede para NÃO
  // acontecer. Cada rota resolve a identidade por `lib/api/auth-dual.ts` e cobra
  // o escopo `conversations:write`; a organização vem da LINHA DO TOKEN.
  //
  // Sem estas quatro linhas, o `proxy.ts` responde 401 ao Bearer antes do
  // handler — a mesma armadilha das irmãs acima. Âncoras `$` e id em FORMA DE
  // UUID: nenhum sub-path futuro nasce público de carona.
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/pause-ai$/i,
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/reactivate-bot$/i,
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/close$/i,
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/reopen$/i,
  // ENVIO SERVER-TO-SERVER. Mesma dualidade de `/api/v1/contacts` acima, com
  // `mcp:write` em vez de `mcp:read`: sessão de navegador OU Bearer `dsk_…`,
  // resolvidos por `lib/api/auth-dual.ts` DENTRO de cada rota, com a org saindo
  // da linha do token e nunca do corpo. Existem porque quem envia por aqui não
  // tem navegador: o gateway do CRM em absorção e integrações de servidor.
  //
  // Ancoradas com `$` de propósito. `/^\/api\/v1\/messages/` sem âncora daria
  // carona a `/api/v1/messages/[id]`, que NÃO tem suporte a Bearer.
  /^\/api\/v1\/messages$/,
  // ATUALIZAR LEAD SERVER-TO-SERVER. Mesma dualidade de `/api/v1/messages`
  // acima: sessão de navegador OU Bearer `dsk_…`, resolvidos por
  // `lib/api/auth-dual.ts` DENTRO da rota (`app/api/v1/leads/[id]/route.ts`).
  // Existe para a integração de monitoramento processual (n8n consultando
  // Escavador/Jusbrasil/Codilo/Judit), que não tem navegador.
  //
  // O segmento é uma FORMA DE UUID, nunca `[^/]+` — `/api/v1/leads/` tem
  // irmãos literais no mesmo nível (`bulk`, `at-risk`, `import`, `proposals`,
  // `reactivations`) que `[^/]+$` alcançaria por engano, tornando-os "públicos"
  // (proxy não decide) quando nenhum deles tem suporte a Bearer.
  /^\/api\/v1\/leads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // MARCAR/REMARCAR/CANCELAR COMPROMISSO SERVER-TO-SERVER. Mesma dualidade dos
  // dois de cima: sessão OU Bearer `dsk_…`, resolvidos por `lib/api/auth-dual.ts`
  // DENTRO da rota (`app/api/v1/agenda/agendamentos/route.ts`, função
  // `despachar`). `GET` (listar) segue só-sessão — este path cobre os quatro
  // verbos porque o proxy filtra por PATH, não por método; quem decide o
  // método é a própria rota, como sempre foi.
  /^\/api\/v1\/agenda\/agendamentos$/,
  // TAREFAS SERVER-TO-SERVER (issue #4516). Mesma dualidade das linhas acima:
  // sessão OU Bearer `dsk_…`, resolvidos por `lib/api/auth-dual.ts` DENTRO de
  // cada rota (`app/api/v1/tasks/route.ts` e `app/api/v1/tasks/[id]/route.ts`),
  // com a organização saindo da LINHA DO TOKEN e nunca do corpo. A listagem
  // cobra `tasks:read`, as escritas cobram `tasks:write` — escopos próprios, e
  // não `mcp:read`/`mcp:write`, porque quem emite o token decide se a
  // integração mexe na rotina da equipe.
  //
  // Sem estas duas linhas o proxy responde 401 ao Bearer ANTES do handler: ele
  // só reconhece cookie, e chamar o autenticador na rota não muda isso — o
  // `proxy.ts` roda primeiro. Foi o modo de falha medido em `/api/v1/contacts`
  // (/3417) e é a razão de a lista existir.
  //
  // Âncoras `$` de propósito: `/api/v1/tasks/` tem só o filho `[id]`, e um
  // padrão largo deixaria qualquer sub-path futuro nascer público de carona. O
  // segmento do id é FORMA DE UUID, nunca `[^/]+`.
  /^\/api\/v1\/tasks$/,
  /^\/api\/v1\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/api\/v1\/conversations\/open-with-contact$/,
  // CRIAÇÃO DE RASCUNHO SUGERIDO SERVER-TO-SERVER (issue #1611). Mesma
  // dualidade da linha acima: sessão OU Bearer `dsk_…` com escopo `mcp:write`,
  // resolvida por `lib/api/auth-dual.ts` DENTRO da rota
  // (`app/api/v1/conversations/[id]/drafts/route.ts`). O `GET`/leitura do
  // rascunho é da sessão do atendente (caixa de entrada) e NÃO entra aqui.
  //
  // O segmento do id passou a ser FORMA DE UUID (#4517): era `[^/]+`, largo, e
  // deixava `/conversations/abc/drafts` e qualquer id inventado entrarem por
  // carona. A porta legítima continua aberta — conversa tem id do Postgres.
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/drafts$/i,
  // Upload outbound: primeiro passo do envio de MÍDIA por token. Sem ele, o
  // cartão de fidelidade (a única das automações que não é texto) não teria
  // como sair depois do corte de gateway.
  /^\/api\/v1\/conversations\/[^/]+\/media$/,
  // CONSUMIR RASCUNHO SUGERIDO SERVER-TO-SERVER. Mesma dualidade da linha
  // acima: sessão OU Bearer `dsk_…` com escopo `mcp:write`, resolvidos por
  // `lib/api/auth-dual.ts` DENTRO da rota
  // (`app/api/v1/conversations/[id]/drafts/consume/route.ts`). O id é uma
  // FORMA DE UUID, nunca `[^/]+` — `conversations/abc/drafts/consume` não
  // entra aqui nem de carona.
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/drafts\/consume$/i,
  // ANEXO DA NOTA INTERNA SERVER-TO-SERVER. Mesma dualidade da rota irmã
  // `media`: sessão OU Bearer `dsk_…`, resolvidos por `lib/api/auth-dual.ts`
  // DENTRO da rota
  // (`app/api/v1/conversations/[id]/notes/media/route.ts`). O id é uma FORMA
  // DE UUID, nunca `[^/]+`.
  /^\/api\/v1\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/notes\/media$/i,
  // CONFIGURAÇÃO DE IA, FOLLOW-UP E AGENDA SERVER-TO-SERVER (issue #1875).
  // Mesma dualidade das linhas acima: sessão OU Bearer `dsk_…`, resolvidos por
  // `lib/api/auth-dual.ts` DENTRO de cada rota (a org sai da linha do token e
  // nunca do body). Quem automatiza a instalação (configuração como código) não
  // tem navegador — e sem estas entradas o proxy devolve 401 antes do handler,
  // tornando a dualidade inalcançável por token.
  //
  // Ancorados com `$` de propósito: `/^\/api\/v1\/ai\/followup-flows/` daria
  // carona a `/[id]`, `/publish`, `/duplicate`, `/rollback`, etc., que seguem
  // só-sessão (publicar e reverter continuam exigindo a tela). O segmento da
  // versão é uma FORMA DE UUID, nunca `[^/]+` — `/api/v1/ai/agents/` tem irmãos
  // literais (assignable, [id], etc.) que um padrão largo tornaria públicos.
  /^\/api\/v1\/ai\/followup-flows$/,
  /^\/api\/v1\/ai\/followup-flows\/from-model$/,
  /^\/api\/v1\/ai\/agents$/,
  /^\/api\/v1\/ai\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/versions$/i,
  /^\/api\/v1\/prospecting$/,
  /^\/api\/v1\/agenda\/tipos$/,
  // A configuração de serviços valida sessão/Bearer e papel na própria rota.
  // Só este endpoint: nenhum sub-path futuro herda a passagem pela borda.
  /^\/api\/v1\/agenda\/servicos$/,
  // ATUALIZAR FONTES DO SERVIÇO SERVER-TO-SERVER. Mesma dualidade das linhas
  // acima: sessão OU Bearer `dsk_…`, resolvidos por `lib/api/auth-dual.ts`
  // DENTRO da rota (`app/api/v1/agenda/servicos/atualizar/route.ts`). O
  // segmento `atualizar` é literal, então sem `$` um sub-path futuro
  // (`/atualizar/x`) entraria por engano — âncora de propósito.
  /^\/api\/v1\/agenda\/servicos\/atualizar$/,
  // VERSÃO, PUBLICAÇÃO E TESTE DO AGENTE SERVER-TO-SERVER (issue #2052).
  // Mesma dualidade das linhas acima: sessão OU Bearer `dsk_…`, resolvidos por
  // `lib/api/auth-dual.ts` DENTRO de cada rota (a org sai da linha do token e
  // nunca do path). O token precisa de `config:read`/`config:write` E de papel
  // admin (`tokenRole`), porque trocar o prompt em vigor, publicar versão e
  // pausar o agente é poder de administração — a sessão continua com o rank de
  // sempre. Escopo PRÓPRIO, não `mcp:*`: token já emitido não ganha este poder
  // na atualização sem ser criado de novo (decisão do mantenedor no PR #2194).
  //
  // Os dois segmentos são FORMA DE UUID, nunca `[^/]+`: `/api/v1/ai/agents/`
  // tem irmão literal (`assignable`) e um segmento solto daria carona a ele e a
  // qualquer outro sub-path que ainda é só-sessão. Âncora `$` em todos: nenhum
  // caminho futuro nasce público de carona.
  /^\/api\/v1\/ai\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/api\/v1\/ai\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/publish$/i,
  /^\/api\/v1\/ai\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/versions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/api\/v1\/ai\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/versions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/test$/i,
  // ROTEADORES DE IA SERVER-TO-SERVER. Sessão OU Bearer `dsk_…`, resolvidos
  // dentro dos handlers. Os segmentos dinâmicos aceitam somente forma de UUID
  // e todos os padrões são ancorados para nenhum irmão futuro entrar de carona.
  /^\/api\/v1\/ai\/routers$/,
  /^\/api\/v1\/ai\/routers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/api\/v1\/ai\/routers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/members$/i,
  /^\/api\/v1\/ai\/routers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/test$/i,
  // AS ROTAS DAS FATIAS R DA SPEC 33 (configuração, operação, leitura). Mesma
  // dualidade das linhas acima: sessão OU Bearer `dsk_…`, resolvidos por
  // `lib/api/auth-dual.ts` DENTRO de cada rota, com a organização saindo da
  // linha do token. Os modelos ficam em `lib/auth/portas-de-token/`, um arquivo
  // por fatia, no formato do caminho da pasta; `portaDeToken` monta cada um
  // ancorado nos dois lados e com o segmento dinâmico em forma de UUID.
  ...PORTAS_DE_TOKEN,
  /^\/_next\//,
  /^\/favicon\.ico$/,
  // O ícone da aba (`app/icon.tsx`), que o `<head>` de TODA página pede —
  // inclusive o do `/login`, antes de existir sessão. Precisa de entrada
  // própria porque o matcher do `proxy.ts:128` só dispensa caminho COM
  // extensão: `/favicon.ico` passa por ele, `/icon` não. Medido em produção
  // antes desta linha: `GET /icon` → 307 para `/login?next=%2Ficon`, enquanto
  // `/icon.png` (inexistente) devolvia 404 — a diferença é só a extensão.
  /^\/icon$/,
  // PNGs públicos do app instalado, só os tamanhos que o manifest e o iPhone
  // pedem, e somente com a marca da instalação.
  /^\/app-icon\/(180|192|512|maskable)$/,
  /^\/manifest\.webmanifest$/,
  /^\/team\/accept-invite\/.+$/,
  // OS MOLDES DE E-MAIL DO GoTrue. Quem busca é o GoTrue, um processo de
  // terceiro que não tem — nem pode ter — sessão nossa. O conteúdo é HTML com
  // placeholders Go (`{{ .TokenHash }}`) mais nome, cor e logo da instalação,
  // que já aparecem na tela de login sem sessão. Sem esta linha o `proxy`
  // devolve 307 para `/login` e o GoTrue manda a TELA DE LOGIN dentro do
  // e-mail — o modo de falha exato que esta rota existe para acabar.
  //
  // Âncorado nos dois nomes: `/^\/email-templates\//` deixaria qualquer
  // sub-path futuro nascer público de carona.
  /^\/email-templates\/(confirmation|recovery)$/,
  // Documentos legais. O checkbox obrigatório de `/onboarding/welcome` linka os
  // dois, e o aceite acontece antes de a pessoa ter qualquer coisa no sistema —
  // exigir sessão para LER o que se está aceitando inverte a ordem. Âncorado nos
  // dois nomes de propósito: `/^\/legal/` deixaria qualquer sub-path futuro
  // nascer público de carona.
  /^\/legal\/(terms|privacy)$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(pathname));
}

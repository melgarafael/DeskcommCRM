/**
 * A janela do chat no site (spec 36, F2): o HTML que `GET /chat/<chave>` devolve.
 *
 * Função PURA: não lê banco, não lê env. Quem reúne os dados é a rota. Daqui saem duas
 * coisas: o HTML, e a política de conteúdo (CSP) que a própria resposta carrega. A CSP traz
 * `frame-ancestors` com as origens da conexão: é isso que decide quem pode embutir a janela,
 * no lugar do `X-Frame-Options: DENY` do painel.
 *
 * O comportamento da conversa (enviar, receber, aceite) fica no arquivo
 * `/webchat-janela.js`. Aqui só há a estrutura e os dados que esse script lê.
 *
 * Todo texto que vem do banco passa por `escaparHtml`. A configuração vai em
 * `<script type="application/json">`, com `<`, `>` e `&` escapados, para que nenhum valor
 * feche a tag.
 */
import { melhorFrenteSobre } from "@/lib/branding/contraste";
import type { MarcaDeSaida } from "@/lib/branding/saida";

import { TEXTO_DO_AVISO_VERSAO, type ConfiguracaoDoChat } from "./config";

export interface EntradaDaJanela {
  chave: string;
  marca: MarcaDeSaida;
  config: ConfiguracaoDoChat;
  controlador: { razaoSocial: string | null; politicaUrl: string | null };
  origens: string[];
}

export interface JanelaMontada {
  html: string;
  csp: string;
}

/** Mesma forma de `config.ts`: https com host e porta opcional, ou loopback em http. */
const ORIGEM_HTTPS =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/i;
const ORIGEM_LOCALHOST = /^http:\/\/localhost(:[0-9]{1,5})?$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;
const POLITICA_HTTP = /^https?:\/\/\S+$/i;
const LOGO_SEGURO = /^(https:\/\/\S+|\/(?!\/)\S*)$/;

/**
 * As origens que são de fato origens. Descarta tudo que não bate a forma: caminho, espaço,
 * `;` (que abriria outra diretiva da CSP), esquema que não seja https ou loopback. Mantém a
 * ordem e tira duplicatas.
 */
export function origensValidas(origens: readonly string[]): string[] {
  const vistas = new Set<string>();
  for (const origem of origens) {
    if (typeof origem !== "string") continue;
    if (ORIGEM_HTTPS.test(origem) || ORIGEM_LOCALHOST.test(origem)) vistas.add(origem);
  }
  return [...vistas];
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** JSON que não consegue fechar uma tag `<script>`: `<`, `>` e `&` viram escapes Unicode. */
function jsonSeguro(valor: unknown): string {
  return JSON.stringify(valor)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function politicaProvedora(url: string | null): string | null {
  return url !== null && POLITICA_HTTP.test(url) ? url : null;
}

function montarCsp(origens: string[]): string {
  const ancestrais = origens.length > 0 ? origens.join(" ") : "'none'";
  return [
    `frame-ancestors ${ancestrais}`,
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
  ].join("; ");
}

const ESTILO = `
html, body { margin: 0; height: 100%; background: #fff; color: #1f2937;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
#webchat-app { display: flex; flex-direction: column; height: 100%; }
.cabecalho { display: flex; align-items: center; gap: .6rem; padding: .7rem .9rem;
  background: var(--cor); color: var(--cor-texto); }
.cabecalho .logo { height: 28px; width: auto; }
.cabecalho .marca { display: flex; flex-direction: column; line-height: 1.2; }
.cabecalho .marca span { font-size: .85rem; opacity: .9; }
.mensagens { flex: 1; overflow-y: auto; padding: .8rem; display: flex; flex-direction: column; gap: .5rem; }
.rodape { border-top: 1px solid #e5e7eb; padding: .6rem .8rem; }
.aviso { margin: 0 0 .5rem; font-size: .75rem; color: #4b5563; }
.aviso a { color: inherit; }
.entrada { display: flex; gap: .5rem; }
.entrada textarea { flex: 1; min-width: 0; padding: .55rem .7rem; border: 1px solid #d1d5db;
  border-radius: 8px; font: inherit; resize: none; }
.entrada button { padding: .55rem .9rem; border: 0; border-radius: 8px; background: var(--cor);
  color: var(--cor-texto); font: inherit; cursor: pointer; }
`;

/** Monta a janela. `csp` vai no cabeçalho da resposta; `html` é o corpo. */
export function montarJanela(entrada: EntradaDaJanela): JanelaMontada {
  const { chave, marca, config, controlador } = entrada;
  const origens = origensValidas(entrada.origens);

  const titulo = config.titulo ?? marca.nome;
  // A cor da configuração do chat sobrepõe a da marca quando é um hex válido. Sem ela, vale a
  // marca. Com cor da configuração, o texto sobre o botão é calculado (contraste); sem ela, é o
  // `accentFg` da marca, que já vem calculado.
  const corDaConfig = config.cor !== undefined && HEX.test(config.cor) ? config.cor : null;
  const cor = corDaConfig ?? (HEX.test(marca.accent) ? marca.accent : "#000000");
  const corTexto =
    corDaConfig !== null
      ? melhorFrenteSobre(corDaConfig)
      : HEX.test(marca.accentFg)
        ? marca.accentFg
        : "#ffffff";
  const politica = politicaProvedora(controlador.politicaUrl);
  const nomeDoControlador = controlador.razaoSocial ?? marca.nome;

  const logo =
    marca.logoUrl !== null && LOGO_SEGURO.test(marca.logoUrl)
      ? `<img class="logo" src="${escaparHtml(marca.logoUrl)}" alt="">`
      : "";

  const linkDaPolitica = politica
    ? ` <a href="${escaparHtml(politica)}" target="_blank" rel="noopener noreferrer">Política de privacidade</a>`
    : "";
  const aviso =
    `Ao enviar a primeira mensagem, você concorda com o tratamento dos seus dados por ` +
    `<strong>${escaparHtml(nomeDoControlador)}</strong>.${linkDaPolitica}`;

  // A configuração que o script da janela lê. Campo de coleta ausente vale `opcional`, como na F1.
  const dados = {
    chave,
    titulo,
    saudacao: config.saudacao ?? null,
    cor,
    coleta: {
      nome: config.coleta?.nome ?? "opcional",
      telefone: config.coleta?.telefone ?? "opcional",
      email: config.coleta?.email ?? "opcional",
    },
    versaoDoAviso: TEXTO_DO_AVISO_VERSAO,
    controlador: { razaoSocial: controlador.razaoSocial, politicaUrl: politica },
    // Ajustes da janela (Tarefa 10a): valores com padrao quando ausentes.
    avatar: config.avatar_url || null,
    autoAbrirSegundos: config.auto_abrir_segundos ?? 0,
    som: config.som ?? false,
    respostasRapidas: config.respostas_rapidas ?? [],
  };

  const html = `<!doctype html>
<html lang="pt-BR" style="--cor: ${cor}; --cor-texto: ${corTexto}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escaparHtml(titulo)}</title>
<style>${ESTILO}</style>
</head>
<body>
<div id="webchat-app">
<header class="cabecalho">
${logo}
<div class="marca"><strong>${escaparHtml(marca.nome)}</strong><span>${escaparHtml(titulo)}</span></div>
</header>
<main id="webchat-mensagens" class="mensagens" aria-live="polite"></main>
<footer class="rodape">
<p class="aviso">${aviso}</p>
<form id="webchat-form" class="entrada">
<textarea id="webchat-texto" rows="1" maxlength="2000" autocomplete="off" placeholder="Digite sua mensagem" aria-label="Mensagem"></textarea>
<button id="webchat-enviar" type="submit">Enviar</button>
</form>
</footer>
</div>
<script type="application/json" id="webchat-config">${jsonSeguro(dados)}</script>
<script src="/webchat-janela.js" defer></script>
</body>
</html>
`;

  return { html, csp: montarCsp(origens) };
}

/**
 * A página que `GET /chat/<chave>` devolve quando a janela não abre (chave que não existe, conexão
 * arquivada, organização suspensa, módulo desligado, chat pausado, limite de aberturas ou erro).
 * É HTML, e não o JSON de erro da API: o visitante vê isto dentro do quadro. Sem dado de nenhuma
 * organização e sem diferença entre os casos, para a janela não dizer por que não abriu.
 */
export const PAGINA_INDISPONIVEL =
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat indisponível</title>' +
  "<style>body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:24px;color:#444;text-align:center}</style>" +
  "</head><body><p>Chat indisponível.</p></body></html>";

import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, IBM_Plex_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import { coresDaBarraDoNavegador } from "@/lib/branding/barra-do-navegador";
import { MarcaDaInstalacaoProvider } from "@/lib/branding/contexto";
import { cssDaMarca } from "@/lib/branding/css";
import {
  marcaDaInstalacao,
  motivoDoFallback,
  registrarEstadoDaMarca,
  type LinhaDaMarca,
} from "@/lib/branding/instalacao";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import {
  camadaDaInstalacao,
  camadaDoAmbiente,
  resolverMarca,
  type MarcaResolvida,
} from "@/lib/branding/resolve";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ThemeProvider } from "@/lib/theme";
import { Providers } from "./providers";
import { PublicEnvScript } from "./public-env-script";
import "./globals.css";

const atkinson = Atkinson_Hyperlegible({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-atkinson",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

/**
 * A pilha de camadas da marca da instalação: BANCO acima, `.env` embaixo.
 *
 * Uma função só porque `generateMetadata`, `EstiloDaMarca` e `MarcaNoNavegador`
 * precisam da MESMA resolução — montagens separadas da pilha divergiriam, e a
 * divergência apareceria como título da aba com uma marca, cor com outra e barra
 * lateral com uma terceira.
 *
 * A leitura do banco é memoizada em `lib/branding/instalacao.ts`, então as três
 * chamadas por requisição custam UMA consulta a cada TTL.
 */
async function marcaResolvida(): Promise<{
  /** A linha crua — só `EstiloDaMarca` precisa dela, para gravar o estado. */
  readonly linha: LinhaDaMarca | null;
  readonly marca: MarcaResolvida;
}> {
  const linha = await marcaDaInstalacao();
  const marca = resolverMarca(
    [camadaDaInstalacao(linha), camadaDoAmbiente(env)],
    REGUA_DO_PRODUTO,
  );
  return { linha, marca };
}

/**
 * Metadata dinâmica (não `export const metadata`) para a marca ser lida em RUNTIME.
 * Constante seria resolvida durante o `next build`, e a imagem self-host — que é
 * pré-buildada — carregaria a nossa marca para sempre. Ver `lib/branding.ts`.
 *
 * O `template` é o que faz a marca existir em UM lugar só: as páginas filhas
 * declaram apenas o próprio nome ("Entrar") e herdam o sufixo daqui.
 *
 * Passou a ler o BANCO (era `branding()`, só `.env`) porque senão `app_name` na
 * tabela seria coluna decorativa nesta fase: o operador trocaria o nome, a
 * gravação daria certo e a aba continuaria com o nome antigo. Os demais call
 * sites de `lib/branding` seguem no `.env` — está declarado no handoff, com o
 * motivo medido.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { marca } = await marcaResolvida();
  const { name } = marca;
  return {
    title: {
      default: `${name} — atendimento e vendas por WhatsApp com agentes de IA`,
      template: `%s · ${name}`,
    },
    description:
      "Centralize o atendimento por WhatsApp num funil só. Agentes de IA resolvem o que dá para resolver e passam à equipa humana o que importa — com tudo registado. Multi-tenant, com proteção de dados nativa, feito para operações moçambicanas.",
    applicationName: name,
    authors: [{ name }],
    keywords: [
      "CRM",
      "atendimento",
      "WhatsApp",
      "IA conversacional",
      "proteção de dados",
      "multi-tenant",
    ],
    robots: { index: false, follow: false },
    // Sem esta linha o navegador pede `/favicon.ico`, que não existe: medido em
    // produção, o 404 é a `app/not-found.tsx` INTEIRA (19.435 bytes de HTML)
    // servida para um pedido de ícone, em toda navegação sem cache. Declarar
    // `/icon` faz o pedido ir para `app/icon.tsx`, que desenha a marca da
    // instalação em runtime — ver o cabeçalho daquele arquivo para por que ele
    // não pode ser um arquivo estático em `public/`.
    icons: { icon: "/icon" },
  };
}

/**
 * A cor da barra do navegador sai da RÉGUA, não de dois hexes redigitados aqui.
 * O porquê — inclusive por que isto NÃO deve virar `generateViewport()` lendo o
 * banco — está no cabeçalho de `lib/branding/barra-do-navegador.ts`.
 */
export const viewport: Viewport = {
  themeColor: coresDaBarraDoNavegador(REGUA_DO_PRODUTO),
};

// Inline FOUC-prevention. Conteúdo é string literal estática (zero input do usuário),
// portanto seguro. Lê localStorage + prefers-color-scheme antes do primeiro paint.
const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem('deskcomm-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;var r=(s==='dark'||s==='light')?s:((s==='system'||!s)&&d?'dark':'light');document.documentElement.setAttribute('data-theme',r);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

/**
 * Motivos já registrados neste processo. `EstiloDaMarca` roda em TODA
 * requisição e os motivos são os mesmos até alguém mudar o `.env` — repetir o
 * aviso a cada render seria ruído, e ruído é como um log deixa de ser lido.
 */
const motivosRegistrados = new Set<string>();

/**
 * A cor da instalação, injetada como CSS no `<head>`.
 *
 * É HTML no primeiro byte — antes do CSS e antes do `THEME_INIT_SCRIPT` — então
 * não há flash: o navegador nunca chega a pintar a cor do produto para depois
 * trocar. Server Component de propósito: a leitura é do BANCO e do `.env` em
 * runtime (a imagem self-host é pré-buildada; ver `lib/branding.ts`), e enviar
 * isso pelo cliente reintroduziria justamente o flash. Desde a migration 0155 a
 * fonte primária é `platform_branding`; o `.env` continua embaixo como semente —
 * e, para NOME e LOGO, como rede de rollback (ver `lib/branding/instalacao.ts`).
 * Para COR não existe rede: `APP_ACCENT_HEX` nasceu no mesmo épico que a tabela,
 * então nenhuma versão velha o bastante para desconhecê-la pinta accent.
 *
 * ⚠️ A segunda metade desta frase mudou em 2026-08-14 e o comentário foi
 * atualizado junto: o `install.sh` **passou a perguntar e gravar** a chave
 * (campo em `FIELDS`, validador `v_hex`, `envq` no bloco do `.env`). Antes disso
 * ele não a gravava — medido na época: 0 ocorrências contra 7 de `APP_NAME` —,
 * e a semente da cor só existia se alguém a escrevesse à mão. A ausência de rede
 * de rollback continua valendo pela razão de cima, que é sobre VERSÃO, não sobre
 * o instalador. A correção da prosa está no cabeçalho da migration 0155.
 *
 * Os motivos NÃO morrem aqui, e desde 2026-08-13 eles têm DUAS telas:
 * `/admin/marca` (instalação) e `/app/settings/marca` (organização) mostram os
 * motivos e o `fallback_at` — é `_estado.tsx` quem os renderiza. O log
 * estruturado continua sendo o caminho de quem lê servidor, não o único.
 *
 * ⚠️ Este parágrafo dizia "enquanto a tela de marca não existe (fase seguinte,
 * `/app/settings/tenant/branding`)". Era falso em dois pontos: as telas existem,
 * e aquela rota NUNCA existiu. Ele sobreviveu a uma varredura de comentários
 * falsos que corrigiu o parágrafo seis linhas acima, no MESMO docblock — a
 * varredura entrou pelo bloco e parou no parágrafo. Varrer por classe é varrer o
 * bloco inteiro, não a frase que se veio consertar.
 */
async function EstiloDaMarca() {
  // `await headers()` força render dinâmico, pelo mesmo motivo do
  // `<PublicEnvScript/>`: numa imagem pré-buildada, um render ESTÁTICO
  // congelaria o valor lido durante o `next build` — que é vazio — e a cor do
  // revendedor nunca apareceria. Hoje o layout já é dinâmico por causa do
  // vizinho; declarar aqui torna a garantia local, em vez de depender de um
  // componente que alguém pode mover.
  await headers();
  const { linha, marca } = await marcaResolvida();
  const { css, motivos } = cssDaMarca(marca.cor);

  // O ESTADO da recusa vai para o banco, não só para o log. Sem isto, o degrade
  // ("o produto ficou com a cor dele") é indistinguível de "a feature nunca foi
  // instalada", e o operador conclui que o campo de cor não funciona.
  //
  // Sem `await`: gravar diagnóstico não pode atrasar — nem derrubar — a página
  // que o diagnóstico descreve. `registrarEstadoDaMarca` já não lança.
  void registrarEstadoDaMarca(linha, motivoDoFallback([...marca.motivos, ...motivos]));

  const avisos = [
    ...marca.motivos.map((m) => ({
      codigo: m.codigo,
      origem: m.origem,
      tema: m.tema,
      alvo: m.alvo,
      detalhe: m.detalhe,
    })),
    ...motivos.map((m) => ({
      codigo: m.codigo,
      origem: "css",
      tema: null,
      alvo: m.alvo,
      detalhe: m.detalhe,
    })),
  ];
  for (const aviso of avisos) {
    const chave = `${aviso.codigo}|${aviso.tema ?? ""}|${aviso.alvo ?? ""}`;
    if (motivosRegistrados.has(chave)) continue;
    motivosRegistrados.add(chave);
    logger.warn("marca da instalação: a cor configurada não foi aplicada como está", aviso);
  }

  // `null` sem motivo é o caso de fábrica (nenhuma cor configurada): não há o
  // que injetar, e o produto fica com a cor dele.
  if (!css) return null;
  // Conteúdo derivado do `.env` do servidor e já passado pela allowlist de forma
  // de `lib/branding/css.ts`, que recusa `<` e devolve `null` em vez de string
  // parcial. Mesmo contrato do `THEME_INIT_SCRIPT` acima.
  //
  // O `id` é o que torna este bloco IDENTIFICÁVEL na tela: sem ele, achá-lo no
  // `<head>` só dá por varredura de todos os `<style>` procurando um `--color-`
  // no texto (foi como a prova em tela deste marco teve de fazer), e distinguir
  // o bloco da INSTALAÇÃO do bloco da ORGANIZAÇÃO — que a fase seguinte injeta —
  // seria impossível. Vale para diagnóstico, para spec de e2e e para o suporte.
  return <style id="marca-instalacao" dangerouslySetInnerHTML={{ __html: css }} />;
}

/**
 * A marca que atravessa para o NAVEGADOR — a MESMA pilha da aba e do CSS.
 *
 * Componente próprio, e não uma chamada dentro do `RootLayout`, pelo mesmo
 * motivo de `EstiloDaMarca`: só este nó do `<head>` espera o banco, e o resto do
 * documento não passa a depender de uma consulta que a marca já memoiza.
 *
 * Antes desta onda, `<PublicEnvScript/>` lia `env.APP_NAME`/`env.APP_LOGO_URL`
 * — o arquivo de instalação cru. Era por aqui que a marca GRAVADA parava de
 * chegar aos client components: o título da aba lia o banco e a barra lateral
 * lia o `.env`, e `platform_branding.logo_url` não tinha leitor nenhum. Ver o
 * cabeçalho de `app/public-env-script.tsx`.
 */
async function MarcaNoNavegador() {
  const { marca } = await marcaResolvida();
  return <PublicEnvScript marca={{ name: marca.name, logoUrl: marca.logoUrl }} />;
}

/**
 * A marca que os CLIENT COMPONENTS leem — a MESMA pilha, entregue por prop.
 *
 * ⚠️ Esta é a peça que impede o hydration mismatch, e o motivo é assimétrico:
 * `<PublicEnvScript/>` acima entrega a marca ao NAVEGADOR, e o navegador só a
 * tem depois que o script roda. O SSR de um `"use client"` acontece ANTES disso,
 * no servidor, onde `branding()` lê `process.env` — o `.env`, sem o banco. Numa
 * instalação com logo gravado pela tela e `APP_LOGO_URL` vazio, o servidor
 * renderizava `<span>` com o nome e o cliente hidratava `<img>` com o logo:
 * troca de TIPO de elemento, que é React #418 em toda tela.
 *
 * Passar o valor por prop resolve pela origem, não pela coincidência: o que o
 * servidor renderiza e o que o cliente hidrata é literalmente o mesmo objeto,
 * serializado no payload do RSC. Mesma rota que `user`/`activeOrg` já fazem em
 * `hooks/auth/AuthProvider.tsx`.
 *
 * Custa ZERO consulta a mais: `marcaResolvida()` chama `marcaDaInstalacao()`,
 * memoizada por TTL no módulo, e `<EstiloDaMarca/>` no `<head>` já espera a
 * mesma resposta antes de o documento ser liberado.
 */
async function MarcaDosClientComponents({ children }: { children: React.ReactNode }) {
  const { marca } = await marcaResolvida();
  // Só os três campos de `Branding`: `marca` carrega junto `cor`, `origens` e
  // `motivos`, que são diagnóstico do servidor e não têm leitor no navegador —
  // mandá-los engordaria o payload do RSC de TODA página com dado que ninguém lê.
  return (
    <MarcaDaInstalacaoProvider
      marca={{ name: marca.name, logoUrl: marca.logoUrl, initial: marca.initial }}
    >
      {children}
    </MarcaDaInstalacaoProvider>
  );
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="pt-BR"
      data-theme="light"
      suppressHydrationWarning
      className={`${atkinson.variable} ${plexMono.variable}`}
    >
      <head>
        {/* Primeiro de tudo: a cor da instalação, antes do CSS e do script de tema. */}
        <EstiloDaMarca />
        {/* Config pública do Supabase + marca resolvida, em runtime (imagem
            genérica self-host). */}
        <MarcaNoNavegador />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-bg font-sans text-text antialiased">
        <Providers>
          <MarcaDosClientComponents>
            <ThemeProvider>{children}</ThemeProvider>
          </MarcaDosClientComponents>
          <Toaster
            position="top-right"
            richColors
            closeButton
            duration={4000}
          />
        </Providers>
      </body>
    </html>
  );
}

import { LogotipoDoProduto } from "@/components/branding/MarcaDoProduto";
import { ADVOMAX_LOGO_URL, marcaEhADoProduto } from "@/lib/branding";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createClient } from "@/lib/supabase/server";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

/**
 * A casca das telas de acesso — login, cadastro, recuperação, MFA.
 *
 * ── Por que o LOGO mora aqui, e não em `login/page.tsx` ───────────────────────
 *
 * São seis telas no grupo `(public)`, e todas são "antes de entrar": quem instala
 * o produto para clientes mostra a marca dele exatamente aí. Um `<img>` por
 * página seriam seis cópias que divergem na primeira vez que alguém mexer numa
 * só — e a que ficaria para trás é sempre a que ninguém abre (recuperação de
 * senha, cadastro de MFA), que é justamente onde o cliente do revendedor
 * aparece sozinho e sem contexto.
 *
 * ── Por que `marcaDaSaida(null)` ──────────────────────────────────────────────
 *
 * Aqui não existe organização resolvida: `null` é a declaração disso, e a pilha
 * resultante é a mesma do layout raiz (banco acima, `.env` embaixo). Montar a
 * pilha à mão nesta tela faria a fachada anunciar uma precedência que o resto do
 * produto não usa. E `marcaDaSaida` NUNCA lança (ver o cabeçalho dela): uma cor
 * ou um logo mal gravados não podem derrubar a única tela por onde se entra para
 * corrigi-los.
 *
 * Sem logo configurado E com o nome padrão, a fachada mostra o logotipo do
 * PRODUTO (`components/branding/MarcaDoProduto.tsx`) — inline, sem `<img>`,
 * para que `tests/e2e/marca-logo.spec.ts` continue medindo "a fachada está sem
 * `<img>`" como "sem logo do revendedor".
 *
 * O NOME continua saindo de `branding()` dentro de cada página — não é descuido,
 * está medido em `tests/e2e/icone-da-marca.spec.ts:64-77`: aquela spec cruza duas
 * resoluções independentes (o título da aba, que lê o banco, contra o texto sob
 * o "Entrar", que lê o `.env`). Trocar o texto para este mesmo resolvedor
 * deixaria a spec verde medindo nada.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const marca = await marcaDaSaida(null);
  // A maioria destas telas roda ANTES do login (não há usuário nenhum), mas
  // duas — `/login/mfa` e, em parte, `/login/recovery` — rodam com uma sessão
  // parcial já criada (primeiro fator verificado, segundo pendente). Onde há
  // sessão, o idioma salvo no perfil vale; sem ela, `IdiomaProvider` já cai no
  // padrão pt-BR sozinho (ver o cabeçalho do provider) — nunca lança.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const locale = (user?.user_metadata?.locale as string | undefined) ?? null;

  return (
    <IdiomaProvider locale={locale}>
      <main className="grid min-h-[100dvh] gap-[18px] bg-[#f7f9fc] p-[18px] lg:grid-cols-[minmax(0,1.08fr)_minmax(420px,.92fr)]">
        <section className="relative hidden min-h-[calc(100dvh-36px)] flex-col justify-between overflow-hidden rounded-[28px] bg-[#071b33] p-[clamp(36px,5vw,72px)] text-[#e8eef5] shadow-[0_24px_60px_rgba(7,27,51,.18)] lg:flex">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_18%,rgba(81,119,160,.28),transparent_32%),linear-gradient(145deg,#102a4b_0%,#071b33_55%,#041426_100%)]" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/advomax-logo.svg"
            alt="Advomax"
            className="relative h-auto w-[270px] brightness-0 invert"
          />
          <div className="relative max-w-[680px]">
            <p className="mb-[22px] text-[11px] font-bold tracking-[.22em] text-[#c8d5e4] uppercase">
              CRM jurídico integrado
            </p>
            <h1 className="text-[clamp(42px,5vw,72px)] leading-[1.03] font-bold tracking-[-.045em] text-[#f8fafc]">
              Relacionamentos que viram resultados para o escritório.
            </h1>
            <p className="mt-[26px] max-w-[620px] text-base leading-[1.7] text-[#c8d5e4]">
              Atendimento, WhatsApp, oportunidades e documentos conectados às pessoas e aos processos do Advomax.
            </p>
          </div>
          <div className="relative grid grid-cols-3 gap-5 border-t border-white/15 pt-6 text-[13px] leading-6 text-[#dbe5f0]">
            <p><strong className="block text-base text-white">Atendimento único</strong>Conversas e histórico no mesmo fluxo.</p>
            <p><strong className="block text-base text-white">Contexto jurídico</strong>Pessoas, clientes e processos conectados.</p>
            <p><strong className="block text-base text-white">Acesso seguro</strong>A mesma identidade usada no Advomax.</p>
          </div>
        </section>

        <section className="grid min-h-[calc(100dvh-36px)] place-items-center rounded-[28px] border border-[#e4e9f0] bg-[#fdfefe] px-6 py-12 lg:px-12">
          <div className="w-full max-w-[420px] space-y-8">
          {marca.logoUrl ? (
            <div>
              {/*
                <img> em vez de next/image pelo mesmo motivo da barra lateral: a URL
                é de quem hospeda e o `next/image` exige allowlist de domínios
                fechada em BUILD — a imagem pré-buildada do self-host recusaria o
                domínio do operador. Altura fixa e largura livre para não distorcer
                arte de proporção desconhecida.

                O `alt` é o nome DESTA resolução (`marca.nome`), e não o de
                `branding()`: é a legenda da imagem que está ali, e nomeá-la com a
                marca de outra fonte descreveria uma marca que não é a do logo.

                O `data-testid` é lido por `tests/e2e/marca-logo.spec.ts`, que prova
                que o logo da EMPRESA não vaza para cá. Sem ele a spec caía na
                "primeira <img> da página", e uma asserção de negação com seletor
                largo passa sozinha assim que outra imagem entra na tela.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                data-testid="logo-da-fachada"
                src={marca.logoUrl}
                alt={marca.nome}
                className={`h-auto w-[236px] max-w-full object-contain ${marca.logoUrl === ADVOMAX_LOGO_URL ? "advomax-product-logo" : ""}`}
              />
            </div>
          ) : marcaEhADoProduto({ name: marca.nome, logoUrl: null }) ? (
            <div>
              <LogotipoDoProduto nome={marca.nome} className="h-12 w-auto" />
            </div>
          ) : null}
          {children}
          </div>
        </section>
      </main>
    </IdiomaProvider>
  );
}

import Link from "next/link";

import { LoginForm } from "@/components/auth/LoginForm";
import { LogoDaFachada } from "@/components/auth/LogoDaFachada";
import { RedeAnimada } from "@/components/auth/RedeAnimada";
import { branding } from "@/lib/branding";
import { createClient } from "@/lib/supabase/server";
import { normalizarIdioma } from "@/lib/i18n/idiomas";
import { traduzir } from "@/lib/i18n/dicionario";

export const metadata = { title: "Entrar" };

/**
 * ⚠️ CONTEÚDO DE VITRINE — NÚMEROS E DEPOIMENTO SÃO DA MAQUETE, NÃO DO PRODUTO.
 *
 * Os três indicadores e o depoimento abaixo vieram do arquivo de referência do
 * desenho. Eles NÃO saem de lugar nenhum do banco: são texto fixo, escrito para
 * a maquete parecer viva. Um deles inclusive nomeia uma pessoa e uma empresa
 * ("Marina Reis · Clínica Vitta") que, até onde este código sabe, não são
 * clientes reais — publicar isso em produção é um depoimento inventado na
 * primeira tela do produto.
 *
 * DESLIGADOS por decisão do produto: não há números reais nem depoimento real
 * ainda, e mostrar dado inventado engana quem chega. O JSX ficou no lugar de
 * propósito — quando houver conteúdo de verdade, ligar é trocar `false` por
 * `true` aqui, sem redesenhar o painel. O tipo é `boolean` explícito (e não a
 * inferência `false`) para que o bloco continue sendo código que o TypeScript
 * checa, em vez de virar ramo morto que só quebra no dia em que for religado.
 *
 * Ao religar, os textos abaixo precisam ser trocados junto: os números são da
 * maquete e o depoimento nomeia uma pessoa e uma empresa que este código não
 * sabe se são clientes.
 */
const MOSTRAR_INDICADORES: boolean = false;
const MOSTRAR_DEPOIMENTO: boolean = false;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string; error?: string }>;
}) {
  const { next, reset, error } = await searchParams;
  // Fora da árvore de `app/app/layout.tsx` — sem `IdiomaProvider` do lado do
  // servidor (o cliente já tem o seu, montado em `app/(public)/layout.tsx`).
  // Quase nunca há sessão aqui (é a própria tela de entrar), mas resolve do
  // mesmo jeito por segurança — `user` opcional.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const idioma = normalizarIdioma(
    (user?.user_metadata?.locale as string | undefined) ?? null,
  );
  const t = (texto: string) => traduzir(texto, idioma);
  const nome = branding().name;

  /*
    Os avisos de erro/sucesso que chegam por querystring. Eram cinco blocos
    soltos no meio do JSX antes do redesenho; viraram uma lista porque agora
    moram dentro da coluna do formulário, e cinco `{cond && <div>}` empilhados
    ali dentro escondiam a estrutura da coluna inteira.

    O texto e a condição de cada um são os mesmos de antes — nenhum diagnóstico
    foi fundido nem removido: eles chegaram por frentes diferentes e falam de
    erros diferentes, e ficar com um só apagaria um diagnóstico inteiro da tela.
  */
  const avisos: { chave: string; tom: "ok" | "erro"; texto: React.ReactNode }[] = [];
  if (reset === "success") {
    avisos.push({
      chave: "reset",
      tom: "ok",
      texto: t("Senha redefinida com sucesso. Entre com a nova senha."),
    });
  }
  if (error === "link_invalido") {
    avisos.push({
      chave: "link_invalido",
      tom: "erro",
      texto: t(
        "Link inválido ou expirado. Peça um novo em Recuperar senha ou refaça o cadastro.",
      ),
    });
  }
  if (error === "convite_invalido") {
    avisos.push({
      chave: "convite_invalido",
      tom: "erro",
      texto: t(
        "Sua conta foi confirmada, mas o convite não vale mais — ele expirou ou foi emitido para outro e-mail. Peça um novo a quem te convidou. Não criamos uma empresa nova para você, porque não era isso que você estava fazendo.",
      ),
    });
  }
  if (error === "template_padrao") {
    avisos.push({
      chave: "template_padrao",
      tom: "erro",
      texto: (
        <>
          {t(
            "Este link veio do modelo de e-mail padrão do Supabase, que não fecha o acesso nesta instalação — pedir outro link não resolve. Quem administra o sistema precisa configurar os e-mails de acesso (",
          )}
          <code>marca-emails.sh</code>
          {t(", no kit de instalação).")}
        </>
      ),
    });
  }
  if (error === "provisionamento") {
    avisos.push({
      chave: "provisionamento",
      tom: "erro",
      texto: t(
        "Sua conta foi confirmada, mas houve um erro ao preparar seu ambiente. Tente entrar novamente em instantes.",
      ),
    });
  }

  return (
    <div className="grid min-h-screen grid-cols-1 bg-bg font-fachada lg:grid-cols-[1.08fr_1fr]">
      {/*
        O PAINEL DA MARCA.

        Ele NÃO some no celular — encolhe para uma faixa com logo e nome. Some
        seria tentador (a maquete é de desktop), mas o `<img>` do logo é o que
        `tests/e2e/marca-logo.spec.ts` procura em `/login`, e `display:none` num
        `getByTestId` deixa a spec medindo uma imagem que ninguém vê. Mais
        importante que a spec: no celular a fachada do revendedor sumiria
        exatamente onde a maioria das pessoas abre o link.
      */}
      <section className="relative flex flex-col justify-between overflow-hidden bg-[#081736] px-6 py-6 lg:min-h-[640px] lg:px-14 lg:py-11">
        <RedeAnimada />
        {/* Brilho quente no canto e a cunha embaixo — textura, não informação. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-[140px] -top-20 h-[520px] w-[520px]"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, rgba(59,111,212,0.28), rgba(8,23,54,0) 68%)",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-40 -left-[90px] hidden h-0 w-0 lg:block"
          style={{
            borderLeft: "300px solid transparent",
            borderBottom: "340px solid rgba(59,111,212,0.10)",
          }}
        />

        <header className="relative flex items-center gap-3">
          <LogoDaFachada className="h-[34px] w-auto max-w-[12rem] object-contain" />
          {/*
            O nome vem de `branding()` e é o texto EXATO que
            `tests/e2e/icone-da-marca.spec.ts:64-77` cruza com a marca do título
            da aba. `uppercase` é CSS: o nó de texto continua sendo o nome como
            foi gravado, então a spec segue casando com `exact: true`.
          */}
          <span className="font-display text-[17px] font-extrabold uppercase tracking-[0.16em] text-text">
            {nome}
          </span>
        </header>

        {/*
          `flex-1` + `justify-center` em vez de deixar o `justify-between` do
          <section> distribuir: com o depoimento desligado, a coluna passa a ter
          só DOIS filhos (cabeçalho e este bloco), e o `justify-between` jogava o
          texto todo para o rodapé com um vazio do tamanho da tela por cima.
          Assim este bloco absorve a folga e se centra dentro dela — fica no lugar
          com o depoimento ligado ou desligado, que é a condição de as duas chaves
          lá em cima serem de fato reversíveis.
        */}
        <div className="relative hidden max-w-[560px] flex-col justify-center gap-[34px] py-12 lg:flex lg:flex-1">
          <span className="self-start border border-accent/55 px-3.5 py-[7px] text-[11px] font-semibold uppercase tracking-[0.14em] text-[#9BB8EE]">
            {t("Plataforma de atendimento")}
          </span>
          <h1 className="font-display text-[58px] font-extrabold leading-[1.05] tracking-[-0.02em] text-text [text-wrap:pretty]">
            {t("Um lugar para cada conversa, cliente e venda.")}
          </h1>
          <p className="max-w-[440px] text-[17px] leading-[1.6] text-text/[0.62]">
            {t(
              "Reúne atendimento, pipeline e histórico do cliente em uma única operação.",
            )}
          </p>

          {MOSTRAR_INDICADORES && (
            <div className="grid max-w-[520px] grid-cols-3 gap-3.5">
              {[
                { valor: "1.247", rotulo: t("atendimentos hoje"), destaque: false },
                { valor: "42s", rotulo: t("tempo médio de resposta"), destaque: false },
                { valor: "31,8%", rotulo: t("taxa de conversão"), destaque: true },
              ].map((i) => (
                <div
                  key={i.rotulo}
                  className={
                    i.destaque
                      ? "border border-accent/45 bg-accent/[0.12] px-4 pb-5 pt-[18px]"
                      : "border border-text/[0.16] bg-bg/[0.28] px-4 pb-5 pt-[18px]"
                  }
                >
                  <div className="font-display text-[28px] font-bold tracking-[-0.02em] text-text">
                    {i.valor}
                  </div>
                  <div className="mt-1.5 text-[12.5px] leading-[1.4] text-text/[0.62]">
                    {i.rotulo}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {MOSTRAR_DEPOIMENTO && (
          <figure className="relative m-0 hidden max-w-[560px] items-center gap-3.5 lg:flex">
            <div /*
                Branco puro, e não `text-text` (#F4F5F7): sobre o accent
                (#3B6FD4) o Paper dá 4,34:1 e o axe reprova por contraste —
                13px não é "texto grande", então o piso é 4,5. Branco dá
                4,73:1. É o mesmo par que o botão "Entrar" já usa
                (`text-accent-foreground`), medido em
                `tests/e2e/auth.spec.ts` pelo caso de a11y.
              */
              className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent font-display text-[13px] font-bold tracking-[0.04em] text-accent-foreground">
              MR
            </div>
            <div>
              <blockquote className="m-0 text-[14.5px] leading-[1.5] text-text/[0.88]">
                {t(
                  "“Passamos a saber exatamente onde cada lead parou. O time deixou de perder venda por esquecimento.”",
                )}
              </blockquote>
              <figcaption className="mt-[5px] text-xs text-text/[0.55]">
                Marina Reis · {t("Diretora comercial, Clínica Vitta")}
              </figcaption>
            </div>
          </figure>
        )}
      </section>

      {/*
        A COLUNA DO FORMULÁRIO — e o `<main>` da tela.

        O painel da esquerda é vitrine; o conteúdo pelo qual alguém veio até aqui
        é este. Sem um landmark, o axe acusa `region` em cada bloco solto (eram
        onze) e quem navega por landmarks cai direto no meio do texto de
        marketing antes de achar o campo de e-mail.
      */}
      <main className="relative flex flex-col items-center justify-center bg-bg px-6 py-12 lg:px-12 lg:py-14">
        <div className="flex w-full max-w-[392px] flex-col">
          <h2 className="m-0 font-display text-[34px] font-bold tracking-[-0.02em] text-text">
            {t("Bem-vindo de volta")}
          </h2>
          <p className="mb-0 mt-2.5 text-[14.5px] leading-[1.55] text-text/[0.62]">
            {t("Use o e-mail da sua organização para entrar.")}
          </p>

          {avisos.length > 0 && (
            <div className="mt-6 space-y-2">
              {avisos.map((a) => (
                <div
                  key={a.chave}
                  role={a.tom === "ok" ? "status" : "alert"}
                  className={
                    a.tom === "ok"
                      ? "border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-text"
                      : "border border-error/40 bg-error-bg px-3 py-2 text-sm text-error-fg"
                  }
                >
                  {a.texto}
                </div>
              ))}
            </div>
          )}

          <LoginForm next={next} />

          <div className="mt-[26px] flex flex-col items-center gap-3">
            <span className="flex items-center gap-[7px] text-[12.5px] text-text/[0.55]">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6Z" />
                <path d="m9 12 2 2 4-4" />
              </svg>
              {t("Dados criptografados de ponta a ponta")}
            </span>
            {/*
              A maquete escrevia "Fale com o administrador" num link morto
              (href="#"). Aqui o destino real é `/signup`, que é a rota que este
              produto tem para quem ainda não entrou — um link que não navega na
              primeira tela é pior que um texto diferente do desenho.
            */}
            <span className="text-[12.5px] text-text/[0.55]">
              {t("Não tem conta?")}{" "}
              <Link
                href="/signup"
                className="font-medium text-accent-500 underline-offset-4 hover:underline"
              >
                {t("Criar conta")}
              </Link>
            </span>
            <span className="text-xs text-text/[0.55]">
              © {new Date().getFullYear()} {nome} ·{" "}
              <Link href="/legal/privacy" className="underline-offset-4 hover:underline">
                {t("Privacidade")}
              </Link>{" "}
              ·{" "}
              <Link href="/legal/terms" className="underline-offset-4 hover:underline">
                {t("Termos")}
              </Link>
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}

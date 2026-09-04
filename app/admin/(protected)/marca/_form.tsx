"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateBranding } from "@/app/actions/settings/updateBranding";
import { CampoDeLogo } from "@/components/branding/CampoDeLogo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cssDaMarca } from "@/lib/branding/css";
import { ehHexValido, K, normalizarHex } from "@/lib/branding/rampa";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { resolverMarca } from "@/lib/branding/resolve";
import { envelopeDeSemente } from "@/lib/branding/schema";
import { platformBrandingSchema, type PlatformBrandingInput } from "@/lib/schemas/settings";

import { EstadoDaMarca } from "./_estado";
import { avisosDaMarca, type DistanciaAteSuaCor } from "@/lib/branding/linguagem";
import { TiraDeTons, type ItemDaLegenda } from "@/components/branding/TiraDeTons";

export interface MarcaGravada {
  readonly app_name: string | null;
  readonly logo_url: string | null;
  /**
   * O ARQUIVO subido pela tela. Não vai no `Salvar`: tem rota própria
   * (`/api/v1/marca/logo`) porque o que atravessa é multipart e porque o
   * ponteiro é gravado por escritor próprio.
   */
  readonly logo_path: string | null;
  readonly accent_hex: string | null;
  readonly show_powered_by: boolean;
}

interface Props {
  /** A linha como está no banco. Campo não editado aqui volta igual no salvamento. */
  readonly gravada: MarcaGravada;
  /** O nome que a instalação exibe HOJE — vira placeholder, nunca texto fixo. */
  readonly nomeEmVigor: string;
  /**
   * O logo EM VIGOR nesta instalação, já resolvido pelo servidor (arquivo subido
   * acima da URL do arquivo de instalação). `null` = nenhuma camada tem logo, e a
   * interface aparece com o nome em texto.
   */
  readonly logoEmVigor: string | null;
  /** O que apareceria SEM o arquivo subido — a URL colada no `.env`, se houver. */
  readonly logoDoAmbiente: string | null;
  readonly origens: { readonly nome: string; readonly logoUrl: string; readonly cor: string };
  readonly definidoNestaTela: boolean;
  readonly fallbackEm: string | null;
  readonly fallbackMotivo: string | null;
}

/** Mensagem por código de recusa da server action. */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Algum campo não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo para salvar.",
  forbidden_role: "Só quem administra a instalação pode mudar a marca.",
};

/** Cinza médio para o seletor visual quando o campo ainda não tem cor válida. */
const COR_NEUTRA_DO_SELETOR = "#808080";

export function FormularioDaMarca({
  gravada,
  nomeEmVigor,
  logoEmVigor,
  logoDoAmbiente,
  origens,
  definidoNestaTela,
  fallbackEm,
  fallbackMotivo,
}: Props) {
  const router = useRouter();
  const [nome, setNome] = useState(gravada.app_name ?? "");
  const [hex, setHex] = useState(gravada.accent_hex ?? "");
  const [erroTecnico, setErroTecnico] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const hexLimpo = hex.trim();
  const hexValido = hexLimpo.length === 0 || ehHexValido(hexLimpo);

  /**
   * A resolução AO VIVO, pelo mesmo caminho que o servidor usa no render.
   *
   * `resolverMarca` e não `derivarMarca` direto: assim o envelope, a validação e
   * os motivos que a pessoa vê aqui são exatamente os que o `app/layout.tsx`
   * produzirá depois de salvar. Duas montagens diferentes divergiriam justamente
   * no caso de borda — e o caso de borda é o que esta tela existe para mostrar.
   *
   * A derivação inteira (duas caminhadas de contraste sobre todos os pares) roda
   * a cada tecla, e isso é barato: são milhares de conversões de cor, não
   * milhões, e o `useMemo` já corta a repetição enquanto o hex não muda.
   */
  const resolvida = useMemo(
    () =>
      resolverMarca(
        [{ origem: "tela", cor: hexLimpo.length > 0 ? envelopeDeSemente(hexLimpo) : undefined }],
        REGUA_DO_PRODUTO,
      ),
    [hexLimpo],
  );

  // A mesma serialização que decide se a cor chega ao `<style>` da página —
  // rodada aqui para a tela poder dizer "esta cor não seria aplicada" ANTES de
  // salvar, em vez de o operador descobrir pelo alarme de fallback depois.
  const serializacao = useMemo(() => cssDaMarca(resolvida.cor), [resolvida.cor]);

  const derivada = resolvida.cor?.derivada ?? null;

  /**
   * Em que degrau da escada cada papel pousou.
   *
   * O clamp não é zelo: com deslocamento grande o índice aritmético SAI do
   * array (`#f5c518` anda +3 no modo claro e leva os papéis para além do 10), e
   * o motor já resolve isso prendendo nas pontas — `stop()`, em `rampa.ts`. A
   * tira tem de marcar o degrau que de fato pinta, não um que não existe.
   */
  const degraus = useMemo(() => {
    if (!derivada) return null;
    const preso = (indice: number) => Math.max(0, Math.min(10, indice));
    return {
      // A cor da pessoa só ocupa um degrau quando a escada foi gerada a partir
      // dela. Marca neutra usa a escada do produto, e ali ela não está.
      suaCor: derivada.origemDaRampa === "semente" ? K : null,
      claro: preso(REGUA_DO_PRODUTO.claro.indices.accent + derivada.claro.deslocamento),
      escuro: preso(REGUA_DO_PRODUTO.escuro.indices.accent + derivada.escuro.deslocamento),
    };
  }, [derivada]);

  // A distância é medida a partir da COR DA PESSOA, que é a referência de quem
  // lê — e não a partir do tom padrão de cada modo, que é a referência do motor.
  // Ver o comentário de `DistanciaAteSuaCor` em `lib/branding/linguagem.ts`.
  const distancia = useMemo<DistanciaAteSuaCor>(() => {
    if (!degraus || degraus.suaCor === null) return { claro: null, escuro: null };
    const suaCor = degraus.suaCor;
    return { claro: degraus.claro - suaCor, escuro: degraus.escuro - suaCor };
  }, [degraus]);

  const avisos = useMemo(
    () => avisosDaMarca([...resolvida.motivos, ...serializacao.motivos], distancia),
    [resolvida.motivos, serializacao.motivos, distancia],
  );

  const legenda = useMemo<ItemDaLegenda[]>(() => {
    if (!derivada || !degraus) return [];
    return [
      {
        rotulo: "Sua cor",
        hex: derivada.marca,
        indice: degraus.suaCor,
        nota: degraus.suaCor === null ? "fora da escala — fica só no logo" : undefined,
      },
      { rotulo: "Botões no modo claro", hex: derivada.claro.accent, indice: degraus.claro },
      { rotulo: "Botões no modo escuro", hex: derivada.escuro.accent, indice: degraus.escuro },
    ];
  }, [derivada, degraus]);

  function handleSubmit(evento: React.FormEvent) {
    evento.preventDefault();
    setErroTecnico(null);

    const candidato: PlatformBrandingInput = {
      app_name: nome.trim() || null,
      // `logo_url` volta COMO ESTÁ, e continua não sendo editável aqui: ele é a
      // URL colada no arquivo de instalação (`APP_LOGO_URL`), que sobrevive como
      // rede de rollback — o `agent.sh` reverte a imagem, nunca o banco. O que a
      // tela edita agora é o ARQUIVO (`logo_path`), que vence essa URL dentro da
      // mesma camada. Mandar o valor gravado é o que impede o `upsert` de
      // apagá-lo.
      logo_url: gravada.logo_url,
      accent_hex: hexLimpo || null,
      // `logo_path` NÃO entra aqui, e a ausência é a decisão: quem grava o
      // arquivo é `/api/v1/marca/logo`, e o `upsert` desta action não inclui a
      // coluna — então salvar o nome não pode apagar o logo. (Na camada da
      // ORGANIZAÇÃO o mesmo problema exigiu um forward-fix na função SQL, porque
      // lá a escrita substitui o objeto `branding` inteiro.)
      // Idem: `show_powered_by` não tem nenhum consumidor no produto hoje —
      // medido, zero ocorrências fora do schema e da tabela. Um interruptor que
      // não muda nada em tela nenhuma é pior que a ausência dele.
      show_powered_by: gravada.show_powered_by,
    };

    const lido = platformBrandingSchema.safeParse(candidato);
    if (!lido.success) {
      toast.error("Confira os campos: algum valor não está no formato esperado.");
      return;
    }

    startTransition(async () => {
      const resultado = await updateBranding(lido.data);
      if (resultado.ok) {
        toast.success("Marca salva.");
        // A origem e o alarme deste bloco vêm do servidor: sem o refresh eles
        // continuariam descrevendo o estado de antes de salvar.
        router.refresh();
        return;
      }
      toast.error(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar a marca agora.");
      // Recusa que esta tela não sabe nomear não pode virar só um toast genérico:
      // o texto cru é o que torna o problema diagnosticável para quem tem acesso
      // ao servidor. Falhar fechado na ação, aberto na informação.
      if (!ERRO_EM_PORTUGUES[resultado.error]) setErroTecnico(resultado.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
      <Card className="space-y-2 p-6">
        <Label htmlFor="app_name">Nome do sistema</Label>
        <Input
          id="app_name"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder={nomeEmVigor}
          maxLength={120}
          autoComplete="off"
        />
        {/*
          Esta frase precisa ser VERDADE enquanto a dívida existir, e ela já
          envelheceu DUAS vezes. Primeiro dizia que "o menu ainda mostra o nome do
          arquivo de instalação", o que deixou de valer quando o menu passou a
          preferir o nome da própria organização (`components/shell/Sidebar.tsx`).
          Depois dizia que os menus e o arquivo de códigos de recuperação
          continuavam no arquivo de instalação, o que deixou de valer quando o
          `<PublicEnvScript/>` passou a injetar a marca RESOLVIDA em vez de
          `env.APP_NAME` cru.

          Agora envelheceu uma TERCEIRA vez, e vale registrar o porquê: dizia que
          os 4 client components (os dois menus, o painel de códigos de
          recuperação e uma tela de integração) liam `window.__PUBLIC_ENV__`. Eles
          liam — e era um DEFEITO, não um caminho. `branding()` lê
          `window.__PUBLIC_ENV__` no navegador e `process.env` no servidor, e a
          injeção da marca resolvida fez as duas divergirem: no SSR de um
          `"use client"` não há `window`, então o servidor renderizava o nome do
          arquivo de instalação e o navegador hidratava o do banco — React #418
          em toda tela. Hoje esses 4 recebem a marca por PROP
          (`useMarcaDaInstalacao`, alimentado pelo layout raiz), então continuam
          mostrando o banco, e os dois lados concordam.

          Medido AGORA, sobre os call sites de `branding()`: nenhum é client
          component (há catraca em
          `tests/unit/marca-sem-divergencia-de-hidratacao.test.tsx`); os que
          sobram são server components (login, cadastro, casca e boas-vindas da
          configuração inicial, mais o texto legal) e leem `process.env` direto.
          São esses que continuam no arquivo de instalação — e o login segue ali
          de propósito, porque `tests/e2e/icone-da-marca.spec.ts` cruza o título
          da aba (banco) contra o texto do login (arquivo) e a spec mediria nada
          se os dois viessem da mesma fonte.
        */}
        <p className="text-xs text-text-muted">
          Deixe em branco para voltar ao nome padrão. Este nome já aparece no título da aba do
          navegador, nos menus laterais, nos e-mails que o sistema envia (para as empresas que
          não definiram um nome próprio), no aplicativo de verificação em duas etapas e no
          arquivo de códigos de recuperação que o usuário baixa. Ainda NÃO chega às telas de
          entrada e cadastro nem às da configuração inicial: essas continuam com o nome gravado
          no arquivo de instalação do servidor até a próxima atualização da stack.
        </p>
      </Card>

      <Card className="space-y-4 p-6">
        <div className="space-y-2">
          <Label htmlFor="accent_hex">Cor da marca</Label>
          <div className="flex items-center gap-3">
            {/* Atalho, nunca o controle principal: o seletor do navegador escolhe
                UM pixel e não mostra o que o sistema faz com ele. Quem ensina é a
                tira abaixo. */}
            <label
              className="relative h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-sm border border-border"
              style={{
                backgroundColor: ehHexValido(hexLimpo)
                  ? normalizarHex(hexLimpo)
                  : COR_NEUTRA_DO_SELETOR,
              }}
            >
              <span className="sr-only">Escolher a cor visualmente</span>
              <input
                type="color"
                value={ehHexValido(hexLimpo) ? normalizarHex(hexLimpo) : COR_NEUTRA_DO_SELETOR}
                onChange={(e) => setHex(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
            <Input
              id="accent_hex"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              placeholder="#7a5cd6"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!hexValido}
              aria-describedby="ajuda-da-cor"
              className="w-36 font-mono"
            />
            {hexLimpo.length > 0 && !hexValido ? (
              <span className="text-sm text-error-fg">
                Use um código de cor como #7a5cd6.
              </span>
            ) : null}
          </div>
          <p id="ajuda-da-cor" className="text-xs text-text-muted">
            Deixe em branco para voltar à cor padrão do sistema.
          </p>
        </div>

        {derivada ? (
          <div className="space-y-2">
            <p className="text-sm text-text-muted">
              A partir da sua cor o sistema monta esta escala e escolhe, dentro dela, o tom que
              vai nos botões:
            </p>
            <TiraDeTons tons={derivada.rampa} legenda={legenda} />
            {/* Fato de desenho do produto, não diagnóstico desta cor: o modo
                escuro parte de um tom mais claro da escala por construção. Sem
                esta linha, ver dois tons diferentes marcados na tira parece
                incoerência do sistema. */}
            <p className="text-xs text-text-muted">
              No modo escuro o sistema usa naturalmente um tom mais claro da escala, para a cor
              não se perder no fundo escuro.
            </p>
          </div>
        ) : (
          <p className="text-sm text-text-muted">
            Sem cor definida, o sistema usa a cor padrão dele.
          </p>
        )}
      </Card>

      {/*
        O logo em cartão PRÓPRIO, e não junto do nome: ele não passa pelo botão
        Salvar. Misturá-lo aos campos que passam ensinaria que o arquivo só vale
        depois de salvar — e a pessoa sairia da tela achando que perdeu o upload.
      */}
      <Card className="space-y-4 p-6">
        <CampoDeLogo
          escopo="instalacao"
          // Literal, nunca memoizado: a identidade deste objeto é o que diz ao
          // campo que houve render NOVO do servidor. Ver os Props de CampoDeLogo.
          logoDaCamada={{ url: gravada.logo_path ? logoEmVigor : null }}
          logoHerdado={logoDoAmbiente}
          origemDoHerdado="do arquivo de instalação do servidor"
          nomeEmVigor={nomeEmVigor}
        />
      </Card>

      <EstadoDaMarca
        origens={origens}
        definidoNestaTela={definidoNestaTela}
        fallbackEm={fallbackEm}
        fallbackMotivo={fallbackMotivo}
        derivada={derivada}
        avisos={avisos}
        seriaAplicada={serializacao.css !== null}
      />

      <div className="flex items-center justify-end gap-3">
        {erroTecnico ? (
          <span className="font-mono text-xs text-text-muted">{erroTecnico}</span>
        ) : null}
        <Button type="submit" disabled={isPending || !hexValido}>
          {isPending ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}

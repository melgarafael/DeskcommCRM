"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { PreviaDaDefinicao } from "./PreviaDaDefinicao";
import {
  contarVariaveis,
  IDIOMAS_DA_DEFINICAO,
  idiomaInicialDaDefinicao,
  lerConteudo,
  LIMITE_BOTOES,
  LIMITE_CORPO,
  LIMITE_RODAPE,
  montarComponents,
  paraFormulario,
  type BotaoDaDefinicao,
} from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";
import { useLocaleDaOrgAtiva } from "@/hooks/auth/AuthProvider";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";

/**
 * O FORMULÁRIO de uma definição aprovada — criar ou editar. Mora num componente
 * próprio porque DUAS telas o usam: as duas rotas de modelos do canal
 * intermediado e, desde a #3635, o canal oficial direto. Duplicá-lo faria a
 * primeira correção de limite/exemplo valer de um lado só.
 *
 * ─── O que o formulário NÃO valida ─────────────────────────────────────────
 *
 * O formato do nome, o tamanho do texto e a categoria são validados PELA
 * PLATAFORMA, e a recusa dela chega inteira ao operador. Repetir a regra aqui a
 * faria envelhecer separado da fonte. O que ele faz é AVISAR do que a revisão
 * exige — o exemplo de cada `{{n}}` e os limites de corpo/rodapé —, porque a
 * recusa chega horas depois e sem dizer qual era o problema.
 *
 * ─── Editar reusa o mesmo formulário ───────────────────────────────────────
 *
 * Nome, idioma e categoria ficam TRAVADOS na edição: a plataforma não deixa
 * mudá-los depois de criado, e oferecer o campo seria prometer uma edição que
 * ela recusa.
 */
export interface ModeloEmEdicao {
  name: string;
  language: string;
  category: string | null;
  /** A definição crua que a plataforma devolveu — de onde o texto é preenchido. */
  components: unknown[];
}

/** O corpo que as duas rotas aceitam em `POST …/templates` com `acao`. */
export interface CorpoDoModelo {
  acao: "criar" | "editar";
  name: string;
  language: string;
  category?: string;
  components: unknown[];
}

export function FormularioDaDefinicao({
  editando = null,
  salvando = false,
  rotaDeMidia = "/api/v1/channels/partner/templates/media",
  onEnviar,
}: {
  /** `null` = criação. Preenchido = edição daquela variante. */
  editando?: ModeloEmEdicao | null;
  salvando?: boolean;
  /**
   * Onde a imagem do cabeçalho é guardada. O arquivo vai para o NOSSO storage e
   * a rota devolve um link assinado — o mesmo caminho para qualquer canal, que é
   * por isso que a rota é parametrizável.
   */
  rotaDeMidia?: string;
  onEnviar: (corpo: CorpoDoModelo) => void;
}) {
  const t = useT();
  const telefoneExemplo = useTelefoneExemplo();

  // O texto aprovado vira o formulário: quem edita uma vírgula não redigita a
  // definição inteira.
  const inicial = editando ? paraFormulario(lerConteudo(editando.components)) : null;

  const [nome, setNome] = useState(editando?.name ?? "");
  const localeDaOrg = useLocaleDaOrgAtiva();
  const [idioma, setIdioma] = useState(editando?.language ?? idiomaInicialDaDefinicao(localeDaOrg));
  const [categoria, setCategoria] = useState(editando?.category ?? "UTILITY");
  const [corpo, setCorpo] = useState(inicial?.corpo ?? "");
  const [rodape, setRodape] = useState(inicial?.rodape ?? "");
  const [exemplos, setExemplos] = useState<string[]>(inicial?.exemplos ?? []);
  const [cabecalho, setCabecalho] = useState(inicial?.cabecalho ?? "");
  const [midiaUrl, setMidiaUrl] = useState(inicial?.midiaUrl ?? "");
  const [botoes, setBotoes] = useState<BotaoDaDefinicao[]>(inicial?.botoes ?? []);
  const [subindo, setSubindo] = useState(false);

  // Quantas amostras a revisão vai exigir. Recalculado enquanto se digita: o
  // operador vê o campo aparecer no instante em que escreve `{{1}}`, e não
  // descobre a exigência numa recusa que chega horas depois.
  const nVariaveis = contarVariaveis(corpo);

  return (
    <div
      className="grid scroll-mt-4 gap-4 rounded-md border border-border p-3 lg:grid-cols-[1fr_20rem]"
      data-formulario-do-modelo={editando ? "editar" : "criar"}
    >
      <div className="flex flex-col gap-2">
        {editando && (
          <p className="text-sm font-medium">
            {t("Editando")} <span className="font-mono">{editando.name}</span>{" "}
            <span className="text-xs font-normal text-muted-foreground">
              — {t("nome, idioma e categoria não mudam depois de criado.")}
            </span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="nome_do_modelo"
            aria-label={t("Nome do modelo")}
            disabled={!!editando}
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
          />
          {/* LISTA, e não campo livre. O contrato descreve o formato e não
              enumera os valores; digitar é onde o erro nasce — `esp`, `ES`,
              `es-AR` e `español` são todos recusados, e a recusa volta como
              "language not supported" horas depois. */}
          <select
            value={idioma}
            onChange={(e) => setIdioma(e.target.value)}
            aria-label={t("Idioma")}
            disabled={!!editando}
            className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
          >
            {IDIOMAS_DA_DEFINICAO.map((i) => (
              <option key={i.codigo} value={i.codigo}>
                {t(i.rotulo)} ({i.codigo})
              </option>
            ))}
          </select>
        </div>
        {/* A CATEGORIA é obrigatória no contrato e não era oferecida: tudo
            saía como UTILITY. Mandar promoção como utility é reclassificado
            (ou recusado) pela revisão — e a tarifa da categoria errada é mais
            cara. O padrão continua UTILITY porque é o caso comum de
            atendimento, mas agora é escolha. */}
        <select
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          aria-label={t("Categoria")}
          disabled={!!editando}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-60"
        >
          <option value="UTILITY">
            {t("Utilidade — aviso de pedido, agendamento, cobrança")}
          </option>
          <option value="MARKETING">{t("Marketing — promoção, novidade, reengajamento")}</option>
          <option value="AUTHENTICATION">{t("Autenticação — código de verificação")}</option>
        </select>

        {/* CABEÇALHO opcional: texto OU mídia, nunca os dois — a plataforma
            aceita um formato por definição, e mandar ambos é recusa. */}
        <div className="flex flex-wrap gap-2">
          <input
            value={cabecalho}
            onChange={(e) => {
              setCabecalho(e.target.value);
              if (e.target.value) setMidiaUrl("");
            }}
            placeholder={t("Cabeçalho de texto (opcional)")}
            aria-label={t("Cabeçalho de texto")}
            disabled={!!midiaUrl}
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
          />
          {/* SUBIR, e não colar URL. Colar exigia que o operador já tivesse a
              imagem hospedada em algum lugar público — que é justamente o que
              ele não tem. O arquivo vai para o nosso storage e a rota devolve
              um link assinado, que é o que a plataforma baixa na revisão. */}
          <label
            className={cn(
              "flex h-9 flex-1 cursor-pointer items-center justify-center rounded-md border border-dashed border-input px-2 text-sm text-muted-foreground hover:bg-muted",
              cabecalho && "pointer-events-none opacity-50",
            )}
          >
            {subindo
              ? t("Subindo…")
              : midiaUrl
                ? t("Trocar imagem")
                : t("Subir imagem (JPG/PNG)")}
            <input
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              aria-label={t("Imagem do cabeçalho")}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setSubindo(true);
                try {
                  const fd = new FormData();
                  fd.append("file", f);
                  const r = await fetch(rotaDeMidia, {
                    method: "POST",
                    body: fd,
                  });
                  const j = (await r.json()) as { data?: { url?: string }; error?: { message?: string } };
                  if (!r.ok || !j.data?.url) {
                    // A mensagem da rota CHEGA ao operador: é ela que
                    // distingue "formato" de "tamanho" de "erro nosso".
                    toast.error(t(j.error?.message ?? "Não consegui subir a imagem."));
                    return;
                  }
                  setMidiaUrl(j.data.url);
                  setCabecalho("");
                } finally {
                  setSubindo(false);
                  e.target.value = "";
                }
              }}
            />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <textarea
            value={corpo}
            onChange={(e) => setCorpo(e.target.value.slice(0, LIMITE_CORPO))}
            placeholder={t("Texto da mensagem. Use {{1}}, {{2}} para os valores que mudam.")}
            aria-label={t("Conteúdo")}
            className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
          {/* O contador existe porque passar do limite é RECUSA, e a recusa
              chega horas depois sem dizer que o problema era o tamanho. */}
          <span className="self-end text-[10px] text-muted-foreground">
            {corpo.length}/{LIMITE_CORPO}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <input
            value={rodape}
            onChange={(e) => setRodape(e.target.value.slice(0, LIMITE_RODAPE))}
            placeholder={t("Rodapé (opcional) — texto pequeno no fim da mensagem")}
            aria-label={t("Rodapé")}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          />
          <span className="self-end text-[10px] text-muted-foreground">
            {rodape.length}/{LIMITE_RODAPE}
          </span>
        </div>

        {/* BOTÕES: até três, e cada tipo pede um campo diferente. URL sem
            endereço e telefone sem número são recusados — por isso o campo
            extra aparece junto com o tipo, e não escondido atrás de outro
            clique. */}
        <div className="flex flex-col gap-1.5">
          {botoes.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                value={b.tipo}
                onChange={(e) => {
                  const p = [...botoes];
                  p[i] = { ...b, tipo: e.target.value as BotaoDaDefinicao["tipo"] };
                  setBotoes(p);
                }}
                aria-label={`${t("Tipo do botão")} ${i + 1}`}
                className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="quick_reply">{t("Resposta rápida")}</option>
                <option value="url">{t("Abrir link")}</option>
                {/* NÃO usar t("Ligar") aqui: essa chave já existe no dicionário
                    traduzida como "Activar" (o toggle de automações em
                    RulesTab.tsx) — mesma palavra fonte, sentido diferente
                    ("Llamar", não "Activar"). Texto puro evita a tradução errada. */}
                <option value="phone_number">Ligar</option>
              </select>
              <input
                value={b.texto}
                onChange={(e) => {
                  const p = [...botoes];
                  p[i] = { ...b, texto: e.target.value };
                  setBotoes(p);
                }}
                placeholder={t("Texto do botão")}
                aria-label={`${t("Texto do botão")} ${i + 1}`}
                className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              />
              {b.tipo === "url" && (
                <input
                  value={b.url ?? ""}
                  onChange={(e) => {
                    const p = [...botoes];
                    p[i] = { ...b, url: e.target.value };
                    setBotoes(p);
                  }}
                  placeholder="https://…"
                  aria-label={`${t("URL do botão")} ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
              )}
              {b.tipo === "phone_number" && (
                <input
                  value={b.telefone ?? ""}
                  onChange={(e) => {
                    const p = [...botoes];
                    p[i] = { ...b, telefone: e.target.value };
                    setBotoes(p);
                  }}
                  placeholder={telefoneExemplo}
                  aria-label={`${t("Telefone do botão")} ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
              )}
              <button
                type="button"
                onClick={() => setBotoes(botoes.filter((_, j) => j !== i))}
                className="text-xs text-muted-foreground hover:text-destructive"
                aria-label={`${t("Remover botão")} ${i + 1}`}
              >
                {t("remover")}
              </button>
            </div>
          ))}
          {botoes.length < LIMITE_BOTOES && (
            <button
              type="button"
              onClick={() => setBotoes([...botoes, { tipo: "quick_reply", texto: "" }])}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              + {t("Adicionar botão")} ({botoes.length}/{LIMITE_BOTOES})
            </button>
          )}
        </div>

        {nVariaveis > 0 && (
          /* ESTE É O CAMPO QUE FALTAVA, e a causa das recusas.
             A revisão exige uma AMOSTRA de cada `{{n}}` — sem ela a definição
             é recusada, e a recusa chega horas depois sem ninguém ligar uma
             coisa à outra. O formulário deixava digitar `{{1}}` e nunca
             pedia o exemplo. */
          <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50/50 p-2 dark:border-amber-800/60 dark:bg-amber-950/20">
            <p className="text-[11px] text-amber-900 dark:text-amber-200">
              {t("A revisão exige um exemplo de cada valor. Sem eles o modelo é recusado.")}
            </p>
            {Array.from({ length: nVariaveis }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                  {`{{${i + 1}}}`}
                </span>
                <input
                  value={exemplos[i] ?? ""}
                  onChange={(e) => {
                    const proximo = [...exemplos];
                    proximo[i] = e.target.value;
                    setExemplos(proximo);
                  }}
                  placeholder={t("ex.: María")}
                  aria-label={`${t("Exemplo do valor")} ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
              </div>
            ))}
          </div>
        )}

        {/* O formato do nome e o texto são validados PELA PLATAFORMA, e a
            recusa dela chega inteira ao operador. Repetir a regra aqui a faria
            envelhecer separado da fonte. */}
        <p className="text-[11px] text-muted-foreground">
          {editando
            ? t(
                "Ao salvar, a plataforma revisa o modelo de novo. A Meta limita quantas vezes um modelo aprovado pode ser editado; se passar do limite, a resposta dela aparece aqui.",
              )
            : t(
                "A plataforma revisa antes de aprovar — o modelo nasce pendente e some da lista de envio até ela decidir.",
              )}
        </p>
        <div className="flex sm:justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!nome.trim() || !corpo.trim() || salvando}
            onClick={() => {
              const components = montarComponents({
                body: corpo,
                footer: rodape,
                exemplos,
                cabecalho: { texto: cabecalho, midiaUrl },
                botoes,
              });
              onEnviar(
                editando
                  ? { acao: "editar", name: editando.name, language: editando.language, components }
                  : {
                      acao: "criar",
                      name: nome.trim(),
                      language: idioma.trim(),
                      category: categoria,
                      components,
                    },
              );
            }}
            className="w-full sm:w-auto"
          >
            {editando ? t("Salvar e enviar para revisão") : t("Enviar para revisão")}
          </Button>
        </div>
      </div>

      {/* A prévia fica AO LADO, não embaixo: embaixo ela sai da tela junto
          com o botão de enviar, e o operador manda sem ter olhado. */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <PreviaDaDefinicao
          cabecalho={cabecalho}
          midiaUrl={midiaUrl}
          corpo={corpo}
          rodape={rodape}
          botoes={botoes}
        />
      </div>
    </div>
  );
}

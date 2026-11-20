"use client";

/**
 * "NOVA TAG" — criar a etiqueta com nome e cor ANTES do primeiro uso (#5012, T1).
 *
 * ── O que faltava ────────────────────────────────────────────────────────────
 *
 * A tela de Tags só agia sobre etiquetas que já existiam: a etiqueta nascia no
 * primeiro uso (uma conversa, um contato, um negócio, uma regra `add_tag`).
 * Quem queria preparar "Atacado", em verde, antes de a equipe começar não tinha
 * por onde — e cada atendente digitava do seu jeito, o que estraga o relatório
 * por tag do Faturamento.
 *
 * ── Sem rota nova, sem migration ─────────────────────────────────────────────
 *
 * `fn_vocabulario_de_tags_operar` com `definir_cor` JÁ acrescenta ao vocabulário
 * (`organizations.settings.tags`) a etiqueta que ainda não está lá, com a cor
 * pedida. Esta tela é a porta para isso: o MESMO `POST /api/v1/tags/vocabulario`,
 * o mesmo portão (`manager` + MFA), a mesma auditoria. Por isso a cor é
 * obrigatória aqui — sem cor, `definir_cor` não acrescenta nada.
 *
 * ── Nome que já existe ───────────────────────────────────────────────────────
 *
 * `definir_cor` num nome que JÁ existe só troca a cor dele. A tela pergunta antes
 * ao servidor (a mesma busca paginada da junção, #2855), e com o nome já em uso
 * diz para usar o botão "Cor" da lista, em vez de repintar calada uma etiqueta
 * que o operador talvez nem soubesse que existia.
 *
 * ── Teto de 40 caracteres ────────────────────────────────────────────────────
 *
 * A etiqueta de CONVERSA tem teto de 40 (o vocabulário aceita 60). Uma etiqueta
 * criada aqui precisa caber nos três lugares em que vai ser usada.
 */
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { invalidarCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import type { LinhaDeVocabulario } from "@/lib/schemas/tags";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { cn } from "@/lib/utils";

import { CHAVES_COM_NOME_DE_ETIQUETA, ERRO_EM_PORTUGUES } from "./_painel";

export const TAMANHO_MAXIMO_DA_NOVA_TAG = 40;

/**
 * O tom que já vem marcado: o azul da paleta, que lê bem nos temas claro e
 * escuro. O primeiro da paleta é o amarelo, que fica apagado no tema claro.
 */
export const COR_PADRAO_DA_NOVA_TAG = "#0091ff";

/** O nome normalizado como o banco compara (`lower(btrim(...))`). */
export function chaveDoNome(nome: string): string {
  return nome.trim().toLowerCase();
}

export function NovaTag({ idioma }: { idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [aberta, setAberta] = useState(false);
  const [nome, setNome] = useState("");
  const [cor, setCor] = useState<string>(COR_PADRAO_DA_NOVA_TAG);
  const [jaExiste, setJaExiste] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  function fechar() {
    setAberta(false);
    setNome("");
    setJaExiste(false);
    setCor(COR_PADRAO_DA_NOVA_TAG);
  }

  async function criar() {
    const limpo = nome.trim();
    if (limpo === "" || ocupado) return;
    setOcupado(true);
    setJaExiste(false);
    try {
      // 1. O nome já existe (em qualquer página da lista)?
      const busca = await fetch("/api/v1/tags/vocabulario?busca=" + encodeURIComponent(limpo));
      if (busca.ok) {
        const achadas = ((await busca.json()) as { data?: LinhaDeVocabulario[] }).data ?? [];
        if (achadas.some((linha) => chaveDoNome(linha.tag) === chaveDoNome(limpo))) {
          setJaExiste(true);
          return;
        }
      }

      // 2. Cria: `definir_cor` acrescenta ao vocabulário o nome que não está lá.
      const resposta = await fetch("/api/v1/tags/vocabulario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao: "definir_cor", tag: limpo, cor }),
      });
      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => null)) as { error?: { code?: string } } | null;
        const codigo = corpo?.error?.code ?? "internal_error";
        toast.error(t(ERRO_EM_PORTUGUES[codigo] ?? "Não foi possível concluir agora. Tente de novo."));
        return;
      }

      // 3. A etiqueta nova aparece nas sugestões e no chip sem esperar o cache.
      invalidarCoresDasEtiquetas(queryClient);
      for (const queryKey of CHAVES_COM_NOME_DE_ETIQUETA) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
      toast.success(`${t("Tag criada:")} ${limpo}`);
      fechar();
      router.refresh();
    } catch {
      toast.error(
        t("Não foi possível falar com o servidor. Recarregue a página e confira antes de tentar de novo."),
      );
    } finally {
      setOcupado(false);
    }
  }

  if (!aberta) {
    return (
      <div>
        <Button onClick={() => setAberta(true)} data-testid="nova-tag-abrir">
          {t("Nova tag")}
        </Button>
      </div>
    );
  }

  return (
    <Card className="flex max-w-xl flex-col gap-4 p-4" data-testid="nova-tag">
      <div className="flex flex-col gap-2">
        <Label htmlFor="nome-da-nova-tag">{t("Nome da tag")}</Label>
        <Input
          id="nome-da-nova-tag"
          value={nome}
          onChange={(evento) => {
            setNome(evento.target.value);
            setJaExiste(false);
          }}
          maxLength={TAMANHO_MAXIMO_DA_NOVA_TAG}
          placeholder={t("Ex.: Atacado")}
          autoFocus
        />
        {jaExiste && (
          <p role="alert" data-testid="nova-tag-ja-existe" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {t("Essa tag já existe. Para mudar a cor dela, use o botão Cor na lista.")}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>{t("Cor da etiqueta")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          {PALETA_DE_ETIQUETAS.map((tom) => (
            <button
              key={tom}
              type="button"
              onClick={() => setCor(tom)}
              aria-pressed={cor === tom}
              aria-label={t(NOME_DO_TOM[tom] ?? tom)}
              title={tom}
              className={cn(
                "size-7 rounded-full border-2 transition-transform",
                cor === tom
                  ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                  : "border-transparent hover:scale-110",
              )}
              style={{ backgroundColor: tom }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t("Prévia:")}</span>
          <ChipDeEtiqueta tag={nome.trim() || t("Ex.: Atacado")} cor={cor} />
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={criar} disabled={ocupado || nome.trim() === ""} data-testid="nova-tag-criar">
          {ocupado ? t("Aplicando...") : t("Criar tag")}
        </Button>
        <Button variant="ghost" onClick={fechar} disabled={ocupado}>
          {t("Cancelar")}
        </Button>
      </div>
    </Card>
  );
}

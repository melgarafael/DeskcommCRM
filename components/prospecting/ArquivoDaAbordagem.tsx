"use client";

/**
 * O ARQUIVO DA PRIMEIRA ABORDAGEM NA TELA DA CAMPANHA (#4751).
 *
 * A mídia da abordagem existe no motor desde a #4581 (`midia_da_abordagem` em
 * `lib/prospecting/schema.ts`), mas só dava para configurá-la pela API. Este
 * campo leva para a tela o que a API já aceita, sem mudar o envio:
 *
 * · Escolher: a lista é dos arquivos que JÁ estão no Storage desta organização,
 *   as imagens das respostas rápidas (`message_templates.midias`). É o mesmo
 *   vocabulário que a configuração grava (caminho, mime e tamanho), preenchido
 *   pela rota de upload que confere os bytes. Nada de upload novo aqui: enviar
 *   uma imagem nova é anexá-la a uma resposta rápida, na tela de sempre.
 * · Filtrar pela MESMA régua do envio (`classificarMidiaDaAbordagem`): o que a
 *   lista oferece é o que o schema aceita, e nada que ele recusaria aparece.
 * · Remover: o campo vazio tira a chave da configuração, e a campanha sai só
 *   com texto, como a campanha que nunca teve mídia.
 *
 * Vídeo e PDF continuam aceitos pela API, mas ainda não há rota que os receba
 * fora de uma conversa; a tela diz isso em vez de prometer o que não oferece.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { tamanhoLegivel } from "@/lib/materiais/materiais";
import {
  classificarMidiaDaAbordagem,
  TETO_DIARIO_DE_MIDIA_POR_NUMERO,
  type MidiaDaAbordagem,
  type TipoDeMidiaDaAbordagem,
} from "@/lib/prospecting/midia-da-abordagem";

/** A mesma chave da lista de respostas rápidas: a tela de templates invalida esta. */
const CHAVE_DOS_TEMPLATES = ["message-templates"] as const;

interface TemplateComMidias {
  id: string;
  title: string;
  midias?: MidiaDaAbordagem[] | null;
}

export interface ArquivoOferecido {
  midia: MidiaDaAbordagem;
  /** O título da resposta rápida de onde o arquivo vem. */
  origem: string;
  /** A posição do arquivo dentro da resposta (1, 2, …), para distinguir dois da mesma. */
  posicao: number;
  tipo: TipoDeMidiaDaAbordagem;
}

/**
 * Os arquivos que podem ir numa abordagem, pela régua do envio. Um mesmo
 * caminho aparece uma vez só.
 */
export function arquivosOferecidos(templates: unknown): ArquivoOferecido[] {
  if (!Array.isArray(templates)) return [];
  const vistos = new Set<string>();
  const lista: ArquivoOferecido[] = [];
  for (const template of templates as TemplateComMidias[]) {
    (template.midias ?? []).forEach((midia, indice) => {
      if (!midia?.storage_path || vistos.has(midia.storage_path)) return;
      const classificada = classificarMidiaDaAbordagem(midia);
      if (!classificada.ok) return;
      vistos.add(midia.storage_path);
      lista.push({
        midia: {
          storage_path: midia.storage_path,
          media_mime: midia.media_mime,
          media_size_bytes: midia.media_size_bytes,
        },
        origem: template.title,
        posicao: indice + 1,
        tipo: classificada.tipo,
      });
    });
  }
  return lista;
}

const ROTULO_DO_TIPO: Record<TipoDeMidiaDaAbordagem, string> = {
  image: "Imagem",
  video: "Vídeo",
  document: "PDF",
};

const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";

export function ArquivoDaAbordagem({
  valor,
  onChange,
  travado = false,
}: {
  valor: MidiaDaAbordagem | undefined;
  onChange: (midia: MidiaDaAbordagem | undefined) => void;
  /** A campanha já começou: o campo só mostra, e o aviso de risco já está no cartão. */
  travado?: boolean;
}) {
  const t = useT();
  const templates = useQuery({
    queryKey: CHAVE_DOS_TEMPLATES,
    queryFn: async () =>
      apiClient.get<{ data: TemplateComMidias[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    enabled: !travado,
  });
  const oferecidos = arquivosOferecidos(templates.data?.data);
  const escolhido = valor
    ? oferecidos.find((o) => o.midia.storage_path === valor.storage_path)
    : undefined;
  const tipoDoValor = valor ? classificarMidiaDaAbordagem(valor) : null;
  const rotulo = (o: ArquivoOferecido) =>
    `${o.origem} · ${t(ROTULO_DO_TIPO[o.tipo])} ${o.posicao} · ${tamanhoLegivel(o.midia.media_size_bytes)}`;

  return (
    <div>
      <Label htmlFor="prospecting-arquivo-da-abordagem">
        {t("Arquivo da primeira abordagem")}
      </Label>
      <select
        id="prospecting-arquivo-da-abordagem"
        className={`${selectClass} mt-1`}
        value={valor?.storage_path ?? ""}
        disabled={travado}
        onChange={(e) => {
          const escolha = oferecidos.find((o) => o.midia.storage_path === e.target.value);
          onChange(escolha ? escolha.midia : undefined);
        }}
      >
        <option value="">{t("Sem arquivo: só texto")}</option>
        {/* Arquivo gravado pela API (vídeo, PDF) ou cuja resposta rápida sumiu da
            lista: aparece como está, para o campo não mentir sobre a configuração. */}
        {valor && !escolhido && (
          <option value={valor.storage_path}>
            {t("Arquivo já configurado")}
            {tipoDoValor?.ok ? ` · ${t(ROTULO_DO_TIPO[tipoDoValor.tipo])}` : ""}
            {` · ${tamanhoLegivel(valor.media_size_bytes)}`}
          </option>
        )}
        {oferecidos.map((o) => (
          <option key={o.midia.storage_path} value={o.midia.storage_path}>
            {rotulo(o)}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-muted-foreground">
        {t(
          "Opcional. O arquivo vai junto da primeira mensagem, igual para todas as empresas da campanha. Aceita imagem (JPG, PNG ou WEBP, até 5 MB), vídeo (MP4, 3GP ou MOV, até 16 MB) ou PDF (até 50 MB).",
        )}
      </p>
      {!travado && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "A lista mostra as imagens que você já enviou nas respostas rápidas. Para usar uma imagem nova, anexe-a a uma resposta rápida e volte aqui. Vídeo e PDF, por enquanto, só pela API da campanha.",
          )}{" "}
          <Link href="/app/templates" className="underline">
            {t("Abrir respostas rápidas")}
          </Link>
        </p>
      )}
      {valor && !travado && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => onChange(undefined)}
          >
            {t("Remover arquivo")}
          </Button>
          <p role="note" className="mt-3 rounded-md bg-muted/40 p-3 text-sm">
            {t(
              "Atenção: esta campanha manda o mesmo arquivo junto da primeira mensagem. Quando muita gente que não conhece você recebe o mesmo arquivo, aumenta o risco de o WhatsApp bloquear o seu número. Por segurança, cada número manda o arquivo em no máximo {teto} abordagens por dia; depois disso, as abordagens do dia saem só com o texto.",
            ).replace("{teto}", String(TETO_DIARIO_DE_MIDIA_POR_NUMERO))}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              "Não apague o arquivo escolhido, nem a resposta rápida de onde ele vem, enquanto a campanha estiver ativa: sem o arquivo, a campanha pausa.",
            )}
          </p>
        </>
      )}
    </div>
  );
}

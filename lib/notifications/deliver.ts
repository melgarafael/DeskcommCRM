import { toast } from "sonner";

import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";
import { conteudoNaTelaBloqueadaWriteSchema, type ConteudoNaTelaBloqueada } from "@/lib/schemas/settings";
import { emitNotification } from "./emit";
import type { NotifyKind } from "./kinds";
import { canalLigado, type NotifyCategory } from "./prefs";
import { redigirParaATelaBloqueada } from "./tela-bloqueada";

export interface EntregarAvisoInput {
  category: NotifyCategory;
  kind: NotifyKind;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  icon?: string;
  /** O que a bandeja mostra no modo `nome` no lugar de `body`; ausente = corpo vazio. */
  corpoSemPrevia?: string;
  /** A opção da empresa, quando o produtor já a tem; senão é lida do servidor. */
  conteudo?: ConteudoNaTelaBloqueada;
}

/** A opção da empresa para a bandeja. Sem resposta válida, `oculto`. */
async function conteudoDaBandeja(): Promise<ConteudoNaTelaBloqueada> {
  try {
    const r = await fetch("/api/v1/notifications/push", { credentials: "include" });
    if (!r.ok) return "oculto";
    const json = (await r.json()) as { data?: { conteudo?: unknown } | null };
    const conteudo = conteudoNaTelaBloqueadaWriteSchema.safeParse(json.data?.conteudo);
    return conteudo.success ? conteudo.data : "oculto";
  } catch {
    return "oculto";
  }
}

export function entregarAviso(input: EntregarAvisoInput): void {
  // Mesmo padrão de showApiError: a chave do dicionário é o PT; sem `t()` o
  // toast da esquina fica em português mesmo com idioma=es (e as chaves de CRM
  // já existiam — o bug era não passar por traduzir).
  const idioma = idiomaAtual();
  const title = traduzir(input.title, idioma);
  const body = traduzir(input.body, idioma);
  const href = input.href;

  if (canalLigado(input.category, "in_app")) {
    // O aviso já carrega o destino (`href`); sem ação, o toast dizia "nova
    // mensagem" e deixava a pessoa procurando a conversa na mão. Com ação, ele
    // leva direto para lá. Sem destino, não inventa botão: um botão morto é
    // pior que nenhum.
    toast(title, {
      description: body,
      action: href
        ? {
            label: traduzir("Abrir conversa", idioma),
            onClick: () => {
              window.location.assign(href);
            },
          }
        : undefined,
    });
  }
  if (canalLigado(input.category, "push")) {
    // O toast fica dentro do app aberto; a bandeja aparece fora dele e segue a
    // opção da empresa, como o push do servidor (`./web_push.ts`).
    void (async () => {
      const conteudo = input.conteudo ?? (await conteudoDaBandeja());
      const bandeja = redigirParaATelaBloqueada(
        { title: input.title, body: input.body, corpoSemPrevia: input.corpoSemPrevia, icon: input.icon },
        conteudo,
        idioma,
      );
      emitNotification({
        kind: input.kind,
        title: traduzir(bandeja.title, idioma),
        body: traduzir(bandeja.body, idioma),
        tag: input.tag,
        href: input.href,
        icon: bandeja.icon,
        force: true,
      });
    })();
  }
}

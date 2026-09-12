import { toast } from "sonner";

import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";
import { emitNotification } from "./emit";
import type { NotifyKind } from "./kinds";
import { canalLigado, type NotifyCategory } from "./prefs";

export interface EntregarAvisoInput {
  category: NotifyCategory;
  kind: NotifyKind;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  icon?: string;
}

export function entregarAviso(input: EntregarAvisoInput): void {
  // Mesmo padrão de showApiError: a chave do dicionário é o PT; sem `t()` o
  // toast da esquina fica em português mesmo com idioma=es (e as chaves de CRM
  // já existiam — o bug era não passar por traduzir).
  const idioma = idiomaAtual();
  const title = traduzir(input.title, idioma);
  const body = traduzir(input.body, idioma);

  if (canalLigado(input.category, "in_app")) {
    toast(title, { description: body });
  }
  if (canalLigado(input.category, "push")) {
    emitNotification({
      kind: input.kind,
      title,
      body,
      tag: input.tag,
      href: input.href,
      icon: input.icon,
      force: true,
    });
  }
}

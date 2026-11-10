/**
 * O TÍTULO DA ABA DAS TELAS DE ACESSO, no idioma do visitante.
 *
 * As páginas do grupo `(public)` declaravam `export const metadata = { title: "Entrar" }`: um objeto fixo, montado
 * antes de qualquer requisição, que não tem como saber o idioma de quem abre. Com o navegador em espanhol, o corpo do
 * login saía em espanhol e a aba seguia « Entrar · Marca » — a primeira coisa que o visitante lê, e a que fica na
 * barra de favoritos.
 *
 * O idioma é o MESMO do corpo da página e da casca, pela mesma expressão de `app/(public)/layout.tsx` e de cada página:
 * `idiomaDoVisitante` sobre o `locale` do perfil, se há sessão; sem ela, o que ele decide para quem chega. Custa uma
 * ida a mais ao GoTrue por tela pública — a casca e a página já fazem uma cada, sem `cache` partilhado entre elas, e
 * juntar as três pediria mexer no corpo das sete páginas.
 *
 * O título chega como função que recebe o tradutor — `tituloDaTelaPublica((t) => t("Entrar"))` —, e não como texto:
 * assim o literal mora na página, onde a cerca `i18n-espanhol-cobre-a-tela` o vê. Um `traduzir(titulo)` aqui dentro
 * seria `t()` sobre parâmetro livre, que ela reprova.
 */
import type { Metadata } from "next";

import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaDoVisitante } from "@/lib/i18n/idiomaAnonimo";
import { createClient } from "@/lib/supabase/server";

async function idiomaDaTelaPublica() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return idiomaDoVisitante((user?.user_metadata?.locale as string | undefined) ?? null);
}

export async function tituloDaTelaPublica(titulo: (t: (texto: string) => string) => string): Promise<Metadata> {
  const idioma = await idiomaDaTelaPublica();
  return { title: titulo((texto) => traduzir(texto, idioma)) };
}

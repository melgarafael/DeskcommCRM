/**
 * A recusa do `PATCH settings/task-plans`, em frase de quem preenche a tela.
 *
 * A rota devolve 422 com `details` = `{ "<caminho>": "<mensagem do zod>" }`,
 * onde o caminho é o índice na LISTA de planos ("0.descricao",
 * "2.passos.1.titulo"; "raiz" para a lista inteira). A tela mostrava só
 * "Dados inválidos.", e quem passava do limite da descrição não tinha como
 * saber o que corrigir.
 *
 * Só o CAMPO decide a frase, nunca a mensagem do zod (que é inglês e muda de
 * versão). Os campos vazios a tela barra antes de enviar, então o que chega
 * aqui é teto — e o teto vem de `LIMITES_DO_PLANO`, o mesmo do schema.
 * Caminho desconhecido devolve `null`: quem chama mostra a mensagem genérica.
 */
import { LIMITES_DO_PLANO } from "@/lib/tarefas/limites-do-plano";

/** Também usada pela tela antes de enviar, para as duas portas falarem igual. */
export function frasePrazoDoPasso(t: (texto: string) => string, passo: number): string {
  return t("O prazo do passo {p} precisa ser um número inteiro de dias, de 0 a {n}.")
    .replace("{p}", String(passo))
    .replace("{n}", String(LIMITES_DO_PLANO.venceEmDias));
}

export function explicarRecusaDoPlano(
  details: Record<string, unknown> | undefined,
  t: (texto: string) => string,
): string | null {
  for (const caminho of Object.keys(details ?? {})) {
    if (caminho === "raiz") {
      return t("Cabem no máximo {n} planos por organização.").replace(
        "{n}",
        String(LIMITES_DO_PLANO.planos),
      );
    }

    const [, campo, indice, campoDoPasso] = caminho.split(".");
    if (campo === "nome") {
      return t("O nome do plano pode ter até {n} caracteres.").replace(
        "{n}",
        String(LIMITES_DO_PLANO.nome),
      );
    }
    if (campo === "descricao") {
      return t("A descrição do plano pode ter até {n} caracteres.").replace(
        "{n}",
        String(LIMITES_DO_PLANO.descricao),
      );
    }
    if (campo !== "passos") continue;
    if (indice === undefined) {
      return t("O plano pode ter no máximo {n} passos.").replace(
        "{n}",
        String(LIMITES_DO_PLANO.passos),
      );
    }

    const passo = Number(indice) + 1;
    if (campoDoPasso === "titulo") {
      return t("O título do passo {p} pode ter até {n} caracteres.")
        .replace("{p}", String(passo))
        .replace("{n}", String(LIMITES_DO_PLANO.tituloDoPasso));
    }
    if (campoDoPasso === "descricao") {
      return t("A descrição do passo {p} pode ter até {n} caracteres.")
        .replace("{p}", String(passo))
        .replace("{n}", String(LIMITES_DO_PLANO.descricaoDoPasso));
    }
    if (campoDoPasso === "vence_em_dias") return frasePrazoDoPasso(t, passo);
  }
  return null;
}

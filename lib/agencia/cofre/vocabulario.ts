/**
 * O vocabulário do cofre de acessos (docs/agencia/SPEC-cofre-e-formulario.md).
 * Separado de `cofre.ts` porque a tela importa daqui, e `cofre.ts` mexe com a
 * chave de cifra — que nunca vai para o navegador.
 */
import { ROTULO_DA_PLATAFORMA } from "../formulario/perguntas";

export const PLATAFORMAS_DO_COFRE = ["instagram", "facebook", "google", "tiktok", "youtube", "site", "email", "outro"] as const;
export type PlataformaDoCofre = (typeof PLATAFORMAS_DO_COFRE)[number];

export const ROTULO_DA_PLATAFORMA_DO_COFRE: Record<PlataformaDoCofre, string> = {
  ...ROTULO_DA_PLATAFORMA,
  youtube: "YouTube",
  site: "Site / hospedagem",
  email: "E-mail",
  outro: "Outro",
};

/** Um item do cofre como a tela recebe: SEM a senha, só se ela existe. */
export interface ItemDoCofre {
  id: string;
  plataforma: PlataformaDoCofre;
  rotulo: string;
  login: string | null;
  extra: string | null;
  temSenha: boolean;
  origem: "formulario" | "manual";
  atualizadoEm: string;
  ultimaVisualizacao: { quem: string | null; quando: string } | null;
}

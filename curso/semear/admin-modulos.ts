/**
 * Semente do módulo Módulos (Admin) (/admin/modulos).
 *
 * A tela tem dois estados por cartão: sem instalar (botão "Instalar") e instalado
 * (selo "Instalado", sem botão). Para as duas lições mostrarem os dois, "Comandas"
 * (slug `financeiro`) aparece instalado e "Honorários (advocacia)" não.
 *
 * ponytail: grava SÓ a linha do registro, e não chama fn_modulo_instalar de
 * propósito. A instalação de verdade cria tabelas e liga uma chave do caixa
 * (`fn_financeiro_ligar_caixa_a_comanda`) que NÃO somem quando a base devolve
 * `modulos_instalados` ao estado de fábrica — mudaria o banco de todos os outros
 * módulos. A linha basta para esta tela, que só lê `modulos_instalados`
 * (lib/modulos/service.ts → listarModulos), e para o hub do CRM mostrar a porta.
 * A base apaga a linha antes da lição seguinte.
 */
import { type Contexto, ha, semErro } from "../semear-demonstracao";

export async function semear(c: Contexto) {
  semErro(
    await c.db.from("modulos_instalados").upsert(
      {
        modulo: "financeiro",
        estado: "ativo",
        instalado_em: ha(3 * 24 * 60),
        instalado_por: c.pessoa.helena,
        reaplicado_em: ha(3 * 24 * 60),
        motivo_suspensao: null,
      },
      { onConflict: "modulo" },
    ),
    "módulo Comandas instalado",
  );
}

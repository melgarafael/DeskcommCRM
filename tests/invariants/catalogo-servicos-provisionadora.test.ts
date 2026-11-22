/**
 * A provisionadora do módulo de catálogo de serviços (ADR-0002, D2/D4/D5).
 *
 * RLS própria: leitura da organização e nenhuma escrita de sessão — a escrita é
 * `fn_catalogo_servicos_salvar`, que trava a família. E o núcleo intocado: o
 * molde compara `catalog_products` antes e depois de provisionar, que é a regra
 * que a versão com colunas no catálogo (0774) violava.
 */
import { moldeDeProvisionadora } from "./molde-de-provisionadora";

moldeDeProvisionadora({
  modulo: "catalogo_servicos",
  tabelas: ["catalog_service_details"],
  protecaoPropria: ["catalog_service_details"],
});

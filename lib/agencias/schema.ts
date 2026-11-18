import { tenantCreationFields } from "@/lib/schemas/tenant-creation";
import { z } from "zod";

export { configuracaoAgenciaSchema, type ConfiguracaoAgencia } from "./configuracao";

export const criarClienteAgenciaSchema = z
  .object({ display_name: tenantCreationFields.display_name, slug: tenantCreationFields.slug })
  .strict();

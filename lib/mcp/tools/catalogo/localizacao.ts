import { declararTools } from "./tipos";

export const TOOLS_LOCALIZACAO = declararTools([{
  name: "crm_compare_city_distances",
  category: "read",
  rotulo: "Comparar cidades próximas",
  explicacao: "Consulta cidades brasileiras e compara a proximidade das cidades onde sua empresa tem lojas, sem exigir o endereço do cliente. A distância é em linha reta, não por estrada.",
  oQueToca: "Consulta de localização",
  risco: "seguro",
  pacotes: ["vender"],
}]);

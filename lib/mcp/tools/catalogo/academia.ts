import { declararTools } from "./tipos";

export const TOOLS_ACADEMIA = declararTools([
  {
    name: "crm_find_academia_classes",
    category: "read",
    rotulo: "Consultar a grade de aulas",
    explicacao:
      "Consulta dias, horários, público, professor e ambiente diretamente na grade semanal cadastrada da academia.",
    oQueToca: "Grade semanal da academia",
    risco: "seguro",
    pacotes: ["vender"],
  },
]);

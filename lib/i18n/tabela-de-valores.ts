/**
 * Textos da tabela de valores de negociação (#4612).
 *
 * A CHAVE é a frase em português, como no resto do dicionário. Nem todo texto
 * daqui é usado por uma tela ainda (a fatia 1 é API): os motivos de recusa são
 * o que a tela da importação vai mostrar linha a linha, e as frases de erro são
 * as que as rotas devolvem com `traduzir`.
 */
export const TEXTOS_TABELA_DE_VALORES = {
  // ── Motivos de recusa, um por linha da prévia ──────────────────────────
  "Sem o código do procedimento.": {
    en: "Missing the procedure code.",
    es: "Falta el código del procedimiento.",
  },
  "Sem a descrição do procedimento.": {
    en: "Missing the procedure description.",
    es: "Falta la descripción del procedimiento.",
  },
  "Sem valor de partida em US nem em reais.": {
    en: "No starting value in US units or in reais.",
    es: "Sin valor de partida en US ni en reales.",
  },
  "Valor não é um número válido.": {
    en: "Value is not a valid number.",
    es: "El valor no es un número válido.",
  },
  "Tem valor de partida sem valor limite (ou o contrário).": {
    en: "Has a starting value without a limit value (or the reverse).",
    es: "Tiene valor de partida sin valor límite (o al contrario).",
  },
  "O valor limite é menor que o valor de partida.": {
    en: "The limit value is lower than the starting value.",
    es: "El valor límite es menor que el valor de partida.",
  },
  "O código do procedimento se repete na planilha.": {
    en: "The procedure code is repeated in the spreadsheet.",
    es: "El código del procedimiento se repite en la planilla.",
  },
  "Este procedimento já está na tabela.": {
    en: "This procedure is already in the table.",
    es: "Este procedimiento ya está en la tabla.",
  },

  // ── Rotas ──────────────────────────────────────────────────────────────
  "Tabela de valores não encontrada.": {
    en: "Value table not found.",
    es: "Tabla de valores no encontrada.",
  },
  "Procedimento não encontrado nesta tabela.": {
    en: "Procedure not found in this table.",
    es: "Procedimiento no encontrado en esta tabla.",
  },
  "Envie um JSON com o nome da tabela.": {
    en: "Send a JSON body with the table name.",
    es: "Envíe un JSON con el nombre de la tabla.",
  },
  "Confira o nome da tabela.": {
    en: "Check the table name.",
    es: "Revise el nombre de la tabla.",
  },
  "Parâmetros inválidos.": {
    en: "Invalid parameters.",
    es: "Parámetros inválidos.",
  },
  "Criar tabela de valores exige a tela.": {
    en: "Creating a value table requires the screen.",
    es: "Crear una tabla de valores requiere la pantalla.",
  },
  "Importar planilha exige a tela.": {
    en: "Importing a spreadsheet requires the screen.",
    es: "Importar una planilla requiere la pantalla.",
  },
  "Arquivo grande demais (máximo de 2 MB).": {
    en: "File too large (2 MB maximum).",
    es: "Archivo demasiado grande (máximo de 2 MB).",
  },
  "Envie o formulário com o arquivo da planilha.": {
    en: "Send the form with the spreadsheet file.",
    es: "Envíe el formulario con el archivo de la planilla.",
  },
  "Envie o arquivo no campo 'file'.": {
    en: "Send the file in the 'file' field.",
    es: "Envíe el archivo en el campo 'file'.",
  },
  "Formato não suportado — envie .csv ou .xlsx.": {
    en: "Unsupported format — send .csv or .xlsx.",
    es: "Formato no soportado — envíe .csv o .xlsx.",
  },
  "Nenhuma linha da planilha pode entrar: confira o motivo de cada linha recusada.": {
    en: "No row from the spreadsheet can enter: check the reason for each rejected row.",
    es: "Ninguna fila de la planilla puede entrar: revise el motivo de cada fila rechazada.",
  },
  "Não foi possível importar a planilha. Tente novamente.": {
    en: "The spreadsheet could not be imported. Try again.",
    es: "No fue posible importar la planilla. Inténtelo de nuevo.",
  },
  // Recusas de `lerPlanilhaDaTabelaDeValores` que a rota passa por `t()`.
  "Máximo de 2000 linhas de dados por planilha.": {
    en: "Maximum of 2000 data rows per spreadsheet.",
    es: "Máximo de 2000 filas de datos por planilla.",
  },
  "A planilha não tem nenhuma coluna de valor. Use 'valor de partida' e 'valor limite', em reais ou em US (por exemplo: 'valor de partida (R$)' e 'valor limite (R$)').": {
    en: "The spreadsheet has no value column. Use 'valor de partida' and 'valor limite', in reais or in US (for example: 'valor de partida (R$)' and 'valor limite (R$)').",
    es: "La planilla no tiene ninguna columna de valor. Use 'valor de partida' y 'valor limite', en reales o en US (por ejemplo: 'valor de partida (R$)' y 'valor limite (R$)').",
  },
} as const;

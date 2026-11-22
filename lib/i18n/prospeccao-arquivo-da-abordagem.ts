/**
 * Textos do campo "Arquivo da primeira abordagem" da campanha de prospecção
 * (`components/prospecting/ArquivoDaAbordagem.tsx`, #4751). Num arquivo próprio
 * para não disputar linha com outras mudanças da prospecção no dicionário.
 * O aviso de risco reaproveita a chave que já existe no dicionário.
 *
 * As frases da ROTA de upload (`app/api/v1/prospecting/arquivo/route.ts`) moram
 * aqui também: `traduzir()` lê este mesmo dicionário, então o erro que a pessoa
 * lê na tela sai no idioma dela, sem uma segunda lista de textos.
 */
export const TEXTOS_PROSPECCAO_ARQUIVO_DA_ABORDAGEM = {
  "Arquivo da primeira abordagem": { es: "Archivo del primer abordaje" },
  "Sem arquivo: só texto": { es: "Sin archivo: solo texto" },
  "Arquivo já configurado": { es: "Archivo ya configurado" },
  "Imagem": { es: "Imagen" },
  "Vídeo": { es: "Video" },
  "PDF": { es: "PDF" },
  "Opcional. O arquivo vai junto da primeira mensagem, igual para todas as empresas da campanha. Aceita imagem (JPG, PNG ou WEBP, até 5 MB), vídeo (MP4, 3GP ou MOV, até 16 MB) ou PDF (até 50 MB).": {
    es: "Opcional. El archivo va junto con el primer mensaje, igual para todas las empresas de la campaña. Acepta imagen (JPG, PNG o WEBP, hasta 5 MB), video (MP4, 3GP o MOV, hasta 16 MB) o PDF (hasta 50 MB).",
  },
  "A lista mostra os arquivos que você já tem no CRM; para usar um arquivo novo, envie por aqui mesmo — o tipo é conferido pelos bytes antes de guardar.": {
    es: "La lista muestra los archivos que ya tienes en el CRM; para usar uno nuevo, súbelo aquí mismo — el tipo se comprueba por los bytes antes de guardar.",
  },
  "Enviar um arquivo do computador": { es: "Subir un archivo desde la computadora" },
  "Enviando o arquivo…": { es: "Subiendo el archivo…" },
  "Não foi possível enviar o arquivo.": { es: "No se pudo enviar el archivo." },
  "O arquivo precisa ser uma imagem (JPG, PNG ou WEBP), um vídeo (MP4, 3GP ou MOV) ou um PDF.": {
    es: "El archivo debe ser una imagen (JPG, PNG o WEBP), un video (MP4, 3GP o MOV) o un PDF.",
  },
  "O arquivo passa do tamanho máximo aceito para este tipo: imagem até 5 MB, vídeo até 16 MB ou PDF até 50 MB.": {
    es: "El archivo supera el tamaño máximo aceptado para este tipo: imagen hasta 5 MB, video hasta 16 MB o PDF hasta 50 MB.",
  },
  "O arquivo passa do tamanho máximo aceito.": {
    es: "El archivo supera el tamaño máximo aceptado.",
  },
  "Não foi possível guardar o arquivo. Tente novamente.": {
    es: "No se pudo guardar el archivo. Inténtalo de nuevo.",
  },
  "Abrir respostas rápidas": { es: "Abrir respuestas rápidas" },
  "Não apague o arquivo escolhido, nem a resposta rápida de onde ele vem, enquanto a campanha estiver ativa: sem o arquivo, a campanha pausa.": {
    es: "No borres el archivo elegido, ni la respuesta rápida de donde viene, mientras la campaña esté activa: sin el archivo, la campaña se pausa.",
  },
};

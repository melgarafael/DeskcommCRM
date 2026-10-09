---
impacto: capacidade_nova
secao: adicionado
titulo: O cartão de documento do Inbox mostra o nome original do arquivo, e não só a extensão
---

Quando um cliente mandava uma planilha ou um PDF, o cartão do documento no Inbox
mostrava só a extensão (`XLSX`, `PDF`), porque o nome que o cliente deu ao arquivo
não era guardado. Agora a entrada das mensagens guarda esse nome nas duas formas de
conectar o WhatsApp (a conexão por QR code e a API oficial), e o cartão passa a
mostrá-lo. O nome é limpo de caracteres invisíveis e limitado em tamanho; nome
comprido é encurtado na tela e aparece inteiro ao passar o mouse. Vale para os
documentos que chegarem depois da atualização: os que já estão no Inbox continuam
mostrando a extensão. Nada precisa ser feito ao atualizar. Contribuição de
@webtecnica (#2619), a partir da issue de @gleisaum (#2613).

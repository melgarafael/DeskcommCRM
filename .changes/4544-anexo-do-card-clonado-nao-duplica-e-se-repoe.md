---
impacto: nada_mudou
secao: corrigido
titulo: O anexo levado ao card em outro funil não duplica e volta se a primeira cópia falhou
---

Quando um negócio ganho abre a continuação em outro funil, os anexos do card de origem já iam junto. Rodar de novo duplicava os arquivos. Pior: se a primeira cópia falhasse (o armazenamento de arquivos fora por um instante), o anexo ficava fora do card novo para sempre. Agora cada cópia sabe de qual anexo veio. Repetir não duplica, e uma nova execução repõe o que faltou. Apagar o anexo de origem não apaga a cópia. Nenhuma ação é necessária na atualização.

Contribuição de @webtecnica (#4646).

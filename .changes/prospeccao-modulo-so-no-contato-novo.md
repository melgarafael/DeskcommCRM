---
impacto: nada_mudou
secao: corrigido
titulo: A prospecção só consulta o módulo "Empresas e pessoas" quando o contato é novo; quem já tem ficha não paga leitura
---

O envio de prospecção consultava a chave do módulo "Empresas e pessoas" e as tabelas de módulos em **todo** candidato abordado, antes de saber se o contato já existia. No caminho do contato reaproveitado o resultado dessa consulta nunca era usado — e, com o módulo ligado, a empresa podia ser criada sem que ninguém ficasse ligado a ela, já que o vínculo só acontece com o contato novo.

Agora a consulta acontece depois da decisão de criar o contato, e só nesse ramo. Quem já tem ficha volta a fazer zero leitura de configuração por envio, e a empresa só é criada quando existe contato para ligar a ela. Nada muda para quem usa a prospecção com o módulo desligado: contato, negócio e conversa, como antes.

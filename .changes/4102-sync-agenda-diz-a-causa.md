---
impacto: nada_mudou
secao: corrigido
titulo: "Sincronizar agenda" diz o motivo certo quando a opção "Guardar o histórico" está desligada
---

O "Sincronizar agenda do celular" dava o mesmo aviso para QUALQUER falha da
leitura da agenda: que o WhatsApp do número **não teria respondido** e que era
para conferir se ele estava conectado. Só que o caso mais comum não era queda
nenhuma — era a opção **"Guardar o histórico anterior à vinculação"** desligada,
com o número conectado o tempo todo. A pessoa ia conferir a conexão, não achava
defeito e ficava travada sem saber o que fazer.

Agora cada motivo tem a sua frase, e a da opção desligada diz o caminho: ligar
**"Guardar o histórico anterior à vinculação"** em Conexões e conectar o número
de novo. Sem essa opção o aparelho não entrega a agenda — insistir no botão não
resolve. Um timeout de verdade continua dizendo que o WhatsApp não respondeu;
sessão recusada pede reconectar; falha do servidor do canal pede tentar de novo
em instantes. O aviso fica na tela do diálogo, não só no toast, e a causa
técnica segue no log do servidor para o diagnóstico.

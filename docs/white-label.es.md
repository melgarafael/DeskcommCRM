<!-- traduzido-de: docs/white-label.md@d1b80ed7ac3f -->

[🇧🇷 Português](white-label.md) · [🇺🇸 English](white-label.en.md) · 🇪🇸 Español

# Instalar para clientes (agencias y revendedores)

Guía para quien instala SonghaiCRM **para otras empresas** — agencia, consultoría, revendedor — y cobra por ello.

La licencia es MIT: puedes modificarlo, alojarlo para terceros, revenderlo y cobrar lo que quieras. No hay regalías, no hay cláusula que prohíba el alojamiento comercial y no existe una versión de pago que bloquee funciones a tu cliente.

---

## Cambiar la marca

**Desde la pantalla, y sin reiniciar nada.** En `/admin/marca` cambias el **nombre del sistema** y el **color de la marca**. Guardas, recargas, y la interfaz entera ya está repintada — la barra lateral, los botones, el anillo de foco, el título de la pestaña y el icono del navegador.

El color es **derivado**, no aplicado en crudo: de un hex salen once tonos en los dos temas (claro y oscuro), con un piso de contraste calculado por papel y por superficie. Si el color que elegiste quedaría ilegible como texto de botón en el tema oscuro, el sistema recorre los peldaños necesarios y la pantalla **te muestra** en qué tono va a aterrizar cada cosa, antes de guardar. Nada de "elegí amarillo y el botón quedó blanco sobre blanco".

**El logo también.** En la misma pantalla **subes el archivo** — PNG o JPG, hasta 512 KB. Va al almacenamiento de tu propia instalación y pasa a valer al instante, sin reiniciar nada y sin que tengas que alojar la imagen en ningún sitio. Altura fija y ancho libre, para no deformar un arte de cualquier proporción; sin logo, el nombre aparece como texto.

El archivo se acepta **por sus bytes, no por su extensión**. Renombrar un `.svg` a `.png` no engaña: el sistema lee el contenido, lo rechaza y dice por qué. Esto no es quisquillosidad — SVG es XML y puede llevar script, que se ejecutaría si alguien abriera la imagen directamente por su dirección, en un bucket que es público por necesidad.

Quien prefiera alojarlo por su cuenta puede seguir haciéndolo, por el `.env`:

```bash
APP_LOGO_URL=https://cdn.tuempresa.com/logo.svg
```

Entre los dos, **el archivo subido desde la pantalla gana a la URL del `.env`** — quien lo subió expresó la elección más reciente. Y quitar el logo de una organización **devuelve el de la instalación**, no "ninguno": las capas caen una sobre otra en vez de borrarse.

### Las tres variables del `.env`, y su papel real

```bash
APP_NAME=Ventas Turbo CRM
APP_LOGO_URL=https://cdn.tuempresa.com/logo.svg
APP_ACCENT_HEX=#7a5cd6
```

El `install.sh` pregunta **dos** de ellas y las graba: el `APP_NAME` (Enter mantiene el valor por defecto) y el `APP_ACCENT_HEX` (Enter usa el color del sistema). No pregunta por `APP_LOGO_URL` — el camino normal del logo es subir el archivo desde la pantalla, y esa clave existe para quien prefiera alojarlo por su cuenta.

> El color se pide con validador: solo pasa `#` + 6 dígitos. Es más estrecho de lo que acepta la pantalla, y es a propósito — los **correos de acceso** (confirmación de cuenta y recuperación de contraseña) leen esa clave del `.env`, y solo reconocen esa forma. Un `#abc` o un `7a5cd6` pintaría la interfaz con tu color y dejaría el verde del producto en el primer correo que abre tu cliente.

> ⚠️ **Cambiar el color por la pantalla después NO reescribe los correos de acceso.** Su texto vive dentro de Supabase (GoTrue), no en el CRM, y quien lo empuja hasta allí es el `marca-emails.sh` — que lee el **`.env`**, no la base de datos. Para que los correos acompañen un color cambiado en `/admin/marca`: ajusta también el `APP_ACCENT_HEX` en el `.env` y ejecuta `bash self-host-kit/marca-emails.sh`. Por eso importa la entrevista del instalador: es el único momento en que las dos puntas nacen iguales sin que nadie necesite saber esto.

Qué son exactamente esas variables: **semilla y piso de rollback.**

- **Semilla** — en la primera lectura, lo que esté en el `.env` se graba en la base de datos. Así una instalación nueva ya nace con tu nombre.
- **Piso de rollback** — si vuelves a una versión anterior del sistema, el `agent.sh` revierte la **imagen**, no la **base de datos**. La marca que sobrevive a cualquier vuelta atrás es la que está en el `.env`.

Después de la primera lectura, **manda la base de datos**. Cambiar el color por la pantalla no pide `docker compose up -d`, no pide reinicio, no pide nada: la lectura se hace en cada carga de página, con una caché corta que la propia pantalla invalida al guardar.

### Por qué esto es configuración, y no una edición de código

Cambiar la marca editando los archivos fuente funciona **una vez**. En el siguiente `bash update.sh`, la imagen nueva sobrescribe el parche y la marca de tu cliente vuelve a ser la nuestra — normalmente sin que nadie lo note, hasta que lo ve el cliente.

La configuración sobrevive a toda actualización. Por eso la marca se lee en tiempo de ejecución y nunca se incrusta en la compilación: **una única imagen Docker sirve para cualquier marca**. Por la misma razón no existe "imagen con tu marca": el `update.sh` reescribe la línea `APP_IMAGE` del `.env` en cada actualización, y tu imagen sería sustituida por la nuestra en silencio, en una actualización de rutina.

---

## Marca por organización

**Una instalación atiende a varias organizaciones, y cada una puede tener su propia marca.** El admin de cada organización abre `Configurações → Marca` (`/app/settings/marca`) y define el **nombre**, el **color** y el **logo** de ella — sin necesitarte, y sin ver a las demás.

La frontera, que es deliberada:

| Dónde | Qué marca aparece |
|---|---|
| `/login`, registro, recuperación de contraseña, verificación en dos pasos | La de la **instalación** (la tuya) |
| Dentro del sistema (`/app/...`), después de entrar | La de la **organización**, si la tiene; si no, la de la instalación |
| Correos de acceso (confirmación de cuenta, recuperación de contraseña) | La de la **instalación** |
| Invitación de equipo, correos de LGPD | La de la **organización** que los envió |

El motivo de que el login quede fuera no es una limitación: **antes de que la persona entre, el sistema no sabe de qué organización es.** Pintar el login con el color de alguna de ellas sería elegir una a ciegas.

Esto no vuelve obsoleta la instalación dedicada — ver la comparación de abajo, que sigue valiendo por infraestructura, aislamiento y discurso de venta.

### Lo que todavía no es configurable

Directo, para que no lo descubras delante del cliente. Cada línea trae la razón medida, no la excusa:

- **Dominio por organización.** Una instalación, un dominio. No hay columna de dominio en el esquema, la bifurcación por host en `proxy.ts` es un NOOP declarado (existe solo como documentación de la topología pretendida), y en el Edge no hay base de datos que consultar antes de decidir a quién pertenece ese host. El cliente que exige su propio dominio pide **instalación dedicada**.
- **Tipografía.** La tipografía es la misma en toda instalación. `next/font` resuelve en tiempo de **build**, y la imagen que baja tu VPS ya viene construida — un selector de fuente en el panel guardaría un valor que nadie leería. (La fuente es la Atkinson Hyperlegible, elegida por el Braille Institute por legibilidad; cambiarla no altera la percepción de marca y empeora la lectura de quien pasa el día dentro del sistema.)
- **Tema.** El par claro/oscuro es del design system. Tu marca mueve el **accent** — lo que es acción, destaque y foco — y deliberadamente **no** mueve el fondo de la página: el fondo es el mismo en toda marca, y por eso el color de la barra del navegador también.
- **El informe de LGPD del titular no lleva tu marca — y es a propósito.** Ver la sección propia más abajo.
- **La alarma de presupuesto de IA** todavía sale con nuestra marca. Es la única fuga conocida, y se queda: hoy esa alarma no tiene ninguna programación conectada, así que arreglar su marca no cambiaría nada que alguien vea. Sale cuando la alarma tenga un cron de verdad.
- **Dos nombres técnicos no cambian**: la cabecera `X-Deskcomm-Signature` de los webhooks de salida y la cookie de sesión. El primero es un contrato con sistemas de terceros que ya verifican ese nombre; renombrarlo tumbaría la integración de un cliente **en silencio** — el receptor no da error, simplemente deja de reconocer.

---

## Los correos

### Los correos de acceso — el primer artefacto que recibe el cliente de tu cliente

La confirmación de cuenta y la recuperación de contraseña **no las envía el sistema**: quien las monta y las dispara es el servicio de autenticación de Supabase. Ningún código nuestro corre ahí dentro — es texto que hay que **empujar** hasta allá por API.

Por eso el kit trae un script propio:

```bash
bash self-host-kit/marca-emails.sh
```

Sube el asunto y el cuerpo de los dos correos con **tu** nombre y **tu** color, y de paso configura la dirección de retorno del enlace (que ningún script configuraba antes, y es requisito para que el enlace funcione). El `install.sh` lo llama solo, justo después de crear el proyecto Supabase; el `update.sh` también lo llama, para que una instalación antigua reciba esto en la primera actualización.

**Si no tiene la clave de acceso de la API de Supabase** (`SUPABASE_ACCESS_TOKEN`), no falla y no tumba la instalación: imprime exactamente qué hacer a mano en el panel de Supabase y sale con éxito. Ese es el caso de quien creó el proyecto por el panel y pegó las credenciales, en vez de dejar que lo creara el instalador.

> ⚠️ **Si vas a hacerlo a mano, atención al carácter.** El enlace de la plantilla tiene que llevar `&token_hash=`, con **`&`**, nunca `?`. Con `?` la dirección queda con dos signos de interrogación, el sistema pierde el token y el usuario cae en una pantalla que dice que el enlace expiró — cuando el problema es la plantilla. En ese caso el sistema ahora **nombra la causa** en vez de decir solo "enlace inválido".

### Invitación de equipo y correos de LGPD

Salen con la marca de la **organización** que los originó — porque quien procesó la solicitud, dentro del producto de tu cliente, es el sistema de tu cliente.

Para enviarlos, rellena las dos variables (el `install.sh` pregunta las dos):

```bash
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=no-responder@tuempresa.com
```

**La dirección tiene que ser de un dominio verificado en TU cuenta de Resend.** Ese es el único pedazo que la marca no resuelve: el nombre que aparece en la bandeja de entrada es la marca; la dirección es de quien aloja.

**Dejarlas en blanco es una elección soportada, no un defecto.** Sin ellas, el sistema no intenta enviar y no falla callado: la invitación muestra el enlace de aceptación **en la propia pantalla**, para que lo copies y lo mandes por donde quieras, y la exportación de LGPD queda pendiente de revisión en vez de desaparecer. Antes, una dirección en blanco hacía que todo envío fallara allá en Resend con un mensaje opaco, y el operador se iba a cazar red, contenedor y clave por culpa de una variable vacía.

### La dirección de soporte que ven tus clientes

```bash
SUPPORT_EMAIL=soporte@tuempresa.com
```

Aparece en las pantallas de cuenta suspendida y de cobro. **Vacío significa vacío:** la pantalla simplemente no muestra ninguna dirección — nunca cae de vuelta en la nuestra. En una pantalla de cuenta suspendida eso importa: quien suspendió fuiste tú, no nosotros.

---

## El informe de LGPD es lo único que NO lleva tu marca

Cuando un titular de datos ejerce el derecho del Art. 18 II de la LGPD — la ley brasileña de protección de datos —, el sistema genera un informe en PDF. Ese documento **no lleva marca ninguna** — ni la nuestra, ni la tuya, ni logo, ni color. Nombra al **controlador**: la razón social de la organización, más el encargado (DPO).

Esto es decisión de producto, no un ítem olvidado. En un documento que responde a un derecho legal, quien es nombrado responde por los datos. **Tú eres operador, no controlador.** Cambiar el nombre ahí por tu marca no sería "completar el whitelabel" — sería empeorar: hoy el nombre que aparecía era obviamente el del software, y después parecería la declaración de quien responde jurídicamente por los datos de esas personas.

**Lo que eso te pide en la instalación:** revisa la **Razão social** — la razón social — de cada organización en `Configurações → Empresa`. Nace igual al nombre comercial (es lo que el instalador tiene para darle), y un nombre comercial impreso como razón social en un documento jurídico es el tipo de error que solo aparece cuando alguien reclama.

El correo que entrega el enlace de la exportación es otra cosa y sí lleva la marca de la organización: dice quién **operó**. El PDF dice quién **responde**. Son papeles distintos, y por eso los dos cargan nombres distintos.

---

## ¿Un cliente por instalación, o todos en una sola?

El sistema es multi-tenant desde la primera línea: una instalación atiende a varias organizaciones, y el aislamiento entre ellas se verifica en el CI en cada cambio — un usuario de una organización no ve ninguna fila de otra. No es promesa de marketing: es el test `tests/invariants/rls-isolation.test.ts`, que crea dos organizaciones y prueba la no-filtración por el mismo camino de autenticación que usa producción.

Aun así, los dos modelos sirven a propósitos diferentes:

| | Una instalación por cliente | Una instalación para todos |
|---|---|---|
| **Marca** | La de cada cliente, incluso en la pantalla de entrada | La tuya en el login; la de cada organización dentro del sistema |
| **Coste de infraestructura** | Una VPS por cliente | Una VPS |
| **Fallo** | Aislado | Alcanza a todos |
| **Actualización** | Una por vez, se puede escalonar | Todos de una vez |
| **Datos del cliente** | Físicamente separados | Separados por RLS |
| **Mejor para** | Revender con la marca del cliente | Tu propia operación atendiendo varias cuentas |

Si tu cliente pregunta "¿dónde quedan mis datos?", la instalación dedicada tiene la respuesta más simple de dar — y de defender.

---

## El argumento jurídico que cierra ventas en Brasil

La **Resolución CD/ANPD nº 19/2024** volvió obligatorias las cláusulas contractuales estándar para la **transferencia internacional de datos personales**, con el plazo de adecuación cerrado el **23 de agosto de 2025**.

Todo cliente tuyo que use un CRM extranjero realiza esa transferencia y necesita el artefacto contractual. Alojando en una VPS en Brasil, **no hay transferencia internacional** — y la obligación no se aplica.

⚠️ **No lo vendas como "servidor en Brasil = conformidad con la LGPD".** Eso es falso y un abogado lo desmonta en la primera pregunta: la conformidad depende de base legal, finalidad, seguridad y derechos del titular. El argumento correcto y defendible es el de arriba: sin transferencia internacional, no hay exigencia de cláusulas estándar.

---

## Operación

Cada instalación trae los scripts en `self-host-kit/`:

| Comando | Qué hace |
|---|---|
| `bash update.sh` | Actualiza. Hace copia de seguridad de la base de datos **antes**, reaplica el esquema de forma idempotente y verifica la salud al final |
| `bash backup.sh` / `restore.sh` | Copia de seguridad y restauración |
| `bash reset-password.sh` | Redefine la contraseña de un usuario |
| `bash reset-mfa.sh` | Quita la verificación en dos pasos a quien perdió el aparato |
| `bash healthcheck.sh` | Diagnóstico de la instalación |

El `reset-mfa.sh` es el que más vas a usar: la verificación en dos pasos es obligatoria para administradores, y cambiar de móvil sin guardar los códigos de recuperación es la llamada de soporte más común.

---

## Requisitos por instalación

**4 GB de RAM recomendados** (la stack levanta con 2 GB, pero opera al límite — el WAHA usa ~150 MB por sesión de WhatsApp), puertos 80 y 443, Docker Compose v2 y un dominio con registro A apuntando a la IP. La VPS no compila nada — baja una imagen lista. El certificado HTTPS se emite automáticamente en el primer acceso.

Guía completa de instalación: [`self-host-kit/README.md`](../self-host-kit/README.md).

---

*Última actualización: 14 de agosto de 2026 — revisión completa después del épico de marca propia. Las dos frases más citadas de este documento ("colores, tipografías y tema no son configurables" y "la marca es por instalación, no por organización") dejaron de ser verdaderas y fueron reescritas con el límite honesto de hoy.*

*Este documento existe en tres idiomas, y el requisito que la versión anterior de este pie nombraba fue pagado: las traducciones llevan en la primera línea un sello con el hash del original, y editar `docs/white-label.md` sin volver a sellar reprueba `pnpm test:unit`. Después de traducir, vuelve a sellar con `pnpm exec tsx scripts/selar-traducao.ts --todas`.*

*Los tres README quedaron **fuera** del sello a propósito. Son el archivo más editado del repositorio: con sello, cada arreglo se volvería un PR bloqueado hasta que ~490 líneas fueran retraducidas dos veces — y el desenlace realista de eso no es traducción al día, es alguien volviendo a sellar sin traducir, que es la única manera de que el sello muera. Entran cuando alguien quiera pagar ese coste con los ojos abiertos.*

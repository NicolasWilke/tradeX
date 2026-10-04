# TradeX — Guía de monetización

Cómo poner en marcha los planes, cobros y herramientas de crecimiento que se agregaron al sitio, y qué tiene que hacer el equipo cada semana.

## Qué cambió

| Área | Qué hace ahora |
|---|---|
| **Planes** | Empresas compradoras: **Gratis** (RFQ ilimitadas) y **Enterprise** (desde USD 800/mes). Proveedores: **Gratis**, **Destacado** (USD 49/mes o USD 490/año) y **Por cotización** (USD 8 c/u). Add-ons: Verificación (USD 150/año), Publicación patrocinada (USD 25/semana), Matching asistido (USD 300). |
| **Contacto** | Cualquier empresa compradora registrada ve el contacto de los proveedores **Destacados**. Eso es lo que paga el Destacado. |
| **Directorio** | Los Destacados aparecen primero, con badge. También primero en "Empresas sugeridas". |
| **Cotizaciones** | El botón "Cotizar ahora" funciona. Proveedor Gratis: 3 cotizaciones por mes; después ve el upsell. El comprador ve todas las cotizaciones de sus RFQ. |
| **Mi rendimiento** | Panel con vistas de perfil, vistas de contacto, cotizaciones, oportunidades del mes, checklist de perfil y progreso de la garantía. El plan Gratis ve cuántos lo miraron pero no quiénes. |
| **Garantía 30 días** | Si en sus primeros 30 días como Destacado ninguna empresa ve su contacto, el mes siguiente es gratis. Se mide con las vistas de contacto reales. |
| **Reclamá tu perfil** | Las fichas armadas con fuentes públicas muestran "¿Trabajás en X? Reclamá esta ficha". Link directo: `https://tradexcorp.netlify.app/#reclamar=<id>`. |
| **Licitaciones públicas** | Pestaña nueva en Oportunidades. Gratis ve la muestra semanal (3); los planes pagos ven todas, filtradas por rubro. |
| **Patrocinadas** | Un post con `sponsoredUntil` en el futuro queda fijo arriba del feed con la etiqueta "Patrocinado". |

## Paso 1 — Publicar sin cobros automáticos (se puede hacer hoy)

1. **Reglas de Firestore**: copiá `firestore.rules` en Firebase Console → Firestore Database → Reglas → Publicar. *Sin este paso, las cotizaciones, el panel y los reclamos fallan con "Missing or insufficient permissions".*
2. **Sitio**: subí los cambios a GitHub y que Netlify despliegue como siempre.
3. Con `PAYMENTS_ENABLED = false` (en `js/main.js`), cada click en un plan pago guarda un documento en la colección **planRequests** y le muestra al usuario "te escribimos en 24 h hábiles".

### Activar un plan a mano

En Firebase Console → Firestore → `companies/{id de la empresa}`, editá:

- `plan`: `destacado`, `porcotizacion` o `enterprise`
- `planSince`: tipo *timestamp*, fecha de hoy (arranca la garantía de 30 días)
- `planBilling`: `mensual` o `anual`

Para dar de baja, volvé `plan` a `gratis`. El cobro en este modo lo hacés vos con un link de pago de Mercado Pago.

## Paso 2 — Cobros automáticos con Mercado Pago

Necesitás el plan **Blaze** de Firebase (pago por uso; con este volumen el costo es de centavos) y [Firebase CLI](https://firebase.google.com/docs/cli) instalado (`npm install -g firebase-tools`, después `firebase login`).

1. En Mercado Pago → Tus integraciones → Crear aplicación → copiá el **Access Token de producción**.
2. Desde la carpeta del proyecto:

   ```
   cd functions
   npm install
   cd ..
   firebase functions:secrets:set MP_ACCESS_TOKEN
   firebase functions:secrets:set MP_WEBHOOK_SECRET
   firebase functions:secrets:set RESEND_API_KEY
   firebase deploy --only functions
   ```

   - Si todavía no tenés el secreto del webhook o la API key de mails, cargá un guion (`-`) y quedan desactivados.
   - El deploy te va a pedir los montos en pesos: `PRECIO_DESTACADO_MENSUAL_ARS`, `PRECIO_DESTACADO_ANUAL_ARS` y `PRECIO_VERIFICACION_ARS`. Mercado Pago Argentina cobra suscripciones en ARS: convertí los USD 49 / 490 / 150 al tipo de cambio que elijas y actualizalos con un nuevo deploy cuando haga falta.
3. Copiá la URL de la función **mpWebhook** que muestra el deploy y cargala en Mercado Pago → Tu aplicación → Webhooks, con los eventos **Planes y suscripciones** y **Pagos**. Mercado Pago te da ahí la clave secreta: guardala con `firebase functions:secrets:set MP_WEBHOOK_SECRET` y volvé a deployar.
4. En `js/main.js` cambiá `var PAYMENTS_ENABLED = false;` por `true` y publicá el sitio.

Desde ese momento, "Destacar mi perfil" lleva al checkout de Mercado Pago. Cuando el pago se aprueba, el webhook pone `plan: "destacado"` solo. Si el cliente cancela la suscripción, vuelve a `gratis`. Si algo falla, el pedido igual queda en **planRequests**, así no se pierde la venta.

Probalo primero con las credenciales de **prueba** de Mercado Pago y un usuario de prueba antes de usar las de producción.

## Paso 3 — Mails (opcional pero recomendado)

Las funciones mandan mails con [Resend](https://resend.com), que es gratis hasta 3.000 mails por mes:

- **avisoNuevaRfq**: cada RFQ nueva se avisa por mail a todos los Destacados.
- **reporteMensual**: el día 1 a las 9 hs cada cuenta paga recibe su resumen del mes anterior.

Creá la cuenta, verificá tu dominio, cargá la API key (`firebase functions:secrets:set RESEND_API_KEY`) y el remitente (parámetro `EMAIL_FROM`, por ejemplo `TradeX <hola@tudominio.com>`).

## Rutina del equipo

| Cuándo | Tarea | Dónde |
|---|---|---|
| Todos los días | Responder pedidos de plan y add-ons | Colección `planRequests` (status `pendiente`) |
| Todos los días | Revisar reclamos de ficha | Colección `claims` (ver abajo) |
| Semanal | Cargar licitaciones nuevas | `scripts/cargar-licitaciones.mjs` (ver abajo) |
| Semanal | Mandar 20–50 mails de "Reclamá tu perfil" | `scripts/links-reclamo.mjs` + `docs/email-reclamo-perfil.md` |
| Mensual (día 1) | Bonificar garantías | Colección `garantias` (status `aplica`) |
| Por pedido | Verificación pagada | Colección `verificaciones`: pedir CUIT y habilitaciones, y poner `verificada: true` en la empresa |
| Por pedido | Publicación patrocinada | En `posts/{id}` agregar `sponsoredUntil` (timestamp de fin) |

### Aprobar un reclamo de ficha

Quien reclama ya tiene su propia cuenta (se registró para reclamar). Para aprobar:

1. Verificá que la persona trabaje ahí: email con el dominio de la empresa, LinkedIn o llamado.
2. Copiá a su documento `companies/{uid}` lo útil de la ficha original (`descripcion`, `fuente`, `evidencia`).
3. En la ficha original poné `claimedBy: "{uid}"`; deja de mostrar el recuadro. Si querés evitar duplicados en el directorio, borrala.
4. En `claims/{id}` cambiá `status` a `aprobado` (o `rechazado`). La persona lo ve en la ficha.

### Cargar licitaciones

Una vez: en Firebase Console → Configuración del proyecto → Cuentas de servicio → **Generar nueva clave privada**. Guardá el JSON fuera del repositorio y nunca lo subas a GitHub.

```
cd scripts
npm install
set GOOGLE_APPLICATION_CREDENTIALS=C:\ruta\a\clave.json
node cargar-licitaciones.mjs licitaciones.json --cerrar-vencidas
```

`licitaciones.json` sigue el formato de `licitaciones-plantilla.json`. Las fuentes más útiles para el nicho energía son COMPR.AR, los portales de compras de Neuquén y Río Negro, y los registros de proveedores de las operadoras. Cargar la misma URL dos veces no duplica nada.

## Límites a tener en cuenta

- **El tope de 3 cotizaciones del plan Gratis se controla en la app**, no en las reglas (Firestore no puede contar documentos). Alguien con conocimientos técnicos podría saltearlo. Para un marketplace chico alcanza; si se vuelve un problema, se pasa la creación de cotizaciones a una Cloud Function.
- **La garantía se bonifica a mano** en Mercado Pago (pausar un mes o devolver el cobro). La función solo marca a quién le corresponde.
- **"Por cotización", Enterprise, patrocinadas y matching** se venden por pedido (planRequests). Solo Destacado y Verificación tienen checkout automático.
- **Términos y condiciones**: conviene sumar a `terminos.html` los precios, la garantía y la política de baja antes de cobrar.
- Al cambiar de plan desde la consola, la app lo refleja sola en segundos (el directorio escucha cambios en vivo).

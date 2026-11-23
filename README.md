# FacturaPRO

Sistema local de facturación comercial con backend Node.js y base de datos PostgreSQL en Supabase.

## Requisitos

- Node.js 22.13 o posterior.
- Un proyecto Supabase.

## Configuración de Supabase

1. En el SQL Editor de Supabase, ejecuta [`supabase/schema.sql`](./supabase/schema.sql).
2. Copia `.env.example` a `.env`.
3. Configura `SUPABASE_URL` con la URL del proyecto y `SUPABASE_SERVICE_ROLE_KEY` con la clave secreta de servidor de **Project Settings → API Keys**. No uses la clave `anon`/publishable.
4. No compartas la clave `service_role` ni la guardes en el frontend. `.env` está excluido de Git; mantenlo privado.
5. Antes de crear la primera cuenta administradora, configura `FACTURAPRO_SETUP_TOKEN` en `.env` con un valor aleatorio privado de al menos 32 caracteres. No lo compartas ni lo guardes en el frontend o en Git. No es necesario si ya existe una cuenta.
6. Si ya tienes `data/facturapro.sqlite` con tu cuenta o datos SQLite, ejecuta `npm run migrate:sqlite`. El proceso importa el hash de contraseña, la configuración y facturas faltantes sin copiar la contraseña en texto plano ni reemplazar registros existentes.
7. Inicia el sistema con `npm start` y abre <http://127.0.0.1:3000>. El comando compila el CSS de Tailwind antes de iniciar el backend. No uses la vista previa de Live Server de VS Code (por ejemplo, el puerto 3317): sirve archivos estáticos y no incluye las rutas `/api`.

El servidor verifica la conexión y las tablas de Supabase antes de iniciar. Solo puede escuchar en `127.0.0.1`, `::1` o `localhost`; no lo expongas mediante un proxy o túnel si quieres mantenerlo solo para ti. Cuando aún no existe administrador, el token configurado se acepta durante 15 minutos en instalaciones locales y nunca se imprime en logs. Si falta, el servidor no inicia y solicita configurarlo en `.env`.

El inicio de sesión permanece en el backend: las contraseñas se derivan con scrypt y las sesiones usan cookies HttpOnly/SameSite, con `Secure` si la conexión es HTTPS. Las tablas tienen RLS habilitado y solo el backend, con la clave secreta, tiene acceso.

El servidor local revisa los vencimientos al iniciar y cada día a medianoche de Panamá. Para despliegues en Vercel, configura `CRON_SECRET` con un valor privado aleatorio de al menos 32 caracteres. Para enviar los PDF por correo, configura `RESEND_API_KEY` y `RESEND_FROM_EMAIL` con una dirección remitente verificada en Resend. Mantén estos valores solo en el servidor.

La importación desde `localStorage` de la versión anterior sigue disponible al iniciar sesión. Ejecuta `npm test` para probar autenticación, facturas y persistencia usando un servicio Supabase simulado.

En **Configuración de pagos** puedes guardar instrucciones para cada método disponible (ACH, Yappy, efectivo, tarjetas y crédito). Se conservan en Supabase y el método seleccionado añade automáticamente sus instrucciones a la factura y al PDF. Los datos ACH guardados anteriormente se conservan.

Al iniciar sesión, el panel principal permite abrir **Facturación**, **Historial**, **Clientes**, **Reportes**, **Cuentas por cobrar**, **Configuración de pagos** y **Contratos y cobros recurrentes**. También muestra los importes facturados, cobrados y pendientes, junto con un gráfico de barras de la facturación de los últimos seis meses; las facturas anuladas no se incluyen en los importes.

El módulo **Clientes** permite ver todos los datos de cada cliente y exportar el catálogo completo o un cliente individual. **Historial**, **Reportes** y **Cuentas por cobrar** permiten ver los detalles de las facturas y exportar sus datos, incluidos los renglones y totales, en CSV o PDF. Los reportes respetan los filtros seleccionados y las cuentas por cobrar solo incluyen facturas pendientes. El panel principal, los datos del emisor y la configuración de pagos también se pueden exportar en CSV o PDF. Las descargas PDF abren el diálogo de impresión del navegador; selecciona **Guardar como PDF** para guardar el archivo. Las exportaciones CSV protegen los valores que podrían interpretarse como fórmulas.

**Cuentas por cobrar** agrupa facturas pendientes por vencimiento (al día, 1–30, 31–60 y más de 60 días); las que no tienen fecha de vencimiento se muestran aparte. **Contratos y cobros recurrentes** permite registrar vigencia, intervalo de 1 a 30 días o un plan anual de 365 días, y monto base por período; imprimir el contrato y activar los cobros por separado. Puedes elegir por contrato si se generan facturas en la fecha de vencimiento, si se aplica ITBMS del 7% y si la factura PDF se envía al correo del cliente. También puedes generar y enviar manualmente la factura del próximo período activo; la identidad del contrato y vencimiento evita duplicados. El módulo muestra el conteo de facturas por contrato y un historial filtrable con el estado del correo. Si falla un envío, el historial permite reintentarlo. Clientes, contratos, cobros y facturas se guardan en Supabase.

## Inicio automático en Linux

El servicio de usuario de systemd en `deploy/systemd/facturapro.service` inicia FacturaPro al comenzar tu sesión. Instálalo y actívalo con:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd/facturapro.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now facturapro.service
```

Consulta el estado con `systemctl --user status facturapro.service` y los registros con `journalctl --user -u facturapro.service`. El servicio carga las variables locales desde `.env`; el archivo no se copia ni se versiona.

## Desplegar en Vercel

1. En Vercel, importa `Thekila1884/FacturaPRO` desde GitHub y usa la rama `main`.
2. En **Settings → Environment Variables**, agrega `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` para Production (y Preview si lo necesitas). Para procesar contratos, configura `CRON_SECRET` (mínimo 32 caracteres); para enviar correos, agrega `RESEND_API_KEY` y `RESEND_FROM_EMAIL` con un remitente verificado en Resend. No subas `.env` a GitHub.
3. Vuelve a ejecutar el contenido actualizado de [`supabase/schema.sql`](./supabase/schema.sql) en el SQL Editor de Supabase; agrega las tablas de sesiones y los procedimientos de limitación de intentos.
4. Despliega. El comando `npm run build` compila Tailwind y prepara `public/` como carpeta de salida; `vercel.json` la declara, publica el HTML en `/` y reescribe `/api/*` a la función `api/index.mjs`.

Las sesiones, el bloqueo de intentos y la programación diaria de facturas funcionan en Vercel. El cron procesa vencimientos a las 00:00 de Panamá (05:00 UTC). Como la cuenta administradora ya fue migrada, la configuración inicial no debería aparecer. Si despliegas sin una cuenta existente, configura `FACTURAPRO_SETUP_TOKEN` como variable de entorno de Vercel (mínimo 32 caracteres) antes de crearla.

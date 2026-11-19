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
5. Si ya tienes `data/facturapro.sqlite` con tu cuenta o datos SQLite, ejecuta `npm run migrate:sqlite`. El proceso importa el hash de contraseña, la configuración y facturas faltantes sin copiar la contraseña en texto plano ni reemplazar registros existentes.
6. Inicia el sistema con `npm start` y abre <http://127.0.0.1:3000>.

El servidor verifica la conexión y las tablas de Supabase antes de iniciar. Solo puede escuchar en `127.0.0.1`, `::1` o `localhost`; no lo expongas mediante un proxy o túnel si quieres mantenerlo solo para ti. Cuando aún no existe administrador, el servidor muestra en la terminal un código de configuración de un solo uso, válido por 15 minutos. Ingrésalo en la pantalla de configuración inicial; reinicia el servidor para generar otro si vence.

El inicio de sesión permanece en el backend: las contraseñas se derivan con scrypt y las sesiones usan cookies HttpOnly/SameSite, con `Secure` si la conexión es HTTPS. Las tablas tienen RLS habilitado y solo el backend, con la clave secreta, tiene acceso.

La importación desde `localStorage` de la versión anterior sigue disponible al iniciar sesión. Ejecuta `npm test` para probar autenticación, facturas y persistencia usando un servicio Supabase simulado.

import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(root, 'sistema_de_facturaci_n_comercial_panam_usd_itbms.html');
const cssPath = join(root, 'tailwind.css');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionDurationMs = 8 * 60 * 60 * 1000;
const configuredSetupToken = process.env.FACTURAPRO_SETUP_TOKEN;
const setupToken = configuredSetupToken || randomBytes(32).toString('base64url');
let setupTokenExpiresAt = process.env.VERCEL === '1' && configuredSetupToken
    ? Number.POSITIVE_INFINITY
    : 0;
let setupTokenUsed = false;

if (process.env.VERCEL !== '1' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('FacturaPro es local y solo puede escuchar en localhost, 127.0.0.1 o ::1.');
}
if (configuredSetupToken && configuredSetupToken.length < 32) {
    throw new Error('FACTURAPRO_SETUP_TOKEN debe tener al menos 32 caracteres.');
}
if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el archivo .env.');
}
const supabaseOrigin = new URL(supabaseUrl);
if (supabaseOrigin.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '::1'].includes(supabaseOrigin.hostname)) {
    throw new Error('SUPABASE_URL debe usar HTTPS.');
}

const defaultIssuer = {
    name: 'Servicios Empresariales Istmo, S.A.',
    ruc: '155712345-2-2024',
    dv: '52',
    phone: '+507 6234-5678',
    email: 'facturacion@istmoservicios.com.pa',
    address: 'Ciudad de Panamá, Ave. Balboa, Torre Financial, Of. 802',
    achDetails: ''
};

function jsonResponse(response, status, data, headers = {}) {
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers
    });
    response.end(JSON.stringify(data));
}

function readCookies(request) {
    return Object.fromEntries((request.headers.cookie || '').split(';').map(part => {
        const index = part.indexOf('=');
        return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(([key]) => key));
}

async function getSession(request) {
    const token = readCookies(request).facturapro_session;
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const rows = await supabaseRequest(
        'facturapro_sessions',
        `select=token_hash,expires_at&token_hash=eq.${tokenHash}&limit=1`
    );
    const session = rows[0];
    if (!session) return null;
    if (!Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now()) {
        await deleteSession(tokenHash);
        return null;
    }
    return { tokenHash };
}

function isSecureRequest(request) {
    if (request.socket.encrypted) return true;
    const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim().toLowerCase();
    const loopbackPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
    return forwardedProtocol === 'https' && (loopbackPeer || process.env.VERCEL === '1');
}

function sessionCookie(token, maxAge, secure) {
    return `facturapro_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function checkOrigin(request) {
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) {
        const error = new Error('Origen de solicitud no permitido.');
        error.status = 403;
        throw error;
    }
}

async function readJson(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) {
            const error = new Error('La solicitud supera el tamaño permitido.');
            error.status = 413;
            throw error;
        }
    }
    try {
        return body ? JSON.parse(body) : {};
    } catch {
        const error = new Error('El cuerpo de la solicitud no es JSON válido.');
        error.status = 400;
        throw error;
    }
}

function validateIssuer(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        const error = new Error('La configuración de la empresa no es válida.');
        error.status = 400;
        throw error;
    }
    const issuer = {};
    for (const key of Object.keys(defaultIssuer)) {
        const value = input[key] ?? '';
        if (typeof value !== 'string' || value.length > 500) {
            const error = new Error('Un campo de la empresa no es válido.');
            error.status = 400;
            throw error;
        }
        issuer[key] = value.trim();
    }
    return issuer;
}

function validateInvoice(input) {
    const fail = message => {
        const error = new Error(message);
        error.status = 400;
        throw error;
    };
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Los datos de la factura no son válidos.');
    const number = typeof input.number === 'string' ? input.number.trim() : '';
    if (!number || number.length > 100) fail('Ingresa un número de factura de hasta 100 caracteres.');
    if (!['Pendiente', 'Pagada', 'Anulada'].includes(input.status)) fail('El estado de la factura no es válido.');
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200) fail('La factura debe tener entre 1 y 200 líneas.');
    const items = input.items.map(item => {
        if (!item || typeof item !== 'object' || typeof item.description !== 'string' ||
            item.description.length > 1000 || typeof item.itbms !== 'boolean') {
            fail('Una línea de la factura no es válida.');
        }
        const qty = Number(item.qty);
        const price = Number(item.price);
        if (!Number.isFinite(qty) || qty < 0 || qty > 1_000_000_000 ||
            !Number.isFinite(price) || price < 0 || price > 1_000_000_000) {
            fail('Las cantidades y precios deben ser números válidos no negativos.');
        }
        return {
            id: String(item.id ?? randomBytes(8).toString('hex')).slice(0, 100),
            qty,
            price,
            description: item.description,
            itbms: item.itbms
        };
    });
    const clientInput = input.client || {};
    const client = {};
    for (const key of ['name', 'ruc', 'dv', 'phone', 'email', 'address']) {
        const value = clientInput[key] ?? '';
        if (typeof value !== 'string' || value.length > 1000) fail('Los datos del cliente no son válidos.');
        client[key] = value;
    }
    if (!['none', 'percent', 'fixed'].includes(input.discountType)) fail('El tipo de descuento no es válido.');
    const discountType = input.discountType;
    const discountValue = Number(input.discountValue ?? 0);
    if (!Number.isFinite(discountValue) || discountValue < 0 || discountValue > 1_000_000_000) {
        fail('El descuento no es válido.');
    }
    const rawExempt = items.filter(item => !item.itbms).reduce((sum, item) => sum + item.qty * item.price, 0);
    const rawTaxable = items.filter(item => item.itbms).reduce((sum, item) => sum + item.qty * item.price, 0);
    const subtotal = rawExempt + rawTaxable;
    const discount = discountType === 'percent'
        ? subtotal * Math.min(100, discountValue) / 100
        : discountType === 'fixed' ? Math.min(subtotal, discountValue) : 0;
    const taxable = subtotal ? rawTaxable - discount * rawTaxable / subtotal : 0;
    const exempt = subtotal ? rawExempt - discount * rawExempt / subtotal : 0;
    const itbms = taxable * 0.07;

    return {
        id: typeof input.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.id)
            ? input.id
            : randomBytes(16).toString('hex'),
        number,
        status: input.status,
        date: typeof input.date === 'string' ? input.date.slice(0, 10) : '',
        dueDate: typeof input.dueDate === 'string' ? input.dueDate.slice(0, 10) : '',
        paymentTerms: typeof input.paymentTerms === 'string' ? input.paymentTerms.slice(0, 200) : 'Contado',
        client,
        items,
        discountType,
        discountValue,
        notes: typeof input.notes === 'string' ? input.notes.slice(0, 5000) : '',
        totals: {
            exempt: rawExempt,
            taxable: rawTaxable,
            subtotal,
            discount,
            itbms,
            grandTotal: exempt + taxable + itbms
        },
        updatedAt: new Date().toISOString()
    };
}

async function supabaseRequest(table, query = '', options = {}) {
    const url = `${supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`;
    const response = await fetch(url, {
        method: options.method || 'GET',
        headers: {
            apikey: supabaseServiceRoleKey,
            Authorization: `Bearer ${supabaseServiceRoleKey}`,
            'Content-Type': 'application/json',
            ...(options.prefer ? { Prefer: options.prefer } : {}),
            ...(options.range ? { Range: options.range, 'Range-Unit': 'items' } : {})
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const text = await response.text();
    if (!response.ok) {
        console.error(`Supabase request failed (${response.status}) for ${options.method || 'GET'} ${table}.`);
        const error = new Error('No se pudo completar la operación en Supabase.');
        error.status = 503;
        throw error;
    }
    return text ? JSON.parse(text) : [];
}

async function getAdmin() {
    const rows = await supabaseRequest(
        'facturapro_admin',
        'select=id,username,salt,password_hash&id=eq.true&limit=1'
    );
    return rows[0] || null;
}

async function getIssuer() {
    const rows = await supabaseRequest(
        'facturapro_settings',
        `select=value&key=eq.${encodeURIComponent('issuer')}&limit=1`
    );
    return rows[0]?.value || defaultIssuer;
}

async function saveIssuer(issuer) {
    await supabaseRequest('facturapro_settings', 'on_conflict=key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: { key: 'issuer', value: issuer }
    });
}

async function listInvoices() {
    const invoices = [];
    for (let offset = 0; ; offset += 1000) {
        const rows = await supabaseRequest(
            'facturapro_invoices',
            `select=payload&order=updated_at.desc&limit=1000&offset=${offset}`
        );
        invoices.push(...rows.map(row => row.payload));
        if (rows.length < 1000) return invoices;
    }
}

async function getInvoice(id) {
    const rows = await supabaseRequest(
        'facturapro_invoices',
        `select=payload&id=eq.${encodeURIComponent(id)}&limit=1`
    );
    return rows[0]?.payload || null;
}

async function saveInvoice(invoice) {
    await supabaseRequest('facturapro_invoices', 'on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: {
            id: invoice.id,
            number: invoice.number,
            payload: invoice,
            updated_at: invoice.updatedAt
        }
    });
}

async function saveInvoices(invoices) {
    if (!invoices.length) return;
    await supabaseRequest('facturapro_invoices', 'on_conflict=id', {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates,return=minimal',
        body: invoices.map(invoice => ({
            id: invoice.id,
            number: invoice.number,
            payload: invoice,
            updated_at: invoice.updatedAt
        }))
    });
}

async function deleteInvoice(id) {
    const rows = await supabaseRequest(
        'facturapro_invoices',
        `id=eq.${encodeURIComponent(id)}&select=id`,
        { method: 'DELETE', prefer: 'return=representation' }
    );
    return rows.length > 0;
}

async function issueSession(request, response) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionDurationMs);
    await supabaseRequest('facturapro_sessions', '', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
            token_hash: createHash('sha256').update(token).digest('hex'),
            expires_at: expiresAt.toISOString()
        }
    });
    await supabaseRequest(
        'facturapro_sessions',
        `expires_at=lt.${encodeURIComponent(now.toISOString())}`,
        { method: 'DELETE', prefer: 'return=minimal' }
    );
    response.setHeader('Set-Cookie', sessionCookie(token, sessionDurationMs / 1000, isSecureRequest(request)));
}

async function deleteSession(tokenHash) {
    await supabaseRequest(
        'facturapro_sessions',
        `token_hash=eq.${tokenHash}`,
        { method: 'DELETE', prefer: 'return=minimal' }
    );
}

function getLoginAttemptKey(username) {
    return createHash('sha256').update(username.toLowerCase()).digest('hex');
}

async function checkLoginRate(attemptKey) {
    const blocked = await supabaseRequest('rpc/facturapro_login_is_blocked', '', {
        method: 'POST',
        body: { p_attempt_key: attemptKey }
    });
    if (blocked === true) {
        const error = new Error('Demasiados intentos. Espera 15 minutos antes de volver a intentarlo.');
        error.status = 429;
        throw error;
    }
}

async function recordLoginFailure(attemptKey) {
    await supabaseRequest('rpc/facturapro_login_failure', '', {
        method: 'POST',
        body: { p_attempt_key: attemptKey }
    });
}

async function clearLoginFailures(attemptKey) {
    await supabaseRequest('rpc/facturapro_login_success', '', {
        method: 'POST',
        body: { p_attempt_key: attemptKey }
    });
}

async function handleApi(request, response, url) {
    const method = request.method;
    const path = url.pathname;
    if (method === 'GET' && path === '/api/auth/status') {
        const [admin, session] = await Promise.all([getAdmin(), getSession(request)]);
        return jsonResponse(response, 200, {
            setupRequired: !admin,
            authenticated: Boolean(session)
        });
    }
    if ((method === 'POST' && (path === '/api/auth/setup' || path === '/api/auth/login')) ||
        (method === 'POST' && path === '/api/auth/logout') ||
        (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/api/'))) {
        checkOrigin(request);
    }
    if (method === 'POST' && path === '/api/auth/setup') {
        if (await getAdmin()) {
            return jsonResponse(response, 409, { error: 'La cuenta administradora ya fue configurada.' });
        }
        const body = await readJson(request);
        const providedToken = typeof body.setupToken === 'string' ? Buffer.from(body.setupToken) : Buffer.alloc(0);
        const expectedToken = Buffer.from(setupToken);
        const tokenValid = !setupTokenUsed && Date.now() < setupTokenExpiresAt &&
            providedToken.length === expectedToken.length && timingSafeEqual(providedToken, expectedToken);
        if (!tokenValid) {
            return jsonResponse(response, 403, { error: 'El código de configuración es incorrecto o expiró. Reinicia el servidor para obtener otro.' });
        }
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (username.length < 3 || username.length > 60 || !/^[a-zA-Z0-9._@+-]+$/.test(username)) {
            return jsonResponse(response, 400, { error: 'El usuario debe tener entre 3 y 60 caracteres alfanuméricos.' });
        }
        if (password.length < 12 || password.length > 128) {
            return jsonResponse(response, 400, { error: 'La contraseña debe tener entre 12 y 128 caracteres.' });
        }
        const salt = randomBytes(16).toString('hex');
        const hash = await scrypt(password, salt, 64);
        await supabaseRequest('facturapro_admin', '', {
            method: 'POST',
            prefer: 'return=minimal',
            body: { id: true, username, salt, password_hash: hash.toString('hex') }
        });
        setupTokenUsed = true;
        await issueSession(request, response);
        return jsonResponse(response, 201, { authenticated: true });
    }
    if (method === 'POST' && path === '/api/auth/login') {
        const body = await readJson(request);
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const attemptKey = getLoginAttemptKey(username);
        await checkLoginRate(attemptKey);
        const admin = await getAdmin();
        if (!admin) return jsonResponse(response, 409, { error: 'Primero debes configurar la cuenta administradora.' });
        const candidate = await scrypt(password, admin.salt, 64);
        const expected = Buffer.from(admin.password_hash, 'hex');
        const valid = username.toLowerCase() === admin.username.toLowerCase() &&
            candidate.length === expected.length && timingSafeEqual(candidate, expected);
        if (!valid) {
            await recordLoginFailure(attemptKey);
            return jsonResponse(response, 401, { error: 'Usuario o contraseña incorrectos.' });
        }
        await clearLoginFailures(attemptKey);
        await issueSession(request, response);
        return jsonResponse(response, 200, { authenticated: true });
    }
    if (method === 'POST' && path === '/api/auth/logout') {
        const session = await getSession(request);
        if (session) await deleteSession(session.tokenHash);
        return jsonResponse(response, 200, { authenticated: false }, {
            'Set-Cookie': sessionCookie('', 0, isSecureRequest(request))
        });
    }

    const session = await getSession(request);
    if (!session) return jsonResponse(response, 401, { error: 'Inicia sesión para continuar.' });

    if (method === 'GET' && path === '/api/bootstrap') {
        const [issuer, invoices] = await Promise.all([getIssuer(), listInvoices()]);
        return jsonResponse(response, 200, { issuer, invoices });
    }
    if (method === 'PUT' && path === '/api/settings/issuer') {
        const issuer = validateIssuer(await readJson(request));
        await saveIssuer(issuer);
        return jsonResponse(response, 200, { issuer });
    }
    if (method === 'POST' && path === '/api/migrate') {
        if ((await listInvoices()).length > 0) {
            return jsonResponse(response, 409, { error: 'La base de datos ya contiene facturas; no se importaron datos.' });
        }
        const body = await readJson(request);
        if (!Array.isArray(body.invoices) || body.invoices.length > 5000) {
            return jsonResponse(response, 400, { error: 'La lista de facturas para importar no es válida.' });
        }
        const invoices = body.invoices.map(validateInvoice);
        if (body.issuer) await saveIssuer(validateIssuer(body.issuer));
        await saveInvoices(invoices);
        const [issuer, savedInvoices] = await Promise.all([getIssuer(), listInvoices()]);
        return jsonResponse(response, 200, { issuer, invoices: savedInvoices });
    }
    if (method === 'GET' && path === '/api/invoices') {
        return jsonResponse(response, 200, { invoices: await listInvoices() });
    }
    if (method === 'POST' && path === '/api/invoices') {
        const invoice = validateInvoice(await readJson(request));
        await saveInvoice(invoice);
        return jsonResponse(response, 201, { invoice });
    }
    const invoiceRoute = path.match(/^\/api\/invoices\/([^/]+)(?:\/status)?$/);
    if (invoiceRoute) {
        const id = decodeURIComponent(invoiceRoute[1]);
        const existing = await getInvoice(id);
        if (!existing) return jsonResponse(response, 404, { error: 'No se encontró la factura.' });
        if (method === 'DELETE' && !path.endsWith('/status')) {
            if (!await deleteInvoice(id)) return jsonResponse(response, 404, { error: 'No se encontró la factura.' });
            return jsonResponse(response, 200, { deleted: true });
        }
        if (method === 'PUT' && !path.endsWith('/status')) {
            const input = await readJson(request);
            const invoice = validateInvoice({ ...input, id });
            await saveInvoice(invoice);
            return jsonResponse(response, 200, { invoice });
        }
        if (method === 'PATCH' && path.endsWith('/status')) {
            const body = await readJson(request);
            if (!['Pendiente', 'Pagada', 'Anulada'].includes(body.status)) {
                return jsonResponse(response, 400, { error: 'El estado de la factura no es válido.' });
            }
            const invoice = { ...existing, status: body.status, updatedAt: new Date().toISOString() };
            await saveInvoice(invoice);
            return jsonResponse(response, 200, { invoice });
        }
    }
    return jsonResponse(response, 404, { error: 'Ruta no encontrada.' });
}

export async function handleRequest(request, response) {
    try {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        if (url.pathname.startsWith('/api/')) {
            await handleApi(request, response, url);
            return;
        }
        if ((request.method === 'GET' || request.method === 'HEAD') &&
            (url.pathname === '/' || url.pathname === '/sistema_de_facturaci_n_comercial_panam_usd_itbms.html')) {
            const html = readFileSync(htmlPath);
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff',
                'Referrer-Policy': 'same-origin'
            });
            response.end(request.method === 'HEAD' ? undefined : html);
            return;
        }
        if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/tailwind.css') {
            const css = readFileSync(cssPath);
            response.writeHead(200, {
                'Content-Type': 'text/css; charset=utf-8',
                'Cache-Control': 'no-cache',
                'X-Content-Type-Options': 'nosniff'
            });
            response.end(request.method === 'HEAD' ? undefined : css);
            return;
        }
        jsonResponse(response, 404, { error: 'Recurso no encontrado.' });
    } catch (error) {
        if (response.headersSent) {
            response.destroy(error);
            return;
        }
        console.error(error);
        jsonResponse(response, error.status || 500, {
            error: error.status ? error.message : 'Error interno del servidor.'
        });
    }
}

let server;
async function startServer() {
    await supabaseRequest('facturapro_admin', 'select=id&limit=1');
    await supabaseRequest('facturapro_sessions', 'select=token_hash&limit=1');
    await supabaseRequest('rpc/facturapro_login_is_blocked', '', {
        method: 'POST',
        body: { p_attempt_key: '0'.repeat(64) }
    });
    const admin = await getAdmin();
    if (!admin) setupTokenExpiresAt = Date.now() + 15 * 60 * 1000;
    server = createServer(handleRequest);
    server.listen(port, host, () => {
        console.log(`FacturaPro listo en http://${host}:${port}`);
        console.log('Base de datos: Supabase Postgres');
        if (!admin) {
            console.log(`Código de configuración inicial (vence en 15 minutos): ${setupToken}`);
        }
    });
}

function closeServer() {
    if (!server) return process.exit(0);
    server.close(() => {
        process.exit(0);
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    process.on('SIGINT', closeServer);
    process.on('SIGTERM', closeServer);
    startServer().catch(error => {
        console.error(`No se pudo iniciar FacturaPro: ${error.message}`);
        process.exitCode = 1;
    });
}

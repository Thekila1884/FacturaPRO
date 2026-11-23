import { createServer } from 'node:http';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

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
const cronSecret = process.env.CRON_SECRET || '';
const resendApiKey = process.env.RESEND_API_KEY || '';
const resendFromEmail = process.env.RESEND_FROM_EMAIL || '';
const resendConfigured = Boolean(resendApiKey && resendFromEmail);
const setupToken = configuredSetupToken || '';
let setupTokenExpiresAt = process.env.VERCEL === '1' && configuredSetupToken
    ? Number.POSITIVE_INFINITY
    : 0;
let setupTokenUsed = false;
let contractAutomationTimer = null;
let contractAutomationRun = null;
const achPaymentMethod = 'Transferencia Bancaria (ACH)';
const defaultPaymentDetails = Object.fromEntries([
    'Contado',
    achPaymentMethod,
    'Yappy Comercial',
    'Efectivo',
    'Tarjeta de Crédito / Débito',
    'Crédito 15 días',
    'Crédito 30 días'
].map(method => [method, '']));

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
    achDetails: '',
    paymentDetails: defaultPaymentDetails
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
    if (request.socket?.encrypted) return true;
    const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim().toLowerCase();
    const loopbackPeer = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress);
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
        if (key === 'achDetails' || key === 'paymentDetails') continue;
        const value = input[key] ?? '';
        if (typeof value !== 'string' || value.length > 500) {
            const error = new Error('Un campo de la empresa no es válido.');
            error.status = 400;
            throw error;
        }
        issuer[key] = value.trim();
    }
    if (input.paymentDetails !== undefined &&
        (!input.paymentDetails || typeof input.paymentDetails !== 'object' || Array.isArray(input.paymentDetails))) {
        const error = new Error('La configuración de métodos de pago no es válida.');
        error.status = 400;
        throw error;
    }
    issuer.paymentDetails = {};
    for (const method of Object.keys(defaultPaymentDetails)) {
        const value = input.paymentDetails?.[method] ?? (method === achPaymentMethod ? input.achDetails ?? '' : '');
        if (typeof value !== 'string' || value.length > 500) {
            const error = new Error('Las instrucciones de un método de pago no son válidas.');
            error.status = 400;
            throw error;
        }
        issuer.paymentDetails[method] = value.trim();
    }
    issuer.achDetails = issuer.paymentDetails[achPaymentMethod];
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
    const dateField = (value, label) => {
        if (value === undefined || value === null || value === '') return '';
        if (typeof value !== 'string' || value.length > 30) fail(`La fecha de ${label} no es válida.`);
        const date = value.slice(0, 10);
        const timestamp = Date.parse(`${date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(timestamp) ||
            new Date(timestamp).toISOString().slice(0, 10) !== date) {
            fail(`La fecha de ${label} no es válida.`);
        }
        return date;
    };
    const date = dateField(input.date, 'emisión');
    const dueDate = dateField(input.dueDate, 'vencimiento');
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
        date,
        dueDate,
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

function validateClients(input) {
    const fail = message => {
        const error = new Error(message);
        error.status = 400;
        throw error;
    };
    if (!Array.isArray(input) || input.length > 5000) {
        fail('El catálogo de clientes no es válido.');
    }

    const ids = new Set();
    return input.map(client => {
        if (!client || typeof client !== 'object' || Array.isArray(client)) {
            fail('Los datos de un cliente no son válidos.');
        }
        const id = typeof client.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(client.id)
            ? client.id
            : randomBytes(16).toString('hex');
        if (ids.has(id)) fail('El catálogo contiene clientes duplicados.');
        ids.add(id);

        const normalized = { id };
        for (const [key, maxLength] of Object.entries({
            name: 200,
            ruc: 100,
            dv: 10,
            phone: 100,
            email: 254,
            address: 500
        })) {
            const value = client[key] ?? '';
            if (typeof value !== 'string' || value.length > maxLength) {
                fail('Un campo del cliente excede el formato permitido.');
            }
            normalized[key] = value.trim();
        }
        if (!normalized.name) fail('El nombre del cliente es obligatorio.');
        if (normalized.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
            fail('El correo electrónico del cliente no es válido.');
        }
        return normalized;
    });
}

function validateContractId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
        const error = new Error('El identificador del contrato no es válido.');
        error.status = 400;
        throw error;
    }
    return id;
}

function isValidContractMonth(value) {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
    const year = Number(value.slice(0, 4));
    return year >= 1900 && year <= 9999;
}

function validateContractMonth(value, label) {
    if (!isValidContractMonth(value)) {
        const error = new Error(`El mes de ${label} no es válido.`);
        error.status = 400;
        throw error;
    }
    return value;
}

function getCurrentPanamaDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Panama',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
}

function addContractDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function validateContractPaymentDate(value) {
    if (!isValidContractPaymentDate(value)) {
        const error = new Error('La fecha de pago no es válida.');
        error.status = 400;
        throw error;
    }
    return value;
}

function getLastContractMonthDate(month) {
    if (!isValidContractMonth(month)) return '';
    const [year, monthNumber] = month.split('-').map(Number);
    return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function getContractStartDate(contract) {
    return contract.startDate ||
        (isValidContractMonth(contract.startMonth) ? `${contract.startMonth}-01` : '');
}

function getContractEndDate(contract) {
    return contract.endDate || getLastContractMonthDate(contract.endMonth);
}

function getContractActivationDate(contract) {
    const value = typeof contract.collectionStartedAt === 'string'
        ? contract.collectionStartedAt.slice(0, 10)
        : '';
    return isValidContractPaymentDate(value) ? value : '';
}

function isValidContractPaymentDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function validateContract(input, client, existing = null) {
    const fail = message => {
        const error = new Error(message);
        error.status = 400;
        throw error;
    };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('Los datos del contrato no son válidos.');
    }
    const clientId = validateClientId(input.clientId);
    if (!client && existing?.clientId !== clientId) {
        fail('Selecciona un cliente guardado en el catálogo.');
    }
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description || description.length > 200) {
        fail('El concepto del contrato es obligatorio y no debe exceder 200 caracteres.');
    }
    if (input.startDate === undefined && input.startMonth !== undefined &&
        !isValidContractMonth(input.startMonth)) {
        fail('La fecha de inicio del contrato no es válida.');
    }
    const startDate = input.startDate === undefined
        ? (isValidContractMonth(input.startMonth)
            ? `${input.startMonth}-01`
            : existing?.startDate || (existing?.startMonth ? `${existing.startMonth}-01` : ''))
        : input.startDate;
    if (!isValidContractPaymentDate(startDate)) fail('La fecha de inicio del contrato no es válida.');
    const hasEndDate = input.endDate !== undefined && input.endDate !== null && input.endDate !== '';
    if (hasEndDate && typeof input.endDate !== 'string') {
        fail('La fecha de finalización del contrato no es válida.');
    }
    if (input.endDate === undefined && input.endMonth !== undefined &&
        input.endMonth !== '' && !isValidContractMonth(input.endMonth)) {
        fail('La fecha de finalización del contrato no es válida.');
    }
    const endDate = input.endDate === undefined
        ? (input.endMonth === ''
            ? ''
            : getLastContractMonthDate(input.endMonth) || existing?.endDate || getLastContractMonthDate(existing?.endMonth))
        : hasEndDate ? input.endDate : '';
    if (endDate && !isValidContractPaymentDate(endDate)) fail('La fecha de finalización del contrato no es válida.');
    if (endDate && endDate < startDate) fail('La fecha de finalización no puede preceder al inicio.');
    const intervalInput = input.billingIntervalDays ?? existing?.billingIntervalDays ?? 30;
    const billingIntervalDays = Number(intervalInput);
    if (!Number.isInteger(billingIntervalDays) || billingIntervalDays < 1 || billingIntervalDays > 30) {
        fail('El intervalo de cobro debe estar entre 1 y 30 días.');
    }
    if (getContractActivationDate(existing || {}) &&
        billingIntervalDays !== Number(existing.billingIntervalDays || 30)) {
        fail('No se puede cambiar el intervalo de cobro después de iniciar el seguimiento.');
    }
    let defaultChargeAmount = existing?.defaultChargeAmount ?? existing?.monthlyAmount ?? null;
    if (Object.hasOwn(input, 'defaultChargeAmount')) {
        const rawAmount = input.defaultChargeAmount;
        const amount = typeof rawAmount === 'number' ||
            (typeof rawAmount === 'string' && rawAmount.trim() !== '')
            ? Number(rawAmount)
            : Number.NaN;
        const roundedAmount = Math.round(amount * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 ||
            Math.abs(amount - roundedAmount) > 1e-8) {
            fail('El monto del plan debe ser mayor que cero y tener hasta dos decimales.');
        }
        defaultChargeAmount = roundedAmount;
    }
    let monthlyAmount = existing?.monthlyAmount ?? null;
    if (Object.hasOwn(input, 'monthlyAmount')) {
        if (input.monthlyAmount === null || input.monthlyAmount === '') {
            monthlyAmount = null;
        } else {
            const amount = Number(input.monthlyAmount);
            const rounded = Math.round(amount * 100) / 100;
            if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 ||
                Math.abs(amount - rounded) > 1e-8) {
                fail('El monto de referencia debe ser válido y tener hasta dos decimales.');
            }
            monthlyAmount = rounded;
        }
    }
    if (defaultChargeAmount === null && monthlyAmount !== null) {
        defaultChargeAmount = monthlyAmount;
    }
    if (!existing && defaultChargeAmount === null) {
        fail('Define el monto por período del plan.');
    }
    const generateInvoices = Object.hasOwn(input, 'generateInvoices')
        ? input.generateInvoices
        : existing?.generateInvoices ?? false;
    const sendInvoiceEmail = Object.hasOwn(input, 'sendInvoiceEmail')
        ? input.sendInvoiceEmail
        : existing?.sendInvoiceEmail ?? false;
    const billItbms = Object.hasOwn(input, 'billItbms')
        ? input.billItbms
        : existing?.billItbms ?? true;
    if (typeof generateInvoices !== 'boolean' || typeof sendInvoiceEmail !== 'boolean' ||
        typeof billItbms !== 'boolean') {
        fail('Las opciones de automatización del contrato no son válidas.');
    }
    if (sendInvoiceEmail && !generateInvoices) {
        fail('Activa la generación automática de facturas antes de habilitar el envío por correo.');
    }
    const notes = input.notes ?? '';
    if (typeof notes !== 'string' || notes.length > 1000) {
        fail('Las notas del contrato exceden el formato permitido.');
    }
    const id = input.id === undefined || input.id === ''
        ? randomBytes(16).toString('hex')
        : validateContractId(input.id);
    const now = new Date().toISOString();
    return {
        id,
        clientId,
        clientName: client?.name || existing.clientName,
        clientRuc: client?.ruc ?? existing?.clientRuc ?? '',
        clientDv: client?.dv ?? existing?.clientDv ?? '',
        clientPhone: client?.phone ?? existing?.clientPhone ?? '',
        clientEmail: client?.email ?? existing?.clientEmail ?? '',
        clientAddress: client?.address ?? existing?.clientAddress ?? '',
        description,
        defaultChargeAmount,
        generateInvoices,
        sendInvoiceEmail,
        billItbms,
        monthlyAmount,
        dueDay: existing?.dueDay || 1,
        startDate,
        endDate,
        startMonth: startDate.slice(0, 7),
        endMonth: endDate ? endDate.slice(0, 7) : '',
        billingIntervalDays,
        collectionStartedAt: getContractActivationDate(existing || {}),
        notes: notes.trim(),
        createdAt: existing?.createdAt || now,
        updatedAt: now
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
    const stored = rows[0]?.value;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaultIssuer;
    const storedPaymentDetails = stored.paymentDetails && typeof stored.paymentDetails === 'object' &&
        !Array.isArray(stored.paymentDetails) ? stored.paymentDetails : {};
    const paymentDetails = Object.fromEntries(Object.keys(defaultPaymentDetails).map(method => [
        method,
        typeof storedPaymentDetails[method] === 'string' ? storedPaymentDetails[method] : ''
    ]));
    paymentDetails[achPaymentMethod] ||= typeof stored.achDetails === 'string' ? stored.achDetails : '';
    return {
        ...defaultIssuer,
        ...stored,
        achDetails: paymentDetails[achPaymentMethod],
        paymentDetails
    };
}

async function saveIssuer(issuer) {
    await supabaseRequest('facturapro_settings', 'on_conflict=key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: { key: 'issuer', value: issuer }
    });
}

async function getSettingsRowsByPrefix(prefix) {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
        const page = await supabaseRequest(
            'facturapro_settings',
            `select=key,value&key=like.${encodeURIComponent(`${prefix}%`)}&limit=1000&offset=${offset}`
        );
        rows.push(...page);
        if (page.length < 1000) return rows;
    }
}

async function getClients() {
    const rows = await getSettingsRowsByPrefix('client:');
    return validateClients(rows.map(row => ({ ...row.value, id: row.key.slice('client:'.length) })));
}

async function saveClient(client) {
    await supabaseRequest('facturapro_settings', 'on_conflict=key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: {
            key: `client:${client.id}`,
            value: {
                name: client.name,
                ruc: client.ruc,
                dv: client.dv,
                phone: client.phone,
                email: client.email,
                address: client.address
            }
        }
    });
}

async function deleteClient(id) {
    const rows = await supabaseRequest(
        'facturapro_settings',
        `key=eq.${encodeURIComponent(`client:${id}`)}&select=key`,
        { method: 'DELETE', prefer: 'return=representation' }
    );
    return rows.length > 0;
}

function validateClientId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
        const error = new Error('El identificador del cliente no es válido.');
        error.status = 400;
        throw error;
    }
    return id;
}

function ensureClientCapacity(clients, clientId) {
    if (clients.length >= 5000 && !clients.some(client => client.id === clientId)) {
        const error = new Error('El catálogo alcanzó el máximo de 5000 clientes.');
        error.status = 400;
        throw error;
    }
}

async function updateClient(client) {
    const id = validateClientId(client.id);
    const existing = await getClients();
    ensureClientCapacity(existing, id);
    await saveClient(client);
    return client;
}

async function removeClient(id) {
    const validId = validateClientId(id);
    if (!await deleteClient(validId)) return false;
    return true;
}

async function getContract(id) {
    const validId = validateContractId(id);
    const rows = await supabaseRequest(
        'facturapro_settings',
        `select=key,value&key=eq.${encodeURIComponent(`contract:${validId}`)}&limit=1`
    );
    return rows[0]?.value || null;
}

async function saveContract(contract) {
    const { id, ...value } = contract;
    await supabaseRequest('facturapro_settings', 'on_conflict=key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: { key: `contract:${id}`, value }
    });
}

async function getContractPayments(contractId = null) {
    const prefix = contractId === null ? 'contract-payment:' : `contract-payment:${validateContractId(contractId)}:`;
    const rows = await getSettingsRowsByPrefix(prefix);
    return rows.map(row => {
        const match = row.key.match(/^contract-payment:([a-zA-Z0-9_-]{1,100}):(\d{4}-(0[1-9]|1[0-2]))$/);
        const value = row.value;
        if (!match || !value || typeof value !== 'object' || Array.isArray(value) ||
            value.contractId !== match[1] || value.month !== match[2] ||
            !isValidContractMonth(value.month) || !isValidContractPaymentDate(value.paidAt)) {
            throw new Error('Los datos de un pago de contrato guardado no son válidos.');
        }
        return { contractId: match[1], month: match[2], paidAt: value.paidAt };
    });
}

async function getContractCharges(contractId = null) {
    const prefix = contractId === null ? 'contract-charge:' : `contract-charge:${validateContractId(contractId)}:`;
    const rows = await getSettingsRowsByPrefix(prefix);
    return rows.map(row => {
        const match = row.key.match(/^contract-charge:([a-zA-Z0-9_-]{1,100}):(\d{4}-\d{2}-\d{2})$/);
        const value = row.value;
        const amount = Number(value?.amount);
        const roundedAmount = Math.round(amount * 100) / 100;
        if (!match || !value || typeof value !== 'object' || Array.isArray(value) ||
            value.contractId !== match[1] || value.dueDate !== match[2] ||
            !isValidContractPaymentDate(value.dueDate) ||
            !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 ||
            Math.abs(amount - roundedAmount) > 1e-8 ||
            (value.paidAt !== '' && !isValidContractPaymentDate(value.paidAt))) {
            throw new Error('Los datos de un cobro de contrato guardado no son válidos.');
        }
        return {
            contractId: match[1],
            dueDate: match[2],
            amount: roundedAmount,
            paidAt: value.paidAt || ''
        };
    });
}

async function saveContractCharge(contractId, dueDate, amount, paidAt = '') {
    const id = validateContractId(contractId);
    await supabaseRequest('facturapro_settings', 'on_conflict=key', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: {
            key: `contract-charge:${id}:${dueDate}`,
            value: { contractId: id, dueDate, amount, paidAt, updatedAt: new Date().toISOString() }
        }
    });
}

async function deleteContractPayments(contractId) {
    const id = validateContractId(contractId);
    await supabaseRequest(
        'facturapro_settings',
        `key=like.${encodeURIComponent(`contract-payment:${id}:%`)}&select=key`,
        { method: 'DELETE', prefer: 'return=representation' }
    );
}

async function deleteContractCharges(contractId) {
    const id = validateContractId(contractId);
    await supabaseRequest(
        'facturapro_settings',
        `key=like.${encodeURIComponent(`contract-charge:${id}:%`)}&select=key`,
        { method: 'DELETE', prefer: 'return=representation' }
    );
}

async function deleteContract(id) {
    const validId = validateContractId(id);
    await Promise.all([deleteContractPayments(validId), deleteContractCharges(validId)]);
    const rows = await supabaseRequest(
        'facturapro_settings',
        `key=eq.${encodeURIComponent(`contract:${validId}`)}&select=key`,
        { method: 'DELETE', prefer: 'return=representation' }
    );
    return rows.length > 0;
}

function getNextChargeDueDate(contract, charges) {
    const activationDate = getContractActivationDate(contract);
    const billingIntervalDays = Number(contract.billingIntervalDays || 30);
    if (!activationDate || !Number.isInteger(billingIntervalDays) ||
        billingIntervalDays < 1 || billingIntervalDays > 30) return '';
    const lastPaidCharge = charges
        .filter(charge => charge.paidAt)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .at(-1);
    const baseDate = lastPaidCharge
        ? (lastPaidCharge.paidAt > lastPaidCharge.dueDate ? lastPaidCharge.paidAt : lastPaidCharge.dueDate)
        : activationDate;
    const nextDueDate = addContractDays(baseDate, billingIntervalDays);
    const endDate = getContractEndDate(contract);
    if (endDate && nextDueDate > endDate) return '';
    return nextDueDate;
}

function formatInvoicePdfDate(value) {
    return isValidContractPaymentDate(value)
        ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
        : '—';
}

function formatInvoicePdfMoney(value) {
    return `$${(Number(value) || 0).toFixed(2)}`;
}

function createInvoicePdf(invoice, issuer) {
    return new Promise((resolve, reject) => {
        const document = new PDFDocument({ size: 'LETTER', margin: 48 });
        const chunks = [];
        document.on('data', chunk => chunks.push(chunk));
        document.on('error', reject);
        document.on('end', () => resolve(Buffer.concat(chunks)));

        const margin = 48;
        const contentWidth = document.page.width - margin * 2;
        document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
            .text(issuer.name, { width: contentWidth * 0.7 });
        document.fillColor('#475569').font('Helvetica').fontSize(9);
        [
            issuer.ruc ? `RUC: ${issuer.ruc}${issuer.dv ? ` · DV: ${issuer.dv}` : ''}` : '',
            issuer.address,
            issuer.phone ? `Tel: ${issuer.phone}` : '',
            issuer.email
        ].filter(Boolean).forEach(line => document.text(line));

        document.moveDown(0.8);
        document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(16).text('FACTURA COMERCIAL');
        document.fontSize(10).text(`Factura: ${invoice.number}`);
        document.font('Helvetica').text(`Fecha de emisión: ${formatInvoicePdfDate(invoice.date)}`);
        document.text(`Fecha de vencimiento: ${formatInvoicePdfDate(invoice.dueDate)}`);
        document.text(`Estado: ${invoice.status}`);

        document.moveDown(0.8);
        document.font('Helvetica-Bold').fontSize(11).text('Facturar a');
        document.font('Helvetica').fontSize(9)
            .text(invoice.client.name || 'Cliente')
            .text(invoice.client.ruc ? `RUC / identificación: ${invoice.client.ruc}` : '')
            .text(invoice.client.address || '')
            .text(invoice.client.email || '');

        document.moveDown(1);
        const tableX = margin;
        const quantityWidth = 38;
        const unitWidth = 74;
        const taxWidth = 42;
        const totalWidth = 78;
        const descriptionWidth = contentWidth - quantityWidth - unitWidth - taxWidth - totalWidth;
        const descriptionX = tableX + quantityWidth;
        const unitX = descriptionX + descriptionWidth;
        const taxX = unitX + unitWidth;
        const totalX = taxX + taxWidth;
        const drawTableHeader = () => {
            const y = document.y;
            document.rect(tableX, y, contentWidth, 22).fill('#e2e8f0');
            document.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8);
            document.text('Cant.', tableX + 3, y + 7, { width: quantityWidth - 6 });
            document.text('Descripción', descriptionX + 3, y + 7, { width: descriptionWidth - 6 });
            document.text('Precio', unitX, y + 7, { width: unitWidth - 4, align: 'right' });
            document.text('ITBMS', taxX, y + 7, { width: taxWidth - 4, align: 'center' });
            document.text('Total', totalX, y + 7, { width: totalWidth - 3, align: 'right' });
            document.y = y + 22;
        };
        drawTableHeader();
        invoice.items.forEach(item => {
            const lineSubtotal = item.qty * item.price;
            const lineTotal = lineSubtotal * (item.itbms ? 1.07 : 1);
            const descriptionHeight = document.heightOfString(item.description || 'Servicio', {
                width: descriptionWidth - 8,
                font: 'Helvetica',
                fontSize: 8
            });
            const rowHeight = Math.max(22, descriptionHeight + 10);
            if (document.y + rowHeight > document.page.height - margin - 150) {
                document.addPage();
                drawTableHeader();
            }
            const y = document.y + 5;
            document.fillColor('#334155').font('Helvetica').fontSize(8);
            document.text(String(item.qty), tableX + 3, y, { width: quantityWidth - 6 });
            document.text(item.description || 'Servicio', descriptionX + 3, y, {
                width: descriptionWidth - 8,
                height: rowHeight - 5
            });
            document.text(formatInvoicePdfMoney(item.price), unitX, y, { width: unitWidth - 4, align: 'right' });
            document.text(item.itbms ? '7%' : 'Exento', taxX, y, { width: taxWidth - 4, align: 'center' });
            document.text(formatInvoicePdfMoney(lineTotal), totalX, y, { width: totalWidth - 3, align: 'right' });
            document.moveTo(tableX, document.y + rowHeight).lineTo(tableX + contentWidth, document.y + rowHeight)
                .strokeColor('#e2e8f0').stroke();
            document.y += rowHeight;
        });

        const totals = [
            ['Subtotal', invoice.totals.subtotal],
            ...(invoice.totals.discount > 0 ? [['Descuento', -invoice.totals.discount]] : []),
            ['ITBMS', invoice.totals.itbms]
        ];
        const totalsHeight = (totals.length + 1) * 18 + 14;
        if (document.y + totalsHeight > document.page.height - margin) document.addPage();
        document.moveDown(0.6);
        const totalsLabelX = margin + contentWidth - 190;
        totals.forEach(([label, amount]) => {
            const y = document.y;
            document.fillColor('#475569').font('Helvetica').fontSize(9)
                .text(label, totalsLabelX, y, { width: 110 });
            document.text(formatInvoicePdfMoney(amount), totalsLabelX + 110, y, { width: 80, align: 'right' });
            document.y = y + 18;
        });
        const totalY = document.y + 3;
        document.roundedRect(totalsLabelX - 8, totalY, 198, 28, 4).fill('#0f172a');
        document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
            .text('TOTAL USD', totalsLabelX, totalY + 8, { width: 100 });
        document.text(formatInvoicePdfMoney(invoice.totals.grandTotal), totalsLabelX + 100, totalY + 8, {
            width: 82,
            align: 'right'
        });
        document.y = totalY + 36;
        if (invoice.notes) {
            if (document.y + 42 > document.page.height - margin) document.addPage();
            document.fillColor('#475569').font('Helvetica-Bold').fontSize(9).text('Notas');
            document.font('Helvetica').fontSize(8).text(invoice.notes, { width: contentWidth });
        }
        document.end();
    });
}

function escapeEmailHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function createInvoiceEmailContent(invoice, issuer) {
    const itemRows = invoice.items.map(item => `
        <tr>
            <td style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#334155;font-size:14px;">
                ${escapeEmailHtml(item.description)}
                <div style="padding-top:4px;color:#64748b;font-size:12px;">
                    ${item.qty} × ${formatInvoicePdfMoney(item.price)} · ${item.itbms ? 'ITBMS 7%' : 'Exento'}
                </div>
            </td>
            <td align="right" style="padding:12px 0;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;font-weight:600;white-space:nowrap;">
                ${formatInvoicePdfMoney(item.qty * item.price)}
            </td>
        </tr>`).join('');
    const discountRow = invoice.totals.discount > 0
        ? `<tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Descuento</td><td align="right" style="padding:4px 0;color:#64748b;font-size:13px;">−${formatInvoicePdfMoney(invoice.totals.discount)}</td></tr>`
        : '';
    const textItems = invoice.items.map(item =>
        `- ${item.qty} x ${item.description}: ${formatInvoicePdfMoney(item.qty * item.price)} (${item.itbms ? 'ITBMS 7%' : 'exento'})`
    ).join('\n');

    return {
        html: `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f1f5f9;padding:32px 12px;">
        <tr><td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
                <tr>
                    <td style="padding:24px 32px;background-color:#0f172a;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                                <td style="color:#ffffff;font-size:18px;font-weight:700;">${escapeEmailHtml(issuer.name)}</td>
                                <td align="right" style="color:#a7f3d0;font-size:11px;font-weight:700;letter-spacing:1.2px;">FACTURAPRO</td>
                            </tr>
                        </table>
                        <p style="margin:24px 0 5px;color:#a7f3d0;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Factura comercial</p>
                        <h1 style="margin:0;color:#ffffff;font-size:24px;line-height:1.3;">${escapeEmailHtml(invoice.number)}</h1>
                    </td>
                </tr>
                <tr>
                    <td style="padding:28px 32px 12px;">
                        <p style="margin:0 0 10px;color:#0f172a;font-size:16px;font-weight:700;">Hola ${escapeEmailHtml(invoice.client.name)},</p>
                        <p style="margin:0;color:#475569;font-size:14px;line-height:1.7;">
                            Te compartimos el resumen de tu factura. Encontrarás el documento completo en PDF adjunto a este correo.
                        </p>
                    </td>
                </tr>
                <tr>
                    <td style="padding:16px 32px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                            <tr>
                                <td style="padding:16px;color:#475569;font-size:12px;">TOTAL A PAGAR</td>
                                <td align="right" style="padding:16px;color:#047857;font-size:22px;font-weight:700;white-space:nowrap;">${formatInvoicePdfMoney(invoice.totals.grandTotal)} USD</td>
                            </tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td style="padding:8px 32px 12px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr>
                                <td style="padding:7px 0;color:#64748b;font-size:13px;">Fecha de emisión</td>
                                <td align="right" style="padding:7px 0;color:#334155;font-size:13px;">${formatInvoicePdfDate(invoice.date)}</td>
                            </tr>
                            <tr>
                                <td style="padding:7px 0;color:#64748b;font-size:13px;">Fecha de vencimiento</td>
                                <td align="right" style="padding:7px 0;color:#334155;font-size:13px;font-weight:700;">${formatInvoicePdfDate(invoice.dueDate)}</td>
                            </tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td style="padding:16px 32px 8px;">
                        <h2 style="margin:0 0 8px;color:#0f172a;font-size:15px;">Resumen de cargos</h2>
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            ${itemRows}
                        </table>
                    </td>
                </tr>
                <tr>
                    <td style="padding:12px 32px 24px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">Subtotal</td><td align="right" style="padding:4px 0;color:#64748b;font-size:13px;">${formatInvoicePdfMoney(invoice.totals.subtotal)}</td></tr>
                            ${discountRow}
                            <tr><td style="padding:4px 0;color:#64748b;font-size:13px;">ITBMS</td><td align="right" style="padding:4px 0;color:#64748b;font-size:13px;">${formatInvoicePdfMoney(invoice.totals.itbms)}</td></tr>
                            <tr><td colspan="2" style="padding-top:10px;border-top:1px solid #cbd5e1;"></td></tr>
                            <tr><td style="padding:4px 0;color:#0f172a;font-size:15px;font-weight:700;">Total</td><td align="right" style="padding:4px 0;color:#047857;font-size:15px;font-weight:700;">${formatInvoicePdfMoney(invoice.totals.grandTotal)} USD</td></tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td style="padding:0 32px 28px;">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#ecfdf5;border-radius:10px;">
                            <tr><td style="padding:14px 16px;color:#065f46;font-size:13px;line-height:1.6;">
                                <strong>PDF adjunto</strong><br>Guarda el archivo adjunto para consultar o imprimir el detalle completo.
                            </td></tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td style="padding:20px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.7;">
                        Saludos,<br><strong style="color:#334155;">${escapeEmailHtml(issuer.name)}</strong>
                        <p style="margin:10px 0 0;color:#94a3b8;font-size:11px;">Mensaje generado automáticamente por FacturaPro.</p>
                    </td>
                </tr>
            </table>
        </td></tr>
    </table>
</body>
</html>`,
        text: `Hola ${invoice.client.name},

Te compartimos tu factura ${invoice.number}, emitida por ${issuer.name}.

Fecha de emisión: ${formatInvoicePdfDate(invoice.date)}
Fecha de vencimiento: ${formatInvoicePdfDate(invoice.dueDate)}
Total a pagar: ${formatInvoicePdfMoney(invoice.totals.grandTotal)} USD

Resumen de cargos:
${textItems}

Subtotal: ${formatInvoicePdfMoney(invoice.totals.subtotal)}
Descuento: ${formatInvoicePdfMoney(invoice.totals.discount)}
ITBMS: ${formatInvoicePdfMoney(invoice.totals.itbms)}
Total: ${formatInvoicePdfMoney(invoice.totals.grandTotal)} USD

Adjuntamos el PDF con el detalle completo.

Saludos,
${issuer.name}`
    };
}

async function sendInvoiceEmail(invoice, issuer) {
    if (!resendConfigured) {
        const error = new Error('Configura Resend en el servidor antes de enviar correos.');
        error.status = 503;
        throw error;
    }
    const recipient = invoice.client.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        throw new Error('El cliente no tiene un correo electrónico válido.');
    }
    const pdf = await createInvoicePdf(invoice, issuer);
    const safeNumber = invoice.number.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    const emailContent = createInvoiceEmailContent(invoice, issuer);
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': createHash('sha256').update(invoice.id).digest('hex')
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
            from: resendFromEmail,
            to: [recipient],
            subject: `Factura ${invoice.number} · ${issuer.name}`,
            html: emailContent.html,
            text: emailContent.text,
            attachments: [{
                filename: `Factura-${safeNumber}.pdf`,
                content: pdf.toString('base64')
            }]
        })
    });
    if (!response.ok) {
        let responseBody;
        try {
            responseBody = await response.json();
        } catch (parseError) {
            if (!(parseError instanceof SyntaxError)) throw parseError;
        }
        const providerMessage = typeof responseBody?.message === 'string'
            ? responseBody.message
            : typeof responseBody?.error === 'string'
                ? responseBody.error
                : '';
        const safeProviderMessage = providerMessage.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
        const detail = safeProviderMessage ? `: ${safeProviderMessage}` : '';
        const error = new Error(`Resend rechazó el correo (HTTP ${response.status})${detail}`);
        error.status = 502;
        throw error;
    }
    return response.json();
}

async function sendInvoiceWithStatus(invoice, issuer) {
    const lastAttemptAt = new Date().toISOString();
    const pendingInvoice = {
        ...invoice,
        automaticContract: {
            ...invoice.automaticContract,
            email: { ...invoice.automaticContract.email, status: 'pending', lastAttemptAt }
        },
        updatedAt: lastAttemptAt
    };
    await saveInvoice(pendingInvoice);
    try {
        const response = await sendInvoiceEmail(pendingInvoice, issuer);
        const sentAt = new Date().toISOString();
        const sentInvoice = {
            ...pendingInvoice,
            automaticContract: {
                ...pendingInvoice.automaticContract,
                email: {
                    status: 'sent',
                    lastAttemptAt,
                    sentAt,
                    providerId: typeof response?.id === 'string' ? response.id.slice(0, 200) : ''
                }
            },
            updatedAt: sentAt
        };
        await saveInvoice(sentInvoice);
        return sentInvoice;
    } catch (error) {
        const failedAt = new Date().toISOString();
        const failedInvoice = {
            ...pendingInvoice,
            automaticContract: {
                ...pendingInvoice.automaticContract,
                email: {
                    status: 'failed',
                    lastAttemptAt,
                    failedAt,
                    error: error.message.slice(0, 300)
                }
            },
            updatedAt: failedAt
        };
        await saveInvoice(failedInvoice);
        throw error;
    }
}

function getAutomaticInvoiceIdentity(contractId, dueDate) {
    const digest = createHash('sha256').update(`${contractId}:${dueDate}`).digest('hex');
    return {
        id: `contract_invoice_${digest.slice(0, 40)}`,
        number: `FAC-REC-${dueDate.replaceAll('-', '')}-${digest.slice(0, 8).toUpperCase()}`
    };
}

function createContractInvoice(contract, charge, date, catalogClient) {
    const amount = Number(charge.amount ?? contract.defaultChargeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        const error = new Error('El período no tiene un monto válido configurado.');
        error.status = 409;
        throw error;
    }
    const identity = getAutomaticInvoiceIdentity(contract.id, charge.dueDate);
    return {
        ...validateInvoice({
            id: identity.id,
            number: identity.number,
            status: charge.paidAt ? 'Pagada' : 'Pendiente',
            date,
            dueDate: charge.dueDate,
            paymentTerms: `Contrato recurrente · cada ${contract.billingIntervalDays} días`,
            client: {
                name: catalogClient?.name || contract.clientName,
                ruc: catalogClient?.ruc || contract.clientRuc || '',
                dv: catalogClient?.dv || contract.clientDv || '',
                phone: catalogClient?.phone || contract.clientPhone || '',
                email: catalogClient ? catalogClient.email : contract.clientEmail || '',
                address: catalogClient?.address || contract.clientAddress || ''
            },
            items: [{
                id: `contract-item-${contract.id}`.slice(0, 100),
                qty: 1,
                description: contract.description,
                price: amount,
                itbms: contract.billItbms !== false
            }],
            discountType: 'none',
            discountValue: 0,
            notes: contract.notes || ''
        }),
        automaticContract: {
            contractId: contract.id,
            dueDate: charge.dueDate,
            email: { status: contract.sendInvoiceEmail ? 'pending' : 'disabled' }
        }
    };
}

async function executeContractInvoiceAutomation(today) {
    const [contracts, invoices, clients, issuer] = await Promise.all([
        listContracts(),
        listInvoices(),
        getClients(),
        getIssuer()
    ]);
    const invoiceById = new Map(invoices.map(invoice => [invoice.id, invoice]));
    const result = { created: 0, emailed: 0, failed: [] };
    for (const contract of contracts) {
        if (!contract.generateInvoices || !contract.collectionStartedAt) continue;
        const dueCharges = new Map((contract.charges || [])
            .filter(charge => charge.dueDate <= today)
            .map(charge => [charge.dueDate, charge]));
        if (contract.nextChargeDate && contract.nextChargeDate <= today &&
            !dueCharges.has(contract.nextChargeDate)) {
            dueCharges.set(contract.nextChargeDate, {
                dueDate: contract.nextChargeDate,
                amount: contract.defaultChargeAmount,
                paidAt: ''
            });
        }
        for (const charge of dueCharges.values()) {
            try {
                const amount = Number(charge.amount ?? contract.defaultChargeAmount);
                if (!Number.isFinite(amount) || amount <= 0) {
                    throw new Error('El período no tiene un monto válido configurado.');
                }
                const identity = getAutomaticInvoiceIdentity(contract.id, charge.dueDate);
                let invoice = invoiceById.get(identity.id);
                if (!invoice) {
                    const catalogClient = clients.find(client => client.id === contract.clientId);
                    invoice = createContractInvoice(contract, charge, today, catalogClient);
                    await saveInvoice(invoice);
                    invoiceById.set(invoice.id, invoice);
                    result.created++;
                } else if (invoice.automaticContract?.contractId !== contract.id ||
                    invoice.automaticContract?.dueDate !== charge.dueDate) {
                    throw new Error('El identificador de factura automática está asociado a otro origen.');
                }

                if (!contract.sendInvoiceEmail) continue;
                if (invoice.automaticContract.email.status === 'sent') continue;
                const sentInvoice = await sendInvoiceWithStatus(invoice, issuer);
                invoiceById.set(invoice.id, sentInvoice);
                result.emailed++;
            } catch (error) {
                const failure = {
                    contractId: contract.id,
                    dueDate: charge.dueDate,
                    message: error.message.slice(0, 300)
                };
                result.failed.push(failure);
                console.error('Automatic contract invoice failed:', failure);
            }
        }
    }
    return result;
}

async function processContractInvoiceAutomation(today = getCurrentPanamaDate()) {
    if (contractAutomationRun) return contractAutomationRun;
    contractAutomationRun = executeContractInvoiceAutomation(today);
    try {
        return await contractAutomationRun;
    } finally {
        contractAutomationRun = null;
    }
}

async function getContractDetails(contract) {
    const [payments, charges] = await Promise.all([
        getContractPayments(contract.id),
        getContractCharges(contract.id)
    ]);
    return {
        ...contract,
        startDate: getContractStartDate(contract),
        endDate: getContractEndDate(contract),
        collectionStartedAt: getContractActivationDate(contract),
        billingIntervalDays: contract.billingIntervalDays || 30,
        defaultChargeAmount: contract.defaultChargeAmount ?? contract.monthlyAmount ?? null,
        generateInvoices: contract.generateInvoices === true,
        sendInvoiceEmail: contract.sendInvoiceEmail === true,
        billItbms: contract.billItbms !== false,
        payments: payments.map(({ month, paidAt }) => ({ month, paidAt })),
        charges: charges.map(({ dueDate, amount, paidAt }) => ({ dueDate, amount, paidAt })),
        nextChargeDate: getNextChargeDueDate(contract, charges)
    };
}

async function listContracts() {
    const [contractRows, payments, charges] = await Promise.all([
        getSettingsRowsByPrefix('contract:'),
        getContractPayments(),
        getContractCharges()
    ]);
    const paymentsByContract = new Map();
    for (const payment of payments) {
        const contractPayments = paymentsByContract.get(payment.contractId) || [];
        contractPayments.push({ month: payment.month, paidAt: payment.paidAt });
        paymentsByContract.set(payment.contractId, contractPayments);
    }
    const chargesByContract = new Map();
    for (const charge of charges) {
        const contractCharges = chargesByContract.get(charge.contractId) || [];
        contractCharges.push({ dueDate: charge.dueDate, amount: charge.amount, paidAt: charge.paidAt });
        chargesByContract.set(charge.contractId, contractCharges);
    }
    return contractRows.map(row => {
        const id = row.key.slice('contract:'.length);
        const contract = row.value;
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !contract ||
            typeof contract !== 'object' || Array.isArray(contract)) {
            throw new Error('Los datos de un contrato guardado no son válidos.');
        }
        return {
            ...contract,
            id,
            startDate: getContractStartDate(contract),
            endDate: getContractEndDate(contract),
            collectionStartedAt: getContractActivationDate(contract),
            billingIntervalDays: contract.billingIntervalDays || 30,
            defaultChargeAmount: contract.defaultChargeAmount ?? contract.monthlyAmount ?? null,
            generateInvoices: contract.generateInvoices === true,
            sendInvoiceEmail: contract.sendInvoiceEmail === true,
            billItbms: contract.billItbms !== false,
            payments: (paymentsByContract.get(id) || []).sort((a, b) => a.month.localeCompare(b.month)),
            charges: (chargesByContract.get(id) || []).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
            nextChargeDate: getNextChargeDueDate(contract, chargesByContract.get(id) || [])
        };
    }).sort((a, b) => a.clientName.localeCompare(b.clientName, 'es'));
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
    if (method === 'GET' && path === '/api/cron/contracts') {
        const authorization = request.headers.authorization || '';
        const providedSecret = authorization.startsWith('Bearer ')
            ? Buffer.from(authorization.slice('Bearer '.length))
            : Buffer.alloc(0);
        const expectedSecret = Buffer.from(cronSecret);
        const secretValid = cronSecret.length >= 32 &&
            providedSecret.length === expectedSecret.length &&
            timingSafeEqual(providedSecret, expectedSecret);
        if (!secretValid) return jsonResponse(response, 401, { error: 'Autorización de tarea programada inválida.' });
        const result = await processContractInvoiceAutomation();
        return jsonResponse(response, result.failed.length ? 500 : 200, result);
    }

    const session = await getSession(request);
    if (!session) return jsonResponse(response, 401, { error: 'Inicia sesión para continuar.' });

    if (method === 'GET' && path === '/api/bootstrap') {
        const [issuer, invoices] = await Promise.all([getIssuer(), listInvoices()]);
        return jsonResponse(response, 200, { issuer, invoices, resendConfigured });
    }
    if (method === 'GET' && path === '/api/clients') {
        return jsonResponse(response, 200, { clients: await getClients() });
    }
    if (method === 'PUT' && path === '/api/clients') {
        const body = await readJson(request);
        const client = validateClients([body.client])[0];
        await updateClient(client);
        return jsonResponse(response, 200, { client });
    }
    const clientRoute = path.match(/^\/api\/clients\/([^/]+)$/);
    if (clientRoute && method === 'DELETE') {
        const id = decodeURIComponent(clientRoute[1]);
        if (!await removeClient(id)) return jsonResponse(response, 404, { error: 'No se encontró el cliente.' });
        return jsonResponse(response, 200, { deleted: true });
    }
    if (method === 'GET' && path === '/api/contracts') {
        return jsonResponse(response, 200, { contracts: await listContracts() });
    }
    if (method === 'PUT' && path === '/api/contracts') {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return jsonResponse(response, 400, { error: 'Los datos del contrato no son válidos.' });
        }
        const existing = input.id ? await getContract(validateContractId(input.id)) : null;
        if (input.id && !existing) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        const clientId = validateClientId(input.clientId);
        const clients = await getClients();
        const client = clients.find(item => item.id === clientId) || null;
        const contract = validateContract(input, client, existing);
        await saveContract(contract);
        return jsonResponse(response, existing ? 200 : 201, {
            contract: await getContractDetails(contract)
        });
    }
    const contractInvoiceRoute = path.match(/^\/api\/contracts\/([^/]+)\/invoices$/);
    if (method === 'POST' && contractInvoiceRoute) {
        const id = validateContractId(decodeURIComponent(contractInvoiceRoute[1]));
        const savedContract = await getContract(id);
        if (!savedContract) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        const contract = { ...savedContract, id };
        if (!contract.collectionStartedAt) {
            return jsonResponse(response, 409, { error: 'Primero debes empezar a cobrar este contrato.' });
        }

        const charges = await getContractCharges(id);
        const dueDate = getNextChargeDueDate(contract, charges);
        if (!dueDate) {
            return jsonResponse(response, 409, { error: 'El contrato no tiene otro período de cobro vigente.' });
        }
        const charge = charges.find(item => item.dueDate === dueDate) || {
            dueDate,
            amount: contract.defaultChargeAmount,
            paidAt: ''
        };
        const identity = getAutomaticInvoiceIdentity(id, dueDate);
        let invoice = await getInvoice(identity.id);
        let created = false;
        if (!invoice) {
            const clients = await getClients();
            const catalogClient = clients.find(client => client.id === contract.clientId);
            invoice = createContractInvoice(contract, charge, getCurrentPanamaDate(), catalogClient);
            await saveInvoice(invoice);
            created = true;
        } else if (invoice.automaticContract?.contractId !== id ||
            invoice.automaticContract?.dueDate !== dueDate ||
            !invoice.automaticContract.email) {
            return jsonResponse(response, 409, { error: 'La factura del período existe con un origen incompatible.' });
        }

        if (invoice.automaticContract.email.status === 'sent') {
            return jsonResponse(response, 200, { invoice, created, emailed: false, alreadySent: true });
        }
        try {
            const sentInvoice = await sendInvoiceWithStatus(invoice, await getIssuer());
            return jsonResponse(response, 200, { invoice: sentInvoice, created, emailed: true });
        } catch (error) {
            const failedInvoice = await getInvoice(invoice.id);
            return jsonResponse(response, error.status || 502, {
                error: error.message,
                invoice: failedInvoice,
                created
            });
        }
    }
    const startCollectionRoute = path.match(/^\/api\/contracts\/([^/]+)\/collection\/start$/);
    if (startCollectionRoute && method === 'POST') {
        const id = validateContractId(decodeURIComponent(startCollectionRoute[1]));
        const contract = await getContract(id);
        if (!contract) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        if (contract.collectionStartedAt) {
            return jsonResponse(response, 409, { error: 'El cobro de este contrato ya está iniciado.' });
        }
        const today = getCurrentPanamaDate();
        const startDate = getContractStartDate(contract);
        const endDate = getContractEndDate(contract);
        if (startDate > today) {
            return jsonResponse(response, 400, { error: 'La fecha de inicio del contrato todavía no ha llegado.' });
        }
        if (endDate && today > endDate) {
            return jsonResponse(response, 400, { error: 'La vigencia del contrato ya finalizó.' });
        }
        const updatedContract = {
            ...contract,
            id,
            startDate,
            endDate,
            billingIntervalDays: contract.billingIntervalDays || 30,
            collectionStartedAt: today,
            updatedAt: new Date().toISOString()
        };
        await saveContract(updatedContract);
        return jsonResponse(response, 200, { contract: await getContractDetails(updatedContract) });
    }
    const chargePaymentRoute = path.match(/^\/api\/contracts\/([^/]+)\/charges\/([^/]+)\/payment$/);
    if (chargePaymentRoute && ['PUT', 'DELETE'].includes(method)) {
        const id = validateContractId(decodeURIComponent(chargePaymentRoute[1]));
        const dueDate = decodeURIComponent(chargePaymentRoute[2]);
        if (!isValidContractPaymentDate(dueDate)) {
            return jsonResponse(response, 400, { error: 'La fecha del cobro no es válida.' });
        }
        const contract = await getContract(id);
        if (!contract) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        const activationDate = getContractActivationDate(contract);
        if (!activationDate) {
            return jsonResponse(response, 400, { error: 'Primero debes empezar a cobrar este contrato.' });
        }
        const charges = await getContractCharges(id);
        const nextChargeDate = getNextChargeDueDate(contract, charges);
        const existingCharge = charges.find(charge => charge.dueDate === dueDate);
        if (method === 'PUT') {
            if (dueDate !== nextChargeDate) {
                return jsonResponse(response, 409, { error: 'Este ya no es el período de cobro pendiente.' });
            }
            const body = await readJson(request);
            const paidAt = validateContractPaymentDate(body?.paidAt);
            const today = getCurrentPanamaDate();
            if (paidAt < activationDate || paidAt > today) {
                return jsonResponse(response, 400, { error: 'La fecha de pago debe estar entre el inicio del cobro y hoy.' });
            }
            if (existingCharge?.paidAt) {
                return jsonResponse(response, 409, { error: 'Este cobro ya está pagado.' });
            }
            const amount = existingCharge?.amount ??
                Number(contract.defaultChargeAmount ?? contract.monthlyAmount);
            if (!Number.isFinite(amount) || amount <= 0) {
                return jsonResponse(response, 409, { error: 'Primero define el monto de este cobro.' });
            }
            await saveContractCharge(id, dueDate, amount, paidAt);
            return jsonResponse(response, 200, {
                charge: { dueDate, amount, paidAt },
                contract: await getContractDetails({ ...contract, id })
            });
        }
        if (!existingCharge) {
            return jsonResponse(response, 409, { error: 'No se encontró el período de cobro.' });
        }
        const latestPaidCharge = charges
            .filter(charge => charge.paidAt)
            .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
            .at(-1);
        if (!existingCharge.paidAt || latestPaidCharge?.dueDate !== dueDate) {
            return jsonResponse(response, 409, { error: 'Solo se puede revertir el pago más reciente.' });
        }
        await saveContractCharge(id, dueDate, existingCharge.amount);
        return jsonResponse(response, 200, {
            charge: { dueDate, amount: existingCharge.amount, paidAt: '' },
            contract: await getContractDetails({ ...contract, id })
        });
    }
    const contractChargeRoute = path.match(/^\/api\/contracts\/([^/]+)\/charges\/([^/]+)$/);
    if (contractChargeRoute && method === 'PUT') {
        const id = validateContractId(decodeURIComponent(contractChargeRoute[1]));
        const dueDate = decodeURIComponent(contractChargeRoute[2]);
        if (!isValidContractPaymentDate(dueDate)) {
            return jsonResponse(response, 400, { error: 'La fecha del cobro no es válida.' });
        }
        const contract = await getContract(id);
        if (!contract) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        if (!contract.collectionStartedAt) {
            return jsonResponse(response, 400, { error: 'Primero debes empezar a cobrar este contrato.' });
        }
        const charges = await getContractCharges(id);
        if (getNextChargeDueDate(contract, charges) !== dueDate) {
            return jsonResponse(response, 409, { error: 'Este ya no es el período de cobro pendiente.' });
        }
        const existingCharge = charges.find(charge => charge.dueDate === dueDate);
        if (existingCharge?.paidAt) {
            return jsonResponse(response, 409, { error: 'No se puede cambiar el monto de un cobro pagado.' });
        }
        const body = await readJson(request);
        const rawAmount = body?.amount;
        const amount = typeof rawAmount === 'number' ||
            (typeof rawAmount === 'string' && rawAmount.trim() !== '')
            ? Number(rawAmount)
            : Number.NaN;
        const roundedAmount = Math.round(amount * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 ||
            Math.abs(amount - roundedAmount) > 1e-8) {
            return jsonResponse(response, 400, { error: 'El monto del cobro debe ser mayor que cero y tener hasta dos decimales.' });
        }
        await saveContractCharge(id, dueDate, roundedAmount);
        return jsonResponse(response, 200, {
            charge: { dueDate, amount: roundedAmount, paidAt: '' },
            contract: await getContractDetails({ ...contract, id })
        });
    }
    const contractRoute = path.match(/^\/api\/contracts\/([^/]+)$/);
    if (contractRoute && method === 'DELETE') {
        const id = decodeURIComponent(contractRoute[1]);
        if (!await getContract(id)) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        if (!await deleteContract(id)) return jsonResponse(response, 404, { error: 'No se encontró el contrato.' });
        return jsonResponse(response, 200, { deleted: true });
    }
    const invoiceEmailRetryRoute = path.match(/^\/api\/invoices\/([^/]+)\/email\/retry$/);
    if (method === 'POST' && invoiceEmailRetryRoute) {
        const id = decodeURIComponent(invoiceEmailRetryRoute[1]);
        const invoice = await getInvoice(id);
        if (!invoice) return jsonResponse(response, 404, { error: 'No se encontró la factura.' });
        if (!invoice.automaticContract?.email) {
            return jsonResponse(response, 409, { error: 'Esta factura no tiene un envío automático pendiente.' });
        }
        if (invoice.automaticContract.email.status === 'sent') {
            return jsonResponse(response, 409, { error: 'La factura ya fue enviada por correo.' });
        }
        const updatedInvoice = await sendInvoiceWithStatus(invoice, await getIssuer());
        return jsonResponse(response, 200, { invoice: updatedInvoice });
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
            const validatedInvoice = validateInvoice({ ...input, id });
            const invoice = existing.automaticContract
                ? { ...validatedInvoice, automaticContract: existing.automaticContract }
                : validatedInvoice;
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

function millisecondsUntilPanamaMidnight() {
    const tomorrow = addContractDays(getCurrentPanamaDate(), 1);
    return Math.max(1000, Date.parse(`${tomorrow}T05:00:00.000Z`) - Date.now());
}

function scheduleLocalContractAutomation() {
    if (process.env.VERCEL === '1') return;
    contractAutomationTimer = setTimeout(async () => {
        try {
            const result = await processContractInvoiceAutomation();
            if (result.failed.length) {
                console.error('Scheduled contract invoice processing completed with failures:', result.failed);
            } else if (result.created || result.emailed) {
                console.log(`Scheduled contract invoices: ${result.created} created, ${result.emailed} emailed.`);
            }
        } catch (error) {
            console.error('Scheduled contract invoice processing failed:', error);
        } finally {
            scheduleLocalContractAutomation();
        }
    }, millisecondsUntilPanamaMidnight());
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
    if (!admin) {
        if (!configuredSetupToken) {
            throw new Error('Configura FACTURAPRO_SETUP_TOKEN en .env (mínimo 32 caracteres) antes de crear la cuenta administradora.');
        }
        setupTokenExpiresAt = Date.now() + 15 * 60 * 1000;
    }
    server = createServer(handleRequest);
    server.listen(port, host, () => {
        console.log(`FacturaPro listo en http://${host}:${port}`);
        console.log('Base de datos: Supabase Postgres');
        if (process.env.VERCEL !== '1') {
            processContractInvoiceAutomation().then(result => {
                if (result.failed.length) {
                    console.error('Startup contract invoice processing completed with failures:', result.failed);
                } else if (result.created || result.emailed) {
                    console.log(`Startup contract invoices: ${result.created} created, ${result.emailed} emailed.`);
                }
            }).catch(error => console.error('Startup contract invoice processing failed:', error));
            scheduleLocalContractAutomation();
        }
    });
}

function closeServer() {
    if (contractAutomationTimer) clearTimeout(contractAutomationTimer);
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

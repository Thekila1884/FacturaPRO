import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

let supabaseMock;
let vercelServer;
let vercelHandler;
let applicationHandler;
let baseUrl;
let cookie = '';
let lastSetCookieHeader = '';
const tables = {
    facturapro_admin: [],
    facturapro_settings: [],
    facturapro_invoices: [],
    facturapro_sessions: []
};
const loginAttempts = new Map();

function getPanamaDate(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Panama',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, days) {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function sendJson(response, status, data) {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
}

async function readBody(request) {
    let text = '';
    for await (const chunk of request) text += chunk;
    return text ? JSON.parse(text) : null;
}

function rowMatches(row, url) {
    return [...url.searchParams.entries()].every(([key, filter]) => {
        if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) return true;
        if (filter.startsWith('eq.')) return String(row[key]) === filter.slice(3);
        if (filter.startsWith('lt.')) return String(row[key]) < filter.slice(3);
        if (filter.startsWith('like.')) return String(row[key]).startsWith(filter.slice(5).replace(/[%*]$/, ''));
        return false;
    });
}

function projectRow(row, select) {
    if (!select || select === '*') return row;
    return Object.fromEntries(select.split(',').map(key => [key, row[key]]));
}

function startSupabaseMock() {
    supabaseMock = createHttpServer(async (request, response) => {
        try {
            assert.equal(request.headers.apikey, 'test-service-role-key');
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname.startsWith('/rest/v1/rpc/')) {
                const procedure = url.pathname.split('/').pop();
                const body = await readBody(request);
                const attempt = loginAttempts.get(body.p_attempt_key);
                if (procedure === 'facturapro_login_is_blocked') {
                    return sendJson(response, 200, Boolean(attempt?.blockedUntil > Date.now()));
                }
                if (procedure === 'facturapro_login_failure') {
                    const next = attempt || { failures: 0, windowStartedAt: Date.now() };
                    if (Date.now() - next.windowStartedAt >= 15 * 60 * 1000) {
                        next.failures = 0;
                        next.windowStartedAt = Date.now();
                    }
                    next.failures++;
                    if (next.failures >= 5) next.blockedUntil = Date.now() + 15 * 60 * 1000;
                    loginAttempts.set(body.p_attempt_key, next);
                    return sendJson(response, 200, null);
                }
                if (procedure === 'facturapro_login_success') {
                    loginAttempts.delete(body.p_attempt_key);
                    return sendJson(response, 200, null);
                }
                return sendJson(response, 404, { message: 'Unknown RPC' });
            }
            const table = url.pathname.split('/').pop();
            const rows = tables[table];
            if (!rows) return sendJson(response, 404, { message: 'Unknown table' });
            let matching = rows.filter(row => rowMatches(row, url));

            if (request.method === 'GET') {
                if (url.searchParams.has('order')) {
                    matching.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
                }
                const offset = Number(url.searchParams.get('offset') || 0);
                const limit = Number(url.searchParams.get('limit') || 1000);
                return sendJson(response, 200, matching.slice(offset, offset + limit)
                    .map(row => projectRow(row, url.searchParams.get('select'))));
            }

            if (request.method === 'POST') {
                const body = await readBody(request);
                const inputRows = Array.isArray(body) ? body : [body];
                for (const input of inputRows) {
                    const conflictKey = table === 'facturapro_admin' ? 'id'
                        : table === 'facturapro_settings' ? 'key'
                        : table === 'facturapro_sessions' ? 'token_hash' : 'id';
                    const index = rows.findIndex(row => row[conflictKey] === input[conflictKey]);
                    if (index >= 0) {
                        if (request.headers.prefer?.includes('ignore-duplicates')) continue;
                        if (request.headers.prefer?.includes('merge-duplicates')) rows[index] = { ...rows[index], ...input };
                        else return sendJson(response, 409, { message: 'duplicate key' });
                    } else {
                        rows.push(input);
                    }
                }
                response.writeHead(201, { 'Content-Type': 'application/json' });
                return response.end(request.headers.prefer?.includes('return=minimal') ? '' : JSON.stringify(inputRows));
            }

            if (request.method === 'PATCH') {
                const body = await readBody(request);
                matching.forEach(row => Object.assign(row, body));
                return sendJson(response, 200, matching);
            }

            if (request.method === 'DELETE') {
                const deleted = [...matching];
                tables[table] = rows.filter(row => !matching.includes(row));
                return sendJson(response, 200, deleted.map(row => projectRow(row, url.searchParams.get('select'))));
            }
            return sendJson(response, 405, { message: 'Unsupported method' });
        } catch (error) {
            sendJson(response, 500, { message: error.message });
        }
    });
    return new Promise(resolve => {
        supabaseMock.listen(0, '127.0.0.1', () => resolve(supabaseMock.address().port));
    });
}

async function api(path, { method = 'GET', body, expected = 200, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
        lastSetCookieHeader = setCookie;
        cookie = setCookie.split(';')[0];
    }
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`);
    return result;
}

before(async () => {
    const supabasePort = await startSupabaseMock();
    process.env.HOST = '127.0.0.1';
    process.env.SUPABASE_URL = `http://127.0.0.1:${supabasePort}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    process.env.FACTURAPRO_SETUP_TOKEN = 'test-initial-setup-token-000000000001';
    process.env.CRON_SECRET = 'test-contract-cron-secret-at-least-32-characters';
    process.env.RESEND_API_KEY = 'test-resend-api-key';
    process.env.RESEND_FROM_EMAIL = 'FacturaPro <facturacion@example.test>';
    process.env.VERCEL = '1';
    ({ default: vercelHandler } = await import('./api/index.mjs'));
    ({ handleRequest: applicationHandler } = await import('./server.mjs'));
    vercelServer = createHttpServer(vercelHandler);
    await new Promise(resolve => vercelServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${vercelServer.address().port}`;
});

after(async () => {
    if (vercelServer?.listening) {
        vercelServer.close();
        await once(vercelServer, 'close');
    }
    if (supabaseMock?.listening) {
        supabaseMock.close();
        await once(supabaseMock, 'close');
    }
});

test('server rejects a non-loopback listener', async () => {
    const process = spawn(globalThis.process.execPath, ['server.mjs'], {
        cwd: globalThis.process.cwd(),
        env: {
            ...globalThis.process.env,
            HOST: '0.0.0.0',
            SUPABASE_URL: 'http://127.0.0.1:1',
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
            VERCEL: ''
        },
        stdio: 'ignore'
    });
    const [exitCode] = await once(process, 'exit');
    assert.notEqual(exitCode, 0);
});

test('server requires a private setup token instead of logging one', async () => {
    const childEnv = {
        ...globalThis.process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        SUPABASE_URL: globalThis.process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
        VERCEL: ''
    };
    delete childEnv.FACTURAPRO_SETUP_TOKEN;
    const child = spawn(globalThis.process.execPath, ['server.mjs'], {
        cwd: globalThis.process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => output.push(chunk));
    const timeout = setTimeout(() => child.kill('SIGTERM'), 2000);
    const [exitCode] = await once(child, 'exit');
    clearTimeout(timeout);
    const logs = Buffer.concat(output).toString();

    assert.equal(exitCode, 1);
    assert.match(logs, /FACTURAPRO_SETUP_TOKEN/);
    assert.doesNotMatch(logs, /Código de configuración inicial/);
});

test('Vercel API function exports a callable handler', () => {
    assert.equal(typeof vercelHandler, 'function');
});

test('dispatches Vercel API rewrites to the requested backend path', async () => {
    const status = await api('/api?path=auth%2Fstatus');
    assert.deepEqual(status, { setupRequired: true, authenticated: false });
});

test('serves the compiled Tailwind stylesheet without the CDN runtime', async () => {
    const [htmlResponse, cssResponse] = await Promise.all([
        fetch(baseUrl),
        fetch(`${baseUrl}/tailwind.css`)
    ]);
    const html = await htmlResponse.text();
    const css = await cssResponse.text();
    assert.equal(htmlResponse.status, 200);
    assert.match(html, /href="\/tailwind\.css"/);
    assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get('content-type'), /text\/css/);
    assert.match(css, /\.hidden\s*\{\s*display:\s*none/);
});

test('build creates the Vercel public output directory with app assets', async () => {
    const [html, css] = await Promise.all([
        readFile('public/sistema_de_facturaci_n_comercial_panam_usd_itbms.html', 'utf8'),
        readFile('public/tailwind.css', 'utf8')
    ]);
    assert.match(html, /href="\/tailwind\.css"/);
    assert.match(css, /\.hidden\s*\{\s*display:\s*none/);
});

test('admin authentication protects Supabase-backed invoice operations', async () => {
    assert.deepEqual(await api('/api/auth/status'), { setupRequired: true, authenticated: false });
    await api('/api/bootstrap', { expected: 401 });
    await api('/api/clients', { expected: 401 });
    await api('/api/contracts', { expected: 401 });
    await api('/api/auth/setup', {
        method: 'POST',
        body: { username: 'admin', password: 'Correct-Horse-Battery-1' },
        expected: 403
    });
    await api('/api/auth/setup', {
        method: 'POST',
        body: { username: 'admin', password: 'short', setupToken: 'invalid' },
        expected: 403
    });
    await api('/api/auth/setup', {
        method: 'POST',
        body: { username: 'admin', password: 'short', setupToken: 'test-initial-setup-token-000000000001' },
        expected: 400
    });
    await api('/api/auth/setup', {
        method: 'POST',
        headers: { 'X-Forwarded-Proto': 'https' },
        body: {
            username: 'admin',
            password: 'Correct-Horse-Battery-1',
            setupToken: 'test-initial-setup-token-000000000001'
        },
        expected: 201
    });
    assert.match(lastSetCookieHeader, /;\s*Secure(?:;|$)/);
    assert.deepEqual((await api('/api/bootstrap')).invoices, []);

    const serverlessRequest = {
        method: 'POST',
        url: '/api/auth/login',
        headers: {
            host: 'facturapro.test',
            origin: 'https://facturapro.test',
            'x-forwarded-proto': 'https'
        },
        socket: null,
        async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify({
                username: 'admin',
                password: 'Correct-Horse-Battery-1'
            }));
        }
    };
    const serverlessResponse = {
        headers: {},
        writeHead(status, headers) {
            this.statusCode = status;
            Object.assign(this.headers, headers);
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(body) {
            this.body = body;
        }
    };
    await applicationHandler(serverlessRequest, serverlessResponse);
    assert.equal(serverlessResponse.statusCode, 200);
    assert.match(serverlessResponse.headers['Set-Cookie'], /;\s*Secure(?:;|$)/);

    assert.deepEqual((await api('/api/clients')).clients, []);
    const clients = [{
        id: 'client-1',
        name: 'Cliente de prueba',
        ruc: '123456-1-123',
        dv: '12',
        phone: '+507 6000-0000',
        email: 'cliente@example.com',
        address: 'Ciudad de Panamá'
    }];
    assert.deepEqual((await api('/api/clients', {
        method: 'PUT',
        body: { client: clients[0] }
    })).client, clients[0]);
    assert.deepEqual((await api('/api/clients')).clients, clients);
    const updatedClient = { ...clients[0], phone: '+507 6999-0000' };
    assert.deepEqual((await api('/api/clients', {
        method: 'PUT',
        body: { client: updatedClient }
    })).client, updatedClient);
    const secondClient = { ...clients[0], id: 'client-2', name: 'Segundo cliente', email: 'segundo@example.com' };
    await api('/api/clients', { method: 'PUT', body: { client: secondClient } });
    assert.deepEqual((await api('/api/clients')).clients, [updatedClient, secondClient]);
    await api('/api/clients', {
        method: 'PUT',
        body: { client: { ...updatedClient, email: 'correo-invalido' } },
        expected: 400
    });
    assert.deepEqual((await api('/api/clients')).clients, [updatedClient, secondClient]);

    const today = getPanamaDate();
    const newContract = {
        clientId: 'client-1',
        description: 'Soporte técnico',
        billingIntervalDays: 5,
        defaultChargeAmount: 100.5,
        startDate: today,
        endDate: '',
        notes: 'Atención remota'
    };
    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, defaultChargeAmount: 0 },
        expected: 400
    });
    const createdContract = (await api('/api/contracts', {
        method: 'PUT',
        body: newContract,
        expected: 201
    })).contract;
    assert.equal(createdContract.clientName, updatedClient.name);
    assert.equal(createdContract.billingIntervalDays, 5);
    assert.equal(createdContract.defaultChargeAmount, 100.5);
    assert.equal(createdContract.startDate, today);
    assert.deepEqual(createdContract.payments, []);
    assert.deepEqual((await api('/api/contracts')).contracts.map(({ id }) => id), [createdContract.id]);
    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, id: createdContract.id, endDate: addDays(today, -1) },
        expected: 400
    });
    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, billingIntervalDays: 31 },
        expected: 400
    });
    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, billingIntervalDays: 364 },
        expected: 400
    });
    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, clientId: 'unknown-client' },
        expected: 400
    });
    const contractPath = `/api/contracts/${createdContract.id}`;
    await api(`${contractPath}/collection/start`, { method: 'POST' });
    const activatedContract = (await api('/api/contracts')).contracts[0];
    const firstDueDate = addDays(today, 5);
    assert.equal(activatedContract.collectionStartedAt, today);
    assert.equal(activatedContract.nextChargeDate, firstDueDate);

    await api(`${contractPath}/charges/${firstDueDate}`, {
        method: 'PUT',
        body: { amount: 125.5 }
    });
    await api(`${contractPath}/charges/${firstDueDate}`, {
        method: 'PUT',
        body: { amount: 0.001 },
        expected: 400
    });
    const paymentPath = `${contractPath}/charges/${firstDueDate}/payment`;
    await api(paymentPath, { method: 'PUT', body: { paidAt: addDays(today, 1) }, expected: 400 });
    await api(paymentPath, { method: 'PUT', body: { paidAt: today } });
    const paidContract = (await api('/api/contracts')).contracts[0];
    assert.equal(paidContract.charges[0].amount, 125.5);
    assert.equal(paidContract.charges[0].paidAt, today);
    assert.equal(paidContract.nextChargeDate, addDays(firstDueDate, 5));

    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, id: createdContract.id, billingIntervalDays: 6 },
        expected: 400
    });
    await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, id: createdContract.id, defaultChargeAmount: 200.75 }
    });
    const updatedPlan = (await api('/api/contracts')).contracts[0];
    assert.equal(updatedPlan.defaultChargeAmount, 200.75);
    assert.equal(updatedPlan.charges[0].amount, 125.5);
    await api(paymentPath, { method: 'DELETE' });
    const reversedContract = (await api('/api/contracts')).contracts[0];
    assert.equal(reversedContract.charges[0].paidAt, '');
    assert.equal(reversedContract.nextChargeDate, firstDueDate);

    await api(`/api/contracts/${createdContract.id}`, { method: 'DELETE' });
    assert.deepEqual((await api('/api/contracts')).contracts, []);
    assert.equal(tables.facturapro_settings.some(row => row.key.startsWith(`contract-payment:${createdContract.id}:`)), false);
    assert.equal(tables.facturapro_settings.some(row => row.key.startsWith(`contract-charge:${createdContract.id}:`)), false);

    const annualContract = (await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, billingIntervalDays: 365, description: 'Plan anual' },
        expected: 201
    })).contract;
    assert.equal(annualContract.billingIntervalDays, 365);
    const annualContractPath = `/api/contracts/${annualContract.id}`;
    const activatedAnnualContract = (await api(`${annualContractPath}/collection/start`, {
        method: 'POST'
    })).contract;
    assert.equal(activatedAnnualContract.nextChargeDate, addDays(today, 365));
    await api(annualContractPath, { method: 'DELETE' });

    const earlyPaymentContract = (await api('/api/contracts', {
        method: 'PUT',
        body: { ...newContract, clientId: 'client-2', description: 'Pago anticipado', defaultChargeAmount: 50 },
        expected: 201
    })).contract;
    const earlyPaymentPath = `/api/contracts/${earlyPaymentContract.id}`;
    await api(`${earlyPaymentPath}/collection/start`, { method: 'POST' });
    const futureDueDate = addDays(today, 5);
    await api(`${earlyPaymentPath}/charges/${futureDueDate}/payment`, {
        method: 'PUT',
        body: { paidAt: today }
    });
    const earlyPaidContract = (await api('/api/contracts')).contracts
        .find(contract => contract.id === earlyPaymentContract.id);
    assert.equal(earlyPaidContract.nextChargeDate, addDays(futureDueDate, 5));
    assert.equal(earlyPaidContract.charges[0].amount, 50);
    await api(earlyPaymentPath, { method: 'DELETE' });

    await api('/api/cron/contracts', { expected: 401 });
    const automatedContract = (await api('/api/contracts', {
        method: 'PUT',
        body: {
            ...newContract,
            clientId: 'client-2',
            description: 'Servicio recurrente',
            defaultChargeAmount: 75,
            generateInvoices: true,
            sendInvoiceEmail: true,
            billItbms: false
        },
        expected: 201
    })).contract;
    assert.equal(automatedContract.generateInvoices, true);
    assert.equal(automatedContract.sendInvoiceEmail, true);
    assert.equal(automatedContract.billItbms, false);
    const automatedContractPath = `/api/contracts/${automatedContract.id}`;
    await api(`${automatedContractPath}/collection/start`, { method: 'POST' });
    const storedAutomatedContract = tables.facturapro_settings.find(row =>
        row.key === `contract:${automatedContract.id}`
    );
    storedAutomatedContract.value.collectionStartedAt = addDays(today, -6);

    const originalFetch = globalThis.fetch;
    const resendRequests = [];
    globalThis.fetch = async (input, options) => {
        if (String(input) === 'https://api.resend.com/emails') {
            resendRequests.push(JSON.parse(options.body));
            if (resendRequests.length === 1) {
                return new Response(JSON.stringify({
                    name: 'validation_error',
                    message: 'The example.com domain is not verified.'
                }), {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response(JSON.stringify({ id: `test-email-${resendRequests.length}` }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return originalFetch(input, options);
    };
    try {
        const automation = await api('/api/cron/contracts', {
            headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
            expected: 500
        });
        assert.equal(automation.failed.length, 1);
        assert.equal(automation.created, 1);
        assert.equal(automation.emailed, 0);
        assert.equal(resendRequests.length, 1);
        assert.equal(resendRequests[0].to[0], secondClient.email);
        assert.match(resendRequests[0].html, /Resumen de cargos/);
        assert.match(resendRequests[0].html, /TOTAL A PAGAR/);
        assert.match(resendRequests[0].text, /Fecha de vencimiento:/);
        const attachment = Buffer.from(resendRequests[0].attachments[0].content, 'base64');
        assert.equal(attachment.subarray(0, 5).toString(), '%PDF-');
        const generatedInvoice = (await api('/api/invoices')).invoices
            .find(item => item.automaticContract?.contractId === automatedContract.id);
        assert.ok(generatedInvoice);
        assert.equal(generatedInvoice.status, 'Pendiente');
        assert.equal(generatedInvoice.items[0].itbms, false);
        assert.equal(generatedInvoice.totals.grandTotal, 75);
        assert.equal(generatedInvoice.automaticContract.email.status, 'failed');
        assert.match(generatedInvoice.automaticContract.email.error, /HTTP 403/);
        assert.match(generatedInvoice.automaticContract.email.error, /domain is not verified/);
        const retryResult = await api(`/api/invoices/${generatedInvoice.id}/email/retry`, {
            method: 'POST',
            body: {}
        });
        assert.equal(retryResult.invoice.automaticContract.email.status, 'sent');
        const secondAutomation = await api('/api/cron/contracts', {
            headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }
        });
        assert.equal(secondAutomation.created, 0);
        assert.equal(secondAutomation.emailed, 0);
        assert.equal(resendRequests.length, 2);

        const staleEmailContract = (await api('/api/contracts', {
            method: 'PUT',
            body: {
                ...newContract,
                clientId: 'client-2',
                description: 'Servicio sin correo vigente',
                generateInvoices: true,
                sendInvoiceEmail: true
            },
            expected: 201
        })).contract;
        const staleEmailContractPath = `/api/contracts/${staleEmailContract.id}`;
        await api(`${staleEmailContractPath}/collection/start`, { method: 'POST' });
        tables.facturapro_settings.find(row =>
            row.key === `contract:${staleEmailContract.id}`
        ).value.collectionStartedAt = addDays(today, -6);
        await api('/api/clients', {
            method: 'PUT',
            body: { client: { ...secondClient, email: '' } }
        });
        const missingEmailAutomation = await api('/api/cron/contracts', {
            headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
            expected: 500
        });
        assert.equal(missingEmailAutomation.failed.length, 1);
        assert.equal(missingEmailAutomation.created, 1);
        assert.equal(resendRequests.length, 2);
        const invoiceWithoutCurrentEmail = (await api('/api/invoices')).invoices
            .find(item => item.automaticContract?.contractId === staleEmailContract.id);
        assert.ok(invoiceWithoutCurrentEmail);
        assert.equal(invoiceWithoutCurrentEmail.client.email, '');
        await api(`/api/invoices/${invoiceWithoutCurrentEmail.id}`, { method: 'DELETE' });
        await api(staleEmailContractPath, { method: 'DELETE' });
        await api('/api/clients', { method: 'PUT', body: { client: secondClient } });
        await api(`/api/invoices/${generatedInvoice.id}`, { method: 'DELETE' });

        const manualContract = (await api('/api/contracts', {
            method: 'PUT',
            body: {
                ...newContract,
                clientId: 'client-2',
                description: 'Servicio con factura manual'
            },
            expected: 201
        })).contract;
        const manualContractPath = `/api/contracts/${manualContract.id}`;
        await api(`${manualContractPath}/collection/start`, { method: 'POST' });
        const manualInvoiceResult = await api(`${manualContractPath}/invoices`, {
            method: 'POST',
            body: {}
        });
        assert.equal(manualInvoiceResult.created, true);
        assert.equal(manualInvoiceResult.emailed, true);
        assert.equal(manualInvoiceResult.invoice.automaticContract.contractId, manualContract.id);
        assert.equal(manualInvoiceResult.invoice.dueDate, addDays(today, 5));
        assert.equal(resendRequests.length, 3);
        const repeatedManualInvoice = await api(`${manualContractPath}/invoices`, {
            method: 'POST',
            body: {}
        });
        assert.equal(repeatedManualInvoice.created, false);
        assert.equal(repeatedManualInvoice.alreadySent, true);
        assert.equal(repeatedManualInvoice.invoice.id, manualInvoiceResult.invoice.id);
        assert.equal(resendRequests.length, 3);
        assert.equal((await api('/api/invoices')).invoices
            .filter(invoice => invoice.automaticContract?.contractId === manualContract.id).length, 1);
        await api(`/api/invoices/${manualInvoiceResult.invoice.id}`, { method: 'DELETE' });
        await api(manualContractPath, { method: 'DELETE' });
    } finally {
        globalThis.fetch = originalFetch;
    }

    await api('/api/clients/client-1', { method: 'DELETE' });
    assert.deepEqual((await api('/api/clients')).clients, [secondClient]);
    await api('/api/clients/client-1', { method: 'DELETE', expected: 404 });
    await api('/api/clients/client-2', { method: 'DELETE' });

    const issuer = await api('/api/settings/issuer', {
        method: 'PUT',
        body: { name: 'Empresa de prueba', achDetails: 'Banco y cuenta ACH de prueba' }
    });
    assert.equal(issuer.issuer.achDetails, 'Banco y cuenta ACH de prueba');
    assert.equal(issuer.issuer.paymentDetails['Transferencia Bancaria (ACH)'], 'Banco y cuenta ACH de prueba');

    const paymentDetails = {
        'Transferencia Bancaria (ACH)': 'Cuenta ACH actualizada',
        'Yappy Comercial': 'Yappy de prueba'
    };
    const updatedIssuer = await api('/api/settings/issuer', {
        method: 'PUT',
        body: { name: 'Empresa de prueba', paymentDetails }
    });
    assert.equal(updatedIssuer.issuer.paymentDetails['Transferencia Bancaria (ACH)'], 'Cuenta ACH actualizada');
    assert.equal(updatedIssuer.issuer.paymentDetails['Yappy Comercial'], 'Yappy de prueba');
    await api('/api/settings/issuer', {
        method: 'PUT',
        body: { paymentDetails: { 'Yappy Comercial': 'x'.repeat(501) } },
        expected: 400
    });
    const bootstrap = await api('/api/bootstrap');
    const bootstrappedIssuer = bootstrap.issuer;
    assert.equal(bootstrap.resendConfigured, true);
    assert.equal(bootstrappedIssuer.achDetails, 'Cuenta ACH actualizada');
    assert.equal(bootstrappedIssuer.paymentDetails['Yappy Comercial'], 'Yappy de prueba');

    const invoice = {
        id: 'test-invoice',
        number: 'FAC-0001',
        status: 'Pendiente',
        date: '2026-11-18',
        dueDate: '2026-12-03',
        paymentTerms: 'Contado',
        client: { name: 'Cliente de prueba' },
        items: [{ id: 1, qty: 1, price: 100, description: 'Servicio', itbms: true }],
        discountType: 'none',
        discountValue: 0,
        notes: '',
        totals: { grandTotal: 0 }
    };
    const saved = await api('/api/invoices', { method: 'POST', body: invoice, expected: 201 });
    assert.equal(saved.invoice.totals.grandTotal, 107);
    await api('/api/invoices', {
        method: 'POST',
        body: { ...invoice, id: 'invalid-date-invoice', dueDate: '2026-02-31' },
        expected: 400
    });
    assert.equal((await api('/api/invoices/test-invoice/status', {
        method: 'PATCH',
        body: { status: 'Pagada' }
    })).invoice.status, 'Pagada');

    await api('/api/auth/logout', { method: 'POST', body: {} });
    assert.deepEqual(await api('/api/auth/status'), { setupRequired: false, authenticated: false });
    await api('/api/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'incorrect-password' },
        expected: 401
    });
    await api('/api/auth/login', {
        method: 'POST',
        body: { username: 'admin', password: 'Correct-Horse-Battery-1' }
    });
    assert.equal((await api('/api/invoices')).invoices[0].status, 'Pagada');

    await api('/api/invoices/test-invoice', { method: 'DELETE' });
    const migrated = await api('/api/migrate', {
        method: 'POST',
        body: {
            issuer: { name: 'Empresa migrada' },
            invoices: [{ ...invoice, id: 'legacy-1', number: 'FAC-LEGACY' }]
        }
    });
    assert.equal(migrated.issuer.name, 'Empresa migrada');
    assert.equal(migrated.invoices[0].id, 'legacy-1');
});

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';

let supabaseMock;
let vercelServer;
let vercelHandler;
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
    process.env.VERCEL = '1';
    ({ default: vercelHandler } = await import('./api/index.mjs'));
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

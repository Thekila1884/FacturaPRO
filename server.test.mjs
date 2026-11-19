import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';

let serverProcess;
let supabaseMock;
let baseUrl;
let cookie = '';
let lastSetCookieHeader = '';
const tables = {
    facturapro_admin: [],
    facturapro_settings: [],
    facturapro_invoices: []
};

async function findAvailablePort() {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const { port } = probe.address();
    await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    return port;
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
        if (!filter.startsWith('eq.')) return false;
        return String(row[key]) === filter.slice(3);
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
                        : table === 'facturapro_settings' ? 'key' : 'id';
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
    const port = await findAvailablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    serverProcess = spawn(process.execPath, ['server.mjs'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: String(port),
            SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
            FACTURAPRO_SETUP_TOKEN: 'test-initial-setup-token-000000000001'
        },
        stdio: 'ignore'
    });
    for (let attempt = 0; attempt < 50; attempt++) {
        if (serverProcess.exitCode !== null) throw new Error(`Server exited with code ${serverProcess.exitCode}`);
        try {
            const response = await fetch(`${baseUrl}/api/auth/status`);
            if (response.ok) return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw new Error('Server did not become ready.');
});

after(async () => {
    if (serverProcess && serverProcess.exitCode === null) {
        serverProcess.kill('SIGTERM');
        await once(serverProcess, 'exit');
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
            SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
        },
        stdio: 'ignore'
    });
    const [exitCode] = await once(process, 'exit');
    assert.notEqual(exitCode, 0);
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

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const databasePath = join(resolve(process.env.FACTURAPRO_DATA_DIR || join(root, 'data')), 'facturapro.sqlite');
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el archivo .env.');
}
const supabaseOrigin = new URL(supabaseUrl);
if (supabaseOrigin.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '::1'].includes(supabaseOrigin.hostname)) {
    throw new Error('SUPABASE_URL debe usar HTTPS.');
}
if (!existsSync(databasePath)) {
    throw new Error(`No se encontró la base SQLite local: ${databasePath}`);
}

async function supabaseRequest(table, query = '', options = {}) {
    const response = await fetch(`${supabaseUrl}/rest/v1/${table}${query ? `?${query}` : ''}`, {
        method: options.method || 'GET',
        headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
            ...(options.prefer ? { Prefer: options.prefer } : {})
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Supabase rechazó la migración (${response.status}) en la tabla ${table}.`);
    }
    return text ? JSON.parse(text) : [];
}

async function listRemoteInvoiceIds() {
    const ids = new Set();
    for (let offset = 0; ; offset += 1000) {
        const rows = await supabaseRequest(
            'facturapro_invoices',
            `select=id&limit=1000&offset=${offset}`
        );
        rows.forEach(row => ids.add(row.id));
        if (rows.length < 1000) return ids;
    }
}

async function main() {
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const localAdmin = db.prepare('SELECT username, salt, password_hash FROM admin WHERE id = 1').get();
        const localSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('issuer');
        const localInvoices = db.prepare('SELECT id, number, payload, updated_at FROM invoices').all()
            .map(row => ({ ...row, payload: JSON.parse(row.payload) }));

        const remoteAdmins = await supabaseRequest(
            'facturapro_admin',
            'select=id&limit=1'
        );
        if (localAdmin && remoteAdmins.length === 0) {
            await supabaseRequest('facturapro_admin', '', {
                method: 'POST',
                prefer: 'return=minimal',
                body: { id: true, ...localAdmin }
            });
            console.log('Cuenta administradora importada (hash de contraseña).');
        } else if (remoteAdmins.length > 0) {
            console.log('Supabase ya tiene una cuenta administradora; no se modificó.');
        }

        if (localSetting) {
            const remoteSettings = await supabaseRequest(
                'facturapro_settings',
                `select=key&key=eq.${encodeURIComponent('issuer')}&limit=1`
            );
            if (remoteSettings.length === 0) {
                await supabaseRequest('facturapro_settings', 'on_conflict=key', {
                    method: 'POST',
                    prefer: 'resolution=merge-duplicates,return=minimal',
                    body: { key: 'issuer', value: JSON.parse(localSetting.value) }
                });
                console.log('Datos de la empresa importados.');
            }
        }

        const remoteIds = await listRemoteInvoiceIds();
        const missingInvoices = localInvoices
            .filter(invoice => !remoteIds.has(invoice.id))
            .map(invoice => ({
                id: invoice.id,
                number: invoice.number,
                payload: invoice.payload,
                updated_at: invoice.updated_at
            }));
        for (let offset = 0; offset < missingInvoices.length; offset += 500) {
            await supabaseRequest('facturapro_invoices', 'on_conflict=id', {
                method: 'POST',
                prefer: 'resolution=ignore-duplicates,return=minimal',
                body: missingInvoices.slice(offset, offset + 500)
            });
        }
        console.log(`${missingInvoices.length} factura(s) importada(s); ${remoteIds.size} ya existían.`);
    } finally {
        db.close();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});

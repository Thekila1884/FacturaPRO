import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('./sistema_de_facturaci_n_comercial_panam_usd_itbms.html', import.meta.url), 'utf8');
const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(inlineScript, 'The app must contain its inline script');

function createAppContext(elements = {}, documentOverrides = {}) {
    const context = vm.createContext({
        document: {
            addEventListener() {},
            getElementById(id) {
                if (!elements[id]) throw new Error(`Unexpected element lookup: ${id}`);
                return elements[id];
            },
            ...documentOverrides
        },
        window: {}
    });
    vm.runInContext(inlineScript, context);
    return context;
}

test('invoice CSV exports keep all invoice and line fields and resist formulas', () => {
    const context = createAppContext();
    const result = JSON.parse(vm.runInContext(`JSON.stringify(invoiceCsvRows([{
        id: 'inv-1',
        number: 'FAC-1',
        status: 'Pendiente',
        date: '2026-03-01',
        dueDate: '2026-03-10',
        paymentTerms: 'Contado',
        client: { name: '=2+2', ruc: '123', dv: '1', phone: '555', email: 'a@example.test', address: 'Calle 1' },
        items: [{ id: 'line-1', qty: 2, price: 10, description: 'Servicio', itbms: true }],
        discountType: 'none',
        discountValue: 0,
        notes: 'Nota',
        totals: { exempt: 0, taxable: 20, subtotal: 20, discount: 0, itbms: 1.4, grandTotal: 21.4 },
        updatedAt: '2026-03-01T12:00:00.000Z'
    }]))`, context));

    assert.equal(result.length, 1);
    assert.equal(result[0].length, 28);
    assert.equal(result[0][17], 'Servicio');
    assert.equal(result[0][26], 21.4);
    assert.equal(vm.runInContext(`csvCell('=2+2')`, context), `"\'=2+2"`);

    const moduleCsv = JSON.parse(vm.runInContext(`JSON.stringify(buildInvoiceModuleCsv([{
        id: 'inv-1', items: [{ id: 'line-1' }]
    }], [['Total USD', 21.4]]))`, context));
    assert.equal(moduleCsv.rows.length, 2);
    assert.equal(moduleCsv.rows[0][0], 'Resumen');
    assert.equal(moduleCsv.rows[1][0], 'Detalle');
    assert.ok(moduleCsv.rows.every(row => row.length === moduleCsv.headers.length));
});

test('receivables snapshot preserves aging buckets for pending invoices', () => {
    const context = createAppContext({ 'receivables-as-of': { value: '2026-03-01' } });
    vm.runInContext(`savedInvoices = [
        { id: 'today', status: 'Pendiente', dueDate: '2026-03-01', totals: { grandTotal: 10 } },
        { id: '30', status: 'Pendiente', dueDate: '2026-02-15', totals: { grandTotal: 20 } },
        { id: '60', status: 'Pendiente', dueDate: '2026-01-15', totals: { grandTotal: 30 } },
        { id: 'over60', status: 'Pendiente', dueDate: '2025-12-20', totals: { grandTotal: 40 } },
        { id: 'noDate', status: 'Pendiente', dueDate: '', totals: { grandTotal: 50 } },
        { id: 'paid', status: 'Pagada', dueDate: '2025-12-20', totals: { grandTotal: 60 } }
    ]`, context);
    const snapshot = JSON.parse(vm.runInContext('JSON.stringify(getReceivablesSnapshot())', context));

    assert.deepEqual(snapshot.buckets, { current: 10, days1to30: 20, days31to60: 30, over60: 40, noDueDate: 50 });
    assert.equal(snapshot.rows.length, 5);
    assert.equal(snapshot.rows[0].daysLate, 71);
    assert.equal(snapshot.rows.at(-1).daysLate, null);
});

test('contract interval dates handle leap days and distinguish payment statuses', () => {
    const context = createAppContext();
    const snapshot = JSON.parse(vm.runInContext(`JSON.stringify({
        leapDay: addContractDays('2024-02-28', 1),
        invalidDate: addContractDays('2025-02-30', 5),
        invalidInterval: addContractDays('2025-02-28', 31),
        overdue: getChargeStatus('2025-02-28', '', '2025-03-01'),
        paid: getChargeStatus('2025-02-28', '2025-02-28', '2025-03-01')
    })`, context));

    assert.equal(snapshot.leapDay, '2024-02-29');
    assert.equal(snapshot.invalidDate, '');
    assert.equal(snapshot.invalidInterval, '');
    assert.equal(snapshot.overdue, 'Vencido');
    assert.equal(snapshot.paid, 'Pagado');
});

test('recurring contract view renders its next period and amount controls', () => {
    const makeElement = () => ({
        children: [],
        classList: { toggle() {} },
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener() {},
        setAttribute() {}
    });
    const elements = {
        'contract-payments-tbody': makeElement(),
        'contract-month-count': makeElement(),
        'contract-month-expected': makeElement(),
        'contract-month-paid': makeElement(),
        'contract-month-overdue': makeElement(),
        'contract-payments-empty': makeElement()
    };
    const context = createAppContext(elements, { createElement: makeElement });
    const today = vm.runInContext('getTodayISO()', context);
    const dueDate = vm.runInContext(`addContractDays('${today}', 5)`, context);
    vm.runInContext(`savedContracts = [{
        id: 'contract-1',
        clientId: 'client-1',
        clientName: 'Cliente',
        description: 'Soporte',
        billingIntervalDays: 5,
        defaultChargeAmount: 125,
        startDate: '${today}',
        endDate: '',
        collectionStartedAt: '${today}',
        charges: [],
        payments: []
    }]; renderContractPayments('${dueDate.slice(0, 7)}')`, context);

    assert.equal(elements['contract-month-count'].textContent, '1');
    assert.equal(elements['contract-month-expected'].textContent, '$125.00');
    const row = elements['contract-payments-tbody'].children[0];
    assert.equal(row.children[1].textContent, dueDate.split('-').reverse().join('/'));
    assert.equal(row.children[2].children[0].value, '125');
    const actionGroup = row.children[4].children[0];
    assert.equal(actionGroup.children[0].textContent, 'Cambiar monto');
    assert.equal(actionGroup.children[2].textContent, 'Registrar pago');
});

test('contract next charge uses the configured interval after payment', () => {
    const context = createAppContext();
    const snapshot = JSON.parse(vm.runInContext(`JSON.stringify({
        nextDate: getContractNextChargeDate({
            collectionStartedAt: '2025-02-01',
            billingIntervalDays: 5,
            endDate: '',
            charges: [{ dueDate: '2025-02-06', amount: 125, paidAt: '2025-02-08' }]
        }),
        earlyPaymentNextDate: getContractNextChargeDate({
            collectionStartedAt: '2025-02-01',
            billingIntervalDays: 5,
            endDate: '',
            charges: [{ dueDate: '2025-02-06', amount: 125, paidAt: '2025-02-02' }]
        })
    })`, context));

    assert.equal(snapshot.nextDate, '2025-02-13');
    assert.equal(snapshot.earlyPaymentNextDate, '2025-02-11');
});

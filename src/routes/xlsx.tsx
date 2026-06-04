import { createSignal, type Component } from 'solid-js';
import { Button } from '@/registry/ui/button';
import { TopBar } from '@/components/top-bar';
import { exportRowsToXlsx, type ColumnSpec } from '@/lib/export/xlsx';

const SAMPLE_ROWS: Record<string, unknown>[] = [
    { id: 1, name: 'Widget', qty: 42, price: 9.99 },
    { id: 2, name: 'Gadget', qty: 7, price: 19.5 },
    { id: 3, name: 'Sprocket', qty: 128, price: 0.85 },
];

const STYLED_COLUMNS: ColumnSpec[] = [
    { key: 'id', header: 'ID', width: 6, numFmt: '0' },
    { key: 'name', header: 'Name', width: 18 },
    { key: 'qty', header: 'Qty', width: 8, numFmt: '#,##0' },
    { key: 'price', header: 'Price', width: 10, numFmt: '0.00' },
];

const XlsxPage: Component = () => {
    const [lastExport, setLastExport] = createSignal<string | null>(null);

    const onPlain = () => {
        const filename = `plain-${Date.now()}.xlsx`;
        exportRowsToXlsx(SAMPLE_ROWS, filename);
        setLastExport(filename);
    };

    const onStyled = () => {
        const filename = `styled-${Date.now()}.xlsx`;
        exportRowsToXlsx(SAMPLE_ROWS, filename, { columns: STYLED_COLUMNS });
        setLastExport(filename);
    };

    return (
        <main class="h-svh flex flex-col bg-background text-foreground">
            <TopBar />

            <div class="flex-1 min-h-0 p-6 flex flex-col gap-6 max-w-2xl">
                <header class="flex flex-col gap-1">
                    <h1 class="text-lg font-semibold">SheetJS smoke test</h1>
                    <p class="text-xs text-muted-foreground">Community Edition + styles patch</p>
                </header>
                <section class="flex flex-col gap-3">
                    <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Sample data
                    </div>
                    <pre class="text-xs font-mono bg-card border rounded p-3 overflow-auto">
                        {JSON.stringify(SAMPLE_ROWS, null, 2)}
                    </pre>
                </section>

                <section class="flex flex-col gap-3">
                    <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Export
                    </div>
                    <div class="flex items-center gap-3">
                        <Button variant="secondary" onClick={onPlain}>
                            Download plain.xlsx
                        </Button>
                        <Button onClick={onStyled}>Download styled.xlsx</Button>
                        {lastExport() && (
                            <span class="text-xs text-muted-foreground font-mono">
                                wrote {lastExport()}
                            </span>
                        )}
                    </div>
                    <div class="text-xs text-muted-foreground">
                        Styled: bold + slate header row, ID/Qty/Price number formats, per-column
                        widths.
                    </div>
                </section>

                <section class="flex flex-col gap-3 opacity-60">
                    <div class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Import (no-op for now)
                    </div>
                    {/* TODO: next task — parse with XLSX.read() and display the rows. */}
                    <input type="file" accept=".xlsx,.xls,.csv" disabled class="text-sm" />
                </section>
            </div>
        </main>
    );
};

export default XlsxPage;

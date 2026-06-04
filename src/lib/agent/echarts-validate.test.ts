import { describe, expect, it } from 'vitest';
import { validateEchartsOption } from './echarts-validate';

describe('validateEchartsOption', () => {
    it('accepts a simple single-chart line option', async () => {
        const option = {
            xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar', 'Apr'] },
            yAxis: { type: 'value' },
            series: [{ type: 'line', data: [120, 200, 150, 80] }],
        };
        const res = await validateEchartsOption(option);
        expect(res.ok).toBe(true);
    });

    it('hard-rejects a multi-grid layout with a guidance message', async () => {
        const option = {
            title: [
                { text: 'Chart 1', left: 'center', top: '0%' },
                { text: 'Chart 2', left: 'center', top: '50%' },
            ],
            grid: [
                { left: '10%', right: '10%', top: '10%', height: '35%' },
                { left: '10%', right: '10%', top: '60%', height: '35%' },
            ],
            xAxis: [
                { type: 'category', data: ['Jan', 'Feb'], gridIndex: 0 },
                { type: 'category', data: ['Jan', 'Feb'], gridIndex: 1 },
            ],
            yAxis: [
                { type: 'value', gridIndex: 0 },
                { type: 'value', gridIndex: 1 },
            ],
            series: [
                { type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: [1, 2] },
                { type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: [3, 4] },
            ],
        };
        const res = await validateEchartsOption(option);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/array of options/i);
        }
    });

    it('accepts an array of single-chart options as the dashboard form', async () => {
        const charts = [
            {
                title: { text: 'Chart 1', left: 'center' },
                xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ name: 'Sales', type: 'line', data: [120, 200, 150] }],
            },
            {
                title: { text: 'Chart 2', left: 'center' },
                xAxis: { type: 'category', data: ['Jan', 'Feb', 'Mar'] },
                yAxis: { type: 'value' },
                series: [{ name: 'Users', type: 'bar', data: [500, 700, 600] }],
            },
        ];
        const res = await validateEchartsOption(charts);
        expect(res.ok).toBe(true);
    });

    it('prefixes array-element failures with [chart N]', async () => {
        const charts = [
            {
                xAxis: { type: 'category', data: ['a', 'b'] },
                yAxis: { type: 'value' },
                series: [{ type: 'line', data: [1, 2] }],
            },
            {
                grid: [
                    { left: '10%', top: '10%', height: '35%' },
                    { left: '10%', top: '60%', height: '35%' },
                ],
                xAxis: { type: 'category', data: ['a', 'b'] },
                yAxis: { type: 'value' },
                series: [{ type: 'line', data: [1, 2] }],
            },
        ];
        const res = await validateEchartsOption(charts);
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toMatch(/\[chart 1\]/);
            expect(res.error).toMatch(/array of options/i);
        }
    });

    it('flags an unknown axis type via captured warnings', async () => {
        const option = {
            xAxis: { type: 'frobulator', data: ['a', 'b'] },
            yAxis: { type: 'value' },
            series: [{ type: 'line', data: [1, 2] }],
        };
        const res = await validateEchartsOption(option);
        // ECharts may either throw or warn — accept either, but the bad type
        // must surface somewhere the model can see it.
        const surfaced =
            (!res.ok && /frobulator|type/i.test(res.error)) ||
            res.warnings.some((w) => /frobulator|axis|type/i.test(w));
        expect(surfaced).toBe(true);
    });

    it('flags an unknown series type', async () => {
        const option = {
            xAxis: { type: 'category', data: ['a', 'b'] },
            yAxis: { type: 'value' },
            series: [{ type: 'noodleplot', data: [1, 2] }],
        };
        const res = await validateEchartsOption(option);
        const surfaced =
            (!res.ok && /noodleplot|series|type/i.test(res.error)) ||
            res.warnings.some((w) => /noodleplot|series|type/i.test(w));
        expect(surfaced).toBe(true);
    });

    it('does not throw on an empty option object (returns ok with possible warnings)', async () => {
        const res = await validateEchartsOption({});
        // ECharts tolerates empty options at setOption time. The validator
        // should not throw — it returns ok:true; absence of series is a
        // semantic problem, not a schema error.
        expect(res.ok).toBe(true);
    });

    it('can be called repeatedly without leaking instances', async () => {
        const option = {
            xAxis: { type: 'category', data: ['a'] },
            yAxis: { type: 'value' },
            series: [{ type: 'line', data: [1] }],
        };
        for (let i = 0; i < 10; i++) {
            const res = await validateEchartsOption(option);
            expect(res.ok).toBe(true);
        }
    });
});

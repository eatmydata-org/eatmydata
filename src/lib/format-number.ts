/**
 * Convert a number to its decimal string representation without ever
 * using scientific notation. `Number.toString()` switches to exponent
 * form below 1e-6 (e.g. `0.0000001` → `"1e-7"`) and above 1e21 — this
 * helper rewrites the exponent form into plain digits.
 *
 * The output is the shortest round-trip representation of the value
 * (same as `n.toString()` for non-exponent numbers), so float64
 * imprecision artifacts like `(0.1).toFixed(20)` →
 * `"0.10000000000000000555"` are avoided.
 */
export function toDecimalString(n: number): string {
    if (!Number.isFinite(n)) return String(n);
    if (n === 0) return '0';
    const s = n.toString();
    if (!/e/i.test(s)) return s;

    const [mantissa, expStr] = s.split(/e/i) as [string, string];
    const exp = parseInt(expStr, 10);
    const negative = mantissa.startsWith('-');
    const absMantissa = negative ? mantissa.slice(1) : mantissa;
    const [intPart, fracPart = ''] = absMantissa.split('.') as [string, string?];
    const sign = negative ? '-' : '';

    if (exp >= 0) {
        const digits = intPart + fracPart;
        if (exp >= fracPart.length) {
            return sign + digits + '0'.repeat(exp - fracPart.length);
        }
        const split = intPart.length + exp;
        return sign + digits.slice(0, split) + '.' + digits.slice(split);
    }

    const absExp = -exp;
    if (absExp >= intPart.length) {
        return (
            sign +
            '0.' +
            '0'.repeat(absExp - intPart.length) +
            intPart +
            fracPart
        );
    }
    const split = intPart.length - absExp;
    return sign + intPart.slice(0, split) + '.' + intPart.slice(split) + fracPart;
}

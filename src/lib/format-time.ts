/**
 * Render an epoch-millis timestamp as a compact "time ago" string:
 * `just now`, `5m ago`, `3h ago`, `2d ago`, then falls back to a locale
 * date once it's older than a week.
 */
export function formatAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return new Date(ts).toLocaleDateString();
}

/**
 * The sqlite SharedWorker generates a fresh session id at boot and
 * stamps it onto every 'temp' data source. On the *next* fresh boot
 * (i.e. all tabs closed → worker died → reopen), any temp source whose
 * sessionId doesn't match the new boot is considered abandoned and
 * cleaned up (OPFS file + IDB row removed).
 *
 * The id lives only in worker memory; nothing persists it. This is
 * intentional — a persisted id would defeat the lifetime semantics.
 */
let currentSessionId: string | null = null;

export function getWorkerSessionId(): string {
    if (currentSessionId === null) {
        currentSessionId = crypto.randomUUID();
    }
    return currentSessionId;
}

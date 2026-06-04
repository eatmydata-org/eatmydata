/**
 * Human-readable labels for tool calls shown in the chat UI.
 *
 * Render-time only: this map is NOT part of any tool's config (so it never
 * reaches the model, the AI-SDK serializer, storage, or the debug log) and
 * NOT part of any persisted MessagePart (we store the raw `toolName` and
 * resolve the label here when rendering). If you add or rename a tool in
 * `src/lib/agent/tools.ts`, mirror the label here.
 */
const TOOL_LABELS: Record<string, string> = {
    propose_plan: 'Propose plan',
    list_tables: 'List tables',
    describe_table: 'Inspect table',
    data_sample: 'Sample rows',
    save_query: 'Save query',
    work_on_action: 'Work on action',
    save_data_source: 'Save data source',
    run_in_sandbox: 'Run code',
    validate_echarts: 'Validate chart',
};

export function toolDisplayName(name: string): string {
    return TOOL_LABELS[name] ?? `Tool ${name}`;
}

#!/usr/bin/env python3
"""
PostToolUse hook: block writes that introduce NULL bytes (\x00) into
text source files.

Triggered once on Edit/Write/NotebookEdit. Reads the just-written file,
fails the tool call (exit 2) if any null byte is present. The failure
message is fed back to Claude so it can re-write the file cleanly in
the same turn.

Background: while polishing the OPFS code review, an Edit replaced a
template literal's spaces with NULL bytes — silent corruption that only
surfaced when a `.startsWith(' ')` check stopped matching. This hook
prevents that class of bug from re-landing on disk.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Only inspect file types that should never contain NUL.
TEXT_SUFFIXES = {
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.md', '.css', '.html', '.svg',
    '.py', '.sh', '.yml', '.yaml', '.toml',
}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Malformed payload — don't block the user's work.
        return 0

    tool_name = payload.get('tool_name', '')
    if tool_name not in ('Edit', 'Write', 'NotebookEdit'):
        return 0

    tool_input = payload.get('tool_input') or {}
    file_path = tool_input.get('file_path') or tool_input.get('notebook_path')
    if not file_path:
        return 0

    p = Path(file_path)
    if p.suffix.lower() not in TEXT_SUFFIXES:
        return 0
    try:
        data = p.read_bytes()
    except FileNotFoundError:
        return 0
    except OSError:
        return 0

    if b'\x00' not in data:
        return 0

    count = data.count(b'\x00')
    # Find the line numbers containing nulls so the report is actionable.
    bad_lines: list[int] = []
    for i, line in enumerate(data.splitlines(), start=1):
        if b'\x00' in line:
            bad_lines.append(i)
        if len(bad_lines) >= 5:
            break

    print(
        f'BLOCKED: {count} NUL byte(s) (\\x00) found in {file_path}',
        file=sys.stderr,
    )
    print(
        'NUL bytes in source files are almost always corruption (e.g. an '
        'edit that meant to insert spaces wrote \\x00 instead). They are '
        'invisible in most viewers but break startsWith/regex/comparisons.',
        file=sys.stderr,
    )
    if bad_lines:
        lines_fmt = ', '.join(str(n) for n in bad_lines)
        more = ' (and more)' if count > len(bad_lines) else ''
        print(
            f'Affected line(s): {lines_fmt}{more}',
            file=sys.stderr,
        )
    print(
        'Re-read the file, rewrite the affected region cleanly (use '
        'Write to overwrite if Edit keeps reintroducing NULs), and try '
        'again.',
        file=sys.stderr,
    )
    # Exit code 2 fails the tool call and surfaces stderr back to Claude.
    return 2


if __name__ == '__main__':
    sys.exit(main())

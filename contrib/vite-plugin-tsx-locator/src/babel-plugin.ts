/// Dev-only Babel pass that marks **component boundaries** in the DOM. Each
/// Solid component's root host element is stamped with
/// `data-tsx-element="<Component>@<relpath>:<line>"`, e.g.
/// `data-tsx-element="ChatView@src/components/chat-view.tsx:69"`. Inspecting any
/// node in the browser, the nearest ancestor carrying this attribute is the
/// component that owns it — so you can find the "closest module border" and
/// jump straight to its source (see the `tsxLocator()` Vite plugin for the
/// click-to-open half).
///
/// Only one element per component is tagged (its returned root), not every
/// node. A component whose root is *another* component isn't tagged here — that
/// inner component is the real border and carries its own tag.
///
/// It is meant to ride the Babel transform `vite-plugin-solid` already runs on
/// every `.tsx` file:
///
///   solid({ babel: { plugins: [tsxElementBabelPlugin({ root })] } })
///
/// so it adds no build step. The work happens in a `Program`-enter `traverse`
/// so the attributes are in place *before* `babel-preset-solid` folds each
/// static subtree into a `_$template(...)` string (a plain `JSXElement` visitor
/// runs too late — dom-expressions has already consumed the element).

import { relative } from 'node:path';
import type * as BabelCore from '@babel/core';
import type { PluginObj, PluginPass } from '@babel/core';

type Node = BabelCore.types.Node;
type JSXElement = BabelCore.types.JSXElement;
type Expression = BabelCore.types.Expression;

const ATTR = 'data-tsx-element';

// Solid's transparent / control-flow components render no DOM wrapper of their
// own, so a component whose root is one of these has its real border one level
// in — descend through them to the first host element.
const CONTROL_FLOW = new Set([
    'Show',
    'For',
    'Index',
    'Switch',
    'Match',
    'Suspense',
    'SuspenseList',
    'ErrorBoundary',
    'Dynamic',
    'Portal',
    'Fragment',
]);

/// The first host (intrinsic, lowercase) element on each branch of a returned
/// JSX expression — the component's DOM border(s). Stops at the first host
/// element; descends through fragments, control-flow components, and render
/// callbacks; yields nothing when a branch's root is another component.
function rootHosts(node: Node | null | undefined): JSXElement[] {
    if (!node) return [];
    switch (node.type) {
        case 'JSXElement': {
            const name = node.openingElement.name;
            if (name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name)) {
                return [node];
            }
            if (name.type === 'JSXIdentifier' && CONTROL_FLOW.has(name.name)) {
                return node.children.flatMap(rootHosts);
            }
            return [];
        }
        case 'JSXFragment':
            return node.children.flatMap(rootHosts);
        case 'JSXExpressionContainer':
            return rootHosts(node.expression);
        case 'ParenthesizedExpression':
            return rootHosts(node.expression);
        case 'ConditionalExpression':
            return [...rootHosts(node.consequent), ...rootHosts(node.alternate)];
        case 'LogicalExpression':
            return rootHosts(node.right);
        case 'ArrowFunctionExpression':
        case 'FunctionExpression': {
            const body = node.body;
            if (body.type !== 'BlockStatement') return rootHosts(body);
            return body.body.flatMap((s) =>
                s.type === 'ReturnStatement' ? rootHosts(s.argument) : [],
            );
        }
        default:
            return [];
    }
}

/// Returns a Babel plugin (the `(babel) => PluginObj` form) configured with the
/// project `root` it should make element paths relative to.
export function tsxElementBabelPlugin({ root }: { root: string }) {
    return function tsxElementPlugin({ types: t }: typeof BabelCore): PluginObj<PluginPass> {
        return {
            name: 'tsx-element',
            visitor: {
                Program(programPath, state) {
                    const filename = state.file.opts.filename;
                    // Unnamed source (synthetic transform) — nothing to point at.
                    if (!filename) return;
                    const rel = relative(root, filename).split('\\').join('/');

                    programPath.traverse({
                        Function(fnPath) {
                            const node = fnPath.node;

                            // Resolve the component's name + definition line.
                            let name: string | undefined;
                            let line: number | undefined;
                            if (node.type === 'FunctionDeclaration' && node.id) {
                                name = node.id.name;
                                line = node.id.loc?.start.line;
                            } else {
                                const parent = fnPath.parent;
                                if (
                                    parent.type === 'VariableDeclarator' &&
                                    parent.id.type === 'Identifier'
                                ) {
                                    // `const ChatView: Component = () => …`
                                    name = parent.id.name;
                                    line = parent.id.loc?.start.line;
                                } else if (
                                    parent.type === 'AssignmentExpression' &&
                                    parent.left.type === 'Identifier'
                                ) {
                                    name = parent.left.name;
                                    line = parent.left.loc?.start.line;
                                }
                            }

                            // Components only (Capitalized). Helpers, hooks, and
                            // render callbacks are skipped — the latter are
                            // reached via control-flow descent from the root.
                            if (!name || !/^[A-Z]/.test(name)) return;
                            const value = `${name}@${rel}:${line ?? node.loc?.start.line ?? 0}`;

                            // This component's own top-level returned JSX. Skip
                            // nested functions: their returns belong to callbacks
                            // or inner components, not this border.
                            const returns: Expression[] = [];
                            const body = node.body;
                            if (body.type !== 'BlockStatement') {
                                returns.push(body);
                            } else {
                                fnPath.traverse({
                                    Function(p) {
                                        p.skip();
                                    },
                                    ReturnStatement(p) {
                                        if (p.node.argument) returns.push(p.node.argument);
                                    },
                                });
                            }

                            for (const expr of returns) {
                                for (const host of rootHosts(expr)) {
                                    const open = host.openingElement;
                                    const already = open.attributes.some(
                                        (a) =>
                                            a.type === 'JSXAttribute' &&
                                            a.name.type === 'JSXIdentifier' &&
                                            a.name.name === ATTR,
                                    );
                                    if (already) continue;
                                    open.attributes.push(
                                        t.jsxAttribute(
                                            t.jsxIdentifier(ATTR),
                                            t.stringLiteral(value),
                                        ),
                                    );
                                }
                            }
                        },
                    });
                },
            },
        };
    };
}

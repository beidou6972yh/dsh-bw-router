/**
 * A deliberately small YAML reader for DSH's own config files.
 *
 * Why this exists at all: DSH's real model list lives in YAML
 * (`profiles/<profile>/cordis.patch.yml`, `settings.yaml`), and a plugin that
 * only understands JSON sees **zero models** on a real host — the DEF-1 defect
 * the external tester reported. Adding a full YAML dependency to the plugin was
 * rejected twice over: the kernel must stay dependency-free, and a YAML parser
 * is a large attack surface for one narrow job.
 *
 * So this reads the **block subset DSH actually writes**:
 *   - block mappings (`key: value`, `key:` + nested block);
 *   - block sequences (`- value`, `- key: value`);
 *   - flow sequences/mappings on one line (`[ text, image ]`, `{ a: 1 }`);
 *   - quoted and plain scalars, block scalars (`|`, `>`), comments.
 *
 * Anchors (`&name`) and aliases (`*name`) are tolerated rather than rejected:
 * an anchor marker is stripped and the rest of the line parsed normally, while
 * an alias resolves against anchors seen earlier in the same file. A missing
 * (forward/undefined) alias becomes `null` so one reference can never make the
 * whole profile unreadable. Tags are kept as opaque strings (see below).
 *
 * It deliberately does **not** support multiple documents or complex keys.
 * Those throw a {@link YamlLiteError} — callers treat that as "this file is
 * unreadable", which is the project's standing rule for a bad config
 * (坏配置 = 「暂无模型」, never a crash).
 */
/** A file this reader could not read, with the line that stopped it. */
export class YamlLiteError extends Error {
    line;
    constructor(message, 
    /** 1-based line number in the original text. */
    line) {
        super(`${message} (line ${line})`);
        this.line = line;
        this.name = 'YamlLiteError';
    }
}
const ANCHOR_TOKEN = /^&([^\s[\]{},]+)\s*/;
const ALIAS_TOKEN = /^\*([^\s[\]{},]+)\s*/;
/**
 * Splits leading `&name` definitions off a value/key line.
 *
 * `key: &retry` → no rest (the block below is the value, same as `key:`);
 * `key: &retry value` → rest `"value"`; `&retry key: value` → key-side marker.
 */
function takeAnchors(text) {
    let rest = text.trimStart();
    const names = [];
    for (;;) {
        const match = ANCHOR_TOKEN.exec(rest);
        if (!match)
            break;
        names.push(match[1]);
        rest = rest.slice(match[0].length).trimStart();
    }
    return { names, rest };
}
/** The name of a value that is exactly an alias token, if it is one. */
function aliasName(text) {
    return ALIAS_TOKEN.exec(text.trimStart())?.[1];
}
function rememberAnchors(context, names, value) {
    if (!context)
        return;
    for (const name of names)
        context.anchors.set(name, value);
}
const TAB_WIDTH = 2;
/** True for a line that is blank or pure comment. */
function isSkippable(raw) {
    const trimmed = raw.trim();
    return trimmed === '' || trimmed.startsWith('#');
}
/**
 * Removes a trailing `#` comment, respecting quotes and flow brackets.
 *
 * `#` only starts a comment at the start of the content or after whitespace —
 * `a#b` is a scalar in YAML too, and `url: http://x/#frag` must survive.
 */
export function stripComment(text) {
    let quote;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === '\\' && quote === '"') {
                i++;
                continue;
            }
            if (char === quote)
                quote = undefined;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (char === '[' || char === '{')
            depth++;
        else if (char === ']' || char === '}')
            depth = Math.max(0, depth - 1);
        else if (char === '#' && depth === 0 && (i === 0 || /\s/.test(text[i - 1]))) {
            return text.slice(0, i).trimEnd();
        }
    }
    return text.trimEnd();
}
/** Splits `key: value` at the first colon outside quotes/brackets. */
export function splitKey(text) {
    let quote;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (char === '\\' && quote === '"') {
                i++;
                continue;
            }
            if (char === quote)
                quote = undefined;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (char === '[' || char === '{')
            depth++;
        else if (char === ']' || char === '}')
            depth = Math.max(0, depth - 1);
        else if (char === ':' && depth === 0) {
            const next = text[i + 1];
            // `key:value` (no space) is a scalar in YAML, not a mapping separator.
            if (next !== undefined && next !== ' ' && next !== '\t')
                return undefined;
            return { key: unquote(text.slice(0, i).trim()), rest: text.slice(i + 1).trim() };
        }
    }
    return undefined;
}
function unquote(text) {
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1).replace(/''/g, "'");
    }
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        return text
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
    return text;
}
/** A scalar, a one-line flow collection, or a block-scalar marker. */
export function parseScalar(text, line, context) {
    let value = text.trim();
    if (value === '')
        return null;
    // `&name value` defines an anchor for `value`; `&name` alone has no scalar.
    const anchored = takeAnchors(value);
    if (anchored.names.length > 0) {
        value = anchored.rest;
        const parsed = value === '' ? null : parseScalar(value, line, context);
        rememberAnchors(context, anchored.names, parsed);
        return parsed;
    }
    // `*name` is an alias. A forward/undefined reference is not a parse error:
    // the key is simply skipped as `null`, matching a config the loader would
    // reject without letting it hide every other entry in the file.
    const alias = aliasName(value);
    if (alias !== undefined) {
        return context?.anchors.get(alias) ?? null;
    }
    if (value.startsWith('['))
        return parseFlowSequence(value, line, context);
    if (value.startsWith('{'))
        return parseFlowMapping(value, line, context);
    if (value.startsWith('!')) {
        // DSH's loader dialect allows `!!js <expression>` values (a live profile on
        // the tester's host carries one). We never evaluate them — a config
        // expression is not model data — and a tag must not make the whole file
        // unreadable: keeping the expression as an opaque string lets every other
        // entry in the same file still be read.
        return value.replace(/^!+\S*\s*/, '');
    }
    if (value.startsWith('&') || value.startsWith('*')) {
        // Degenerate marker (`&` / `*` with no valid name): drop the marker and
        // keep the remainder rather than failing the document.
        return value.replace(/^[&*]\S*\s*/, '');
    }
    if (value.startsWith("'") || value.startsWith('"'))
        return unquote(value);
    if (value === 'null' || value === '~' || value === 'Null' || value === 'NULL')
        return null;
    if (value === 'true' || value === 'True' || value === 'TRUE')
        return true;
    if (value === 'false' || value === 'False' || value === 'FALSE')
        return false;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value))
        return Number(value);
    if (/^0x[0-9a-fA-F]+$/.test(value))
        return Number.parseInt(value, 16);
    return value;
}
/** `[ a, b ]` — one line, scalars only (nested flow collections included). */
function parseFlowSequence(text, line, context) {
    if (!text.endsWith(']'))
        throw new YamlLiteError('unterminated flow sequence', line);
    const body = text.slice(1, -1).trim();
    if (body === '')
        return [];
    return splitFlow(body, line).map((part) => parseScalar(part, line, context));
}
/** `{ a: 1, b: 2 }` — one line. */
function parseFlowMapping(text, line, context) {
    if (!text.endsWith('}'))
        throw new YamlLiteError('unterminated flow mapping', line);
    const body = text.slice(1, -1).trim();
    const out = {};
    if (body === '')
        return out;
    for (const part of splitFlow(body, line)) {
        const pair = splitKey(part.trim());
        if (!pair)
            throw new YamlLiteError(`expected "key: value" in "${part}"`, line);
        out[pair.key] = parseScalar(pair.rest, line, context);
    }
    return out;
}
/** Splits a flow body on commas that are not inside quotes or nested brackets. */
function splitFlow(body, line) {
    const parts = [];
    let current = '';
    let quote;
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
        const char = body[i];
        if (quote) {
            current += char;
            if (char === '\\' && quote === '"') {
                current += body[++i] ?? '';
                continue;
            }
            if (char === quote)
                quote = undefined;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current += char;
            continue;
        }
        if (char === '[' || char === '{') {
            depth++;
            current += char;
            continue;
        }
        if (char === ']' || char === '}') {
            depth = Math.max(0, depth - 1);
            current += char;
            continue;
        }
        if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (quote)
        throw new YamlLiteError('unterminated quoted string', line);
    if (current.trim() !== '')
        parts.push(current.trim());
    return parts;
}
function toLines(source) {
    const lines = [];
    const raw = source.split(/\r?\n/);
    for (let index = 0; index < raw.length; index++) {
        const original = raw[index];
        if (isSkippable(original))
            continue;
        const expanded = original.replace(/\t/g, ' '.repeat(TAB_WIDTH));
        const indent = expanded.length - expanded.trimStart().length;
        const text = stripComment(expanded.trimStart());
        if (text === '')
            continue;
        lines.push({ indent, text, number: index + 1 });
    }
    return lines;
}
/**
 * Parses one YAML document.
 *
 * @param source - the file text.
 * @returns plain data (objects/arrays/scalars).
 * @throws {YamlLiteError} for anything outside the supported subset — never a
 *   partial guess, because a half-read provider list is worse than no list.
 */
export function parseYamlLite(source) {
    const lines = toLines(source);
    if (lines.length === 0)
        return null;
    const context = { anchors: new Map() };
    const { value, next } = parseBlock(lines, 0, lines[0].indent, context);
    if (next < lines.length) {
        throw new YamlLiteError(`unexpected content "${lines[next].text}"`, lines[next].number);
    }
    return value;
}
/** Parses the block starting at `start` whose lines share `indent`. */
function parseBlock(lines, start, indent, context) {
    const first = lines[start];
    const anchored = takeAnchors(first.text);
    if (anchored.rest === '') {
        // An anchor on its own line (`&name` above a nested block) attaches to the
        // following block, exactly as `key: &name` attaches to its body.
        const next = lines[start + 1];
        if (next && next.indent >= indent) {
            const nested = parseBlock(lines, start + 1, next.indent, context);
            rememberAnchors(context, anchored.names, nested.value);
            return nested;
        }
        rememberAnchors(context, anchored.names, null);
        return { value: null, next: start + 1 };
    }
    if (isSequenceItem(anchored.rest))
        return parseSequence(lines, start, indent, context);
    return parseMapping(lines, start, indent, context);
}
function isSequenceItem(text) {
    return text === '-' || text.startsWith('- ');
}
function parseSequence(lines, start, indent, context) {
    const out = [];
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (line.indent < indent)
            break;
        if (line.indent > indent)
            throw new YamlLiteError('unexpected indentation', line.number);
        const anchoredLine = takeAnchors(line.text);
        if (!isSequenceItem(anchoredLine.rest))
            break;
        const inlineRaw = anchoredLine.rest === '-' ? '' : anchoredLine.rest.slice(2).trim();
        const anchoredInline = takeAnchors(inlineRaw);
        const inline = anchoredInline.rest;
        const names = [...anchoredLine.names, ...anchoredInline.names];
        if (inline === '') {
            // `-` followed by a nested block (or nothing).
            const next = lines[i + 1];
            if (!next || next.indent <= indent) {
                rememberAnchors(context, names, null);
                out.push(null);
                i++;
                continue;
            }
            const nested = parseBlock(lines, i + 1, next.indent, context);
            rememberAnchors(context, names, nested.value);
            out.push(nested.value);
            i = nested.next;
            continue;
        }
        if (isBlockScalarMarker(inline)) {
            const { value, next } = readBlockScalar(lines, i, indent, inline);
            rememberAnchors(context, names, value);
            out.push(value);
            i = next;
            continue;
        }
        const pair = splitKey(inline);
        if (!pair) {
            const value = parseScalar(inline, line.number, context);
            rememberAnchors(context, names, value);
            out.push(value);
            i++;
            continue;
        }
        // `- key: value` starts a mapping whose keys sit at indent + 2.
        const mapping = parseInlineMapping(lines, i, indent + 2, pair, context);
        rememberAnchors(context, names, mapping.value);
        out.push(mapping.value);
        i = mapping.next;
    }
    return { value: out, next: i };
}
function parseMapping(lines, start, indent, context) {
    const out = {};
    let i = start;
    while (i < lines.length) {
        const line = lines[i];
        if (line.indent < indent)
            break;
        if (line.indent > indent)
            throw new YamlLiteError('unexpected indentation', line.number);
        const anchoredLine = takeAnchors(line.text);
        if (anchoredLine.rest === '') {
            rememberAnchors(context, anchoredLine.names, null);
            i++;
            continue;
        }
        if (isSequenceItem(anchoredLine.rest))
            break;
        const pair = splitKey(anchoredLine.rest);
        if (!pair) {
            throw new YamlLiteError(`expected "key: value" in "${anchoredLine.rest}"`, line.number);
        }
        const anchoredValue = takeAnchors(pair.rest);
        const valueText = anchoredValue.rest;
        const names = [...anchoredLine.names, ...anchoredValue.names];
        let value;
        if (isBlockScalarMarker(valueText)) {
            const { value: scalar, next } = readBlockScalar(lines, i, indent, valueText);
            value = scalar;
            rememberAnchors(context, names, value);
            out[pair.key] = value;
            i = next;
            continue;
        }
        if (valueText !== '') {
            value = parseScalar(valueText, line.number, context);
            rememberAnchors(context, names, value);
            out[pair.key] = value;
            i++;
            continue;
        }
        const next = lines[i + 1];
        if (!next || next.indent <= indent) {
            value = null;
            rememberAnchors(context, names, value);
            out[pair.key] = value;
            i++;
            continue;
        }
        const nested = parseBlock(lines, i + 1, next.indent, context);
        value = nested.value;
        rememberAnchors(context, names, value);
        out[pair.key] = value;
        i = nested.next;
    }
    return { value: out, next: i };
}
/**
 * Parses a sequence item that opened a mapping inline (`- id: x`), where the
 * mapping's own keys sit at `indent` and further lines are its continuation.
 */
function parseInlineMapping(lines, start, indent, first, context) {
    const out = {};
    const line = lines[start];
    const anchoredFirst = takeAnchors(first.rest);
    const firstText = anchoredFirst.rest;
    let firstValue;
    if (isBlockScalarMarker(firstText)) {
        const { value } = readBlockScalar(lines, start, indent, firstText);
        firstValue = value;
    }
    else if (firstText !== '') {
        firstValue = parseScalar(firstText, line.number, context);
    }
    else {
        const next = lines[start + 1];
        if (next && next.indent > indent) {
            const nested = parseBlock(lines, start + 1, next.indent, context);
            rememberAnchors(context, anchoredFirst.names, nested.value);
            out[first.key] = nested.value;
            return { value: out, next: nested.next };
        }
        firstValue = null;
    }
    rememberAnchors(context, anchoredFirst.names, firstValue);
    out[first.key] = firstValue;
    let i = start + 1;
    while (i < lines.length) {
        const current = lines[i];
        if (current.indent < indent)
            break;
        if (current.indent > indent)
            throw new YamlLiteError('unexpected indentation', current.number);
        const anchoredLine = takeAnchors(current.text);
        if (anchoredLine.rest === '') {
            rememberAnchors(context, anchoredLine.names, null);
            i++;
            continue;
        }
        if (isSequenceItem(anchoredLine.rest))
            break;
        const pair = splitKey(anchoredLine.rest);
        if (!pair) {
            throw new YamlLiteError(`expected "key: value" in "${anchoredLine.rest}"`, current.number);
        }
        const anchoredValue = takeAnchors(pair.rest);
        const valueText = anchoredValue.rest;
        const names = [...anchoredLine.names, ...anchoredValue.names];
        let value;
        if (isBlockScalarMarker(valueText)) {
            const { value: scalar, next } = readBlockScalar(lines, i, indent, valueText);
            value = scalar;
            rememberAnchors(context, names, value);
            out[pair.key] = value;
            i = next;
            continue;
        }
        if (valueText !== '') {
            value = parseScalar(valueText, current.number, context);
            rememberAnchors(context, names, value);
            out[pair.key] = value;
            i++;
            continue;
        }
        const next = lines[i + 1];
        if (!next || next.indent <= indent) {
            value = null;
            rememberAnchors(context, names, value);
            out[pair.key] = value;
            i++;
            continue;
        }
        const nested = parseBlock(lines, i + 1, next.indent, context);
        value = nested.value;
        rememberAnchors(context, names, value);
        out[pair.key] = value;
        i = nested.next;
    }
    return { value: out, next: i };
}
function isBlockScalarMarker(text) {
    return /^[|>][+-]?$/.test(text.trim());
}
/**
 * Reads a `|` / `>` block scalar: every following line more indented than the
 * owning key, verbatim for `|` and space-joined for `>`.
 */
function readBlockScalar(lines, start, indent, marker) {
    const literal = marker.startsWith('|');
    const collected = [];
    let i = start + 1;
    while (i < lines.length && lines[i].indent > indent) {
        collected.push(lines[i].text);
        i++;
    }
    const value = literal ? collected.join('\n') : collected.join(' ');
    return { value, next: i === start + 1 ? start + 1 : i };
}
//# sourceMappingURL=yaml-lite.js.map
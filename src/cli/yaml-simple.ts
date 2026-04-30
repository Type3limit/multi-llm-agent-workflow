// Minimal YAML parser for v0 AgentProfile files.
// Supports: string/number/boolean scalars, nested objects by indentation,
// arrays with "- value", and quoted strings.

export function parseSimpleYaml(text: string): unknown {
  const lines = text.split(/\r?\n/);
  return parseBlock(lines, 0, 0).value;
}

interface ParseResult {
  value: unknown;
  nextIdx: number;
}

function parseBlock(
  lines: string[],
  startIdx: number,
  baseIndent: number,
): ParseResult {
  let idx = startIdx;
  const result: Record<string, unknown> = {};

  while (idx < lines.length) {
    const line = lines[idx];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      idx++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent < baseIndent) {
      break;
    }

    if (indent > baseIndent) {
      idx++;
      continue;
    }

    // Array item
    if (trimmed.startsWith("- ")) {
      const itemValue = parseScalar(trimmed.slice(2).trim());
      result[idx.toString()] = itemValue;
      idx++;
      continue;
    }

    // Key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      idx++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const afterColon = trimmed.slice(colonIdx + 1).trim();

    if (afterColon.length > 0) {
      result[key] = parseScalar(afterColon);
      idx++;
    } else {
      // Nested block — check next line
      idx++;
      if (idx >= lines.length) break;

      const nextLine = lines[idx];
      const nextTrimmed = nextLine.trim();
      if (nextTrimmed.length === 0 || nextTrimmed.startsWith("#")) {
        continue;
      }

      const nextIndent = nextLine.search(/\S/);
      if (nextIndent <= indent) continue;

      if (nextTrimmed.startsWith("- ")) {
        // Array block
        const nested = parseBlock(lines, idx, nextIndent);
        const arr: unknown[] = [];
        if (Array.isArray(nested.value)) {
          arr.push(...nested.value);
        } else {
          // It's an object with numeric keys; convert to array
          const obj = nested.value as Record<string, unknown>;
          const keys = Object.keys(obj).sort((a, b) => Number(a) - Number(b));
          for (const k of keys) {
            arr.push(obj[k]);
          }
        }
        result[key] = arr;
        idx = nested.nextIdx;
      } else {
        // Object block
        const nested = parseBlock(lines, idx, nextIndent);
        result[key] = nested.value;
        idx = nested.nextIdx;
      }
    }
  }

  // Check if result looks like an array (all numeric keys)
  const keys = Object.keys(result);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    const arr: unknown[] = [];
    const sorted = keys.sort((a, b) => Number(a) - Number(b));
    for (const k of sorted) {
      arr.push(result[k]);
    }
    return { value: arr, nextIdx: idx };
  }

  return { value: result, nextIdx: idx };
}

function parseScalar(raw: string): unknown {
  const s = raw.trim();
  // Quoted strings (double or single)
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  // Booleans
  if (s === "true") return true;
  if (s === "false") return false;
  // Null
  if (s === "null" || s === "~") return null;
  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  return s;
}

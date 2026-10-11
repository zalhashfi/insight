/**
 * Minimal, dependency-free SQL statement splitter.
 *
 * This is NOT a SQL parser: it is a small seam used by tests (and, later, by
 * the migration runner) to break a `.sql` file into individual statements so
 * each `CREATE ...` can be inspected/executed on its own. It deliberately has
 * no knowledge of the SQL grammar beyond the three constructs that appear in
 * this repo's migrations:
 *
 *   - `--` line comments and `/* ... *\/` block comments (stripped),
 *   - single-quoted string literals (a `;` inside one is not a separator),
 *   - `;` statement terminators at the top level.
 *
 * It is pure: given the same input it always returns the same output and it
 * touches neither the filesystem nor the network.
 */

/** A single leading normalized keyword, e.g. `CREATE` / `INSERT` / `PRAGMA`. */
export type StatementKeyword = string;

export interface SqlStatement {
  /** Statement text with comments stripped and surrounding whitespace trimmed. */
  readonly sql: string;
  /** Uppercased leading keyword of the statement. */
  readonly keyword: StatementKeyword;
}

/** Remove `--` line comments and `/* ... *\/` block comments (naive but safe). */
export function stripSqlComments(input: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += ch;
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (inSingle) {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Split comment-stripped SQL into raw statements on top-level `;`. */
export function splitSqlStatements(input: string): string[] {
  const cleaned = stripSqlComments(input);
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let i = 0;

  while (i < cleaned.length) {
    const ch = cleaned[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (cleaned[i + 1] === "'") {
          current += "'";
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);

  return statements;
}

/** Leading uppercased keyword of a statement (`""` when the statement is blank). */
export function statementKeyword(sql: string): StatementKeyword {
  const match = /^[A-Za-z_]+/.exec(sql.trim());
  return match ? match[0].toUpperCase() : "";
}

/**
 * Parse a `.sql` file into structured statements, dropping empty fragments.
 * Pure — the caller is responsible for reading the file.
 */
export function parseSql(sql: string): SqlStatement[] {
  return splitSqlStatements(sql)
    .map((text) => ({ sql: text, keyword: statementKeyword(text) }))
    .filter((s) => s.keyword !== "");
}

/**
 * CSV in and out. Pure string work: no Blob, no download, no DOM.
 *
 * Two hazards shape this file, and both come from the fact that the cells are
 * scraped Instagram text — biographies, display names and comments written by
 * strangers:
 *
 *  1. Formula injection. A biography that starts with `=`, `+`, `-`, `@`, a tab
 *     or a carriage return is executed as a formula by Excel and LibreOffice,
 *     which turns an exported lead list into an attack on whoever opens it. Such
 *     a cell is prefixed with a single quote, which makes the spreadsheet show
 *     the text literally.
 *  2. Quote and newline smuggling. A display name containing `"` or a line break
 *     must not be able to add columns or rows to the file, so every cell is
 *     quoted and inner quotes are doubled.
 *
 * The importer reverses both, so a guarded export re-imports to the original
 * text: round-trip fidelity is what makes the CSV a usable backup, not just a
 * report.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
export const FORMULA_PREFIXES = Object.freeze(['=', '+', '-', '@', '\t', '\r']);

/** Prepended to a dangerous cell. Excel hides it; the parser removes it. */
export const GUARD_CHAR = "'";

/** Excel needs this to detect UTF-8; without it Arabic exports open as mojibake. */
export const UTF8_BOM = '\uFEFF';

export function startsWithFormula(text) {
  const first = String(text ?? '')[0];
  return first !== undefined && FORMULA_PREFIXES.includes(first);
}

/** Neutralise a cell that a spreadsheet would otherwise execute. */
export function guardCellText(text) {
  const value = String(text ?? '');
  return startsWithFormula(value) ? `${GUARD_CHAR}${value}` : value;
}

/** Undo `guardCellText`, and only for cells that were actually guarded. */
export function unguardCellText(text) {
  const value = String(text ?? '');
  if (value[0] !== GUARD_CHAR) return value;
  return startsWithFormula(value.slice(1)) ? value.slice(1) : value;
}

/** One RFC 4180 cell: always quoted, inner quotes doubled, formula guarded. */
export function csvCell(value, { guard = true } = {}) {
  let text = value === null || value === undefined ? '' : String(value);
  if (guard) text = guardCellText(text);
  return `"${text.split('"').join('""')}"`;
}

/**
 * Rows to CSV text.
 *
 * `columns` decides the header order and which keys are exported; without it the
 * union of the rows' own keys is used, in first-seen order, which is what a
 * hand-built export wants.
 */
export function toCsv(rows, { columns = null, guard = true, lineEnding = '\r\n' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const keys = columns?.length
    ? columns.map((column) => (typeof column === 'string' ? column : column.key))
    : [...new Set(list.flatMap((row) => Object.keys(row ?? {})))];
  const labels = columns?.length
    ? columns.map((column) => (typeof column === 'string' ? column : column.label ?? column.key))
    : keys;

  const lines = [labels.map((label) => csvCell(label, { guard })).join(',')];
  for (const row of list) {
    lines.push(keys.map((key) => csvCell(row?.[key], { guard })).join(','));
  }
  return lines.join(lineEnding) + lineEnding;
}

/**
 * CSV text to rows of objects.
 *
 * Handles quoted fields with embedded commas, newlines and doubled quotes, both
 * line endings, a leading BOM and rows shorter or longer than the header. A
 * malformed line is reported in `warnings` rather than silently dropped: an
 * importer that loses rows without saying so is worse than one that refuses.
 */
export function parseCsv(text, { delimiter = ',', unguard = true } = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  const warnings = [];
  let header = null;
  let field = '';
  let record = [];
  let inQuotes = false;
  let line = 1;

  const endField = () => {
    const value = unguard ? unguardCellText(field) : field;
    record.push(value);
    field = '';
  };
  const endRecord = () => {
    endField();
    if (record.length === 1 && record[0] === '') {
      record = [];
      return;
    }
    if (!header) {
      header = record.map((name, index) => (name.trim() === '' ? `column_${index + 1}` : name.trim()));
    } else {
      const row = {};
      header.forEach((name, index) => {
        row[name] = index < record.length ? record[index] : '';
      });
      if (record.length > header.length) {
        warnings.push(`line ${line}: ${record.length - header.length} extra cell(s) ignored`);
      } else if (record.length < header.length) {
        warnings.push(`line ${line}: ${header.length - record.length} missing cell(s) filled with ""`);
      }
      rows.push(row);
    }
    record = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field !== '') warnings.push(`line ${line}: quote inside an unquoted field`);
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\n') {
      endRecord();
      line += 1;
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (inQuotes) warnings.push('file ends inside a quoted field');
  if (field !== '' || record.length > 0) endRecord();

  return { header: header ?? [], rows, warnings };
}

/**
 * Read one column out of a CSV as a clean list of handles — the shape the
 * whitelist and the legacy-account importer both need.
 *
 * `@name`, `name`, `https://instagram.com/name` and `name (123)` all resolve to
 * `name`. Reserved route segments are dropped, because a list containing
 * "explore" would protect or target a page rather than a person.
 */
export function parseHandleList(text, { reserved = [] } = {}) {
  const blocked = new Set(reserved.map((item) => String(item).toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    // A pasted spreadsheet row: take the first cell.
    line = line.split(/[,\t;]/)[0].trim();
    line = line.replace(/^@+/, '');
    const urlMatch = line.match(/instagram\.com\/([^/?#\s]+)/i);
    if (urlMatch) line = urlMatch[1];
    line = line.replace(/\s*\(\d+\)\s*$/, '');
    line = line.replace(/[^\w.\u0600-\u06FF-]/g, '');
    if (!line) continue;
    if (blocked.has(line.toLowerCase())) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

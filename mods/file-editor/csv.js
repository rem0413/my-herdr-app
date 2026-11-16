// CSV/TSV for the Table view: RFC 4180 quoting ("" inside quotes, line breaks inside quotes), CRLF or LF.

// Tab for .tsv; for .csv the first line decides between comma and semicolon (spreadsheets in many
// locales write semicolons). Counted outside quotes.
export function delimiterFor(file, text) {
  if (/\.tsv$/i.test(file)) return "\t";
  let comma = 0, semi = 0, quoted = false;
  for (const c of text.slice(0, 4096)) {
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "\n") break;
    else if (c === ",") comma++;
    else if (c === ";") semi++;
  }
  return semi > comma ? ";" : ",";
}

// Rows of cells, at most maxRows (then truncated: true). A trailing newline adds no empty row.
export function parseCsv(text, delimiter = ",", maxRows = Infinity) {
  const rows = [];
  let row = [], cell = "", quoted = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  const endRow = () => { row.push(cell); rows.push(row); row = []; cell = ""; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows) return { rows, truncated: i + 1 < text.length };
    } else cell += c;
  }
  if (cell !== "" || row.length) endRow();
  return { rows, truncated: false };
}

// boxToSmartsheet.mjs
//
// For every file in a Box folder:
//   1. Adds a new row to a Smartsheet sheet with the document name (file name
//      without its extension) in the name column.
//   2. Downloads the file from Box and attaches it to that new row.
//
// Safe to rerun: if a row with that document name already has the file attached,
// it is skipped. If the row exists but the file isn't attached (e.g., a previous
// run failed partway), the file is attached to that existing row instead of
// creating a duplicate.
//
// Requires Node 20.12+ (built-in fetch and .env loading). No npm packages needed.
//
// All settings live in a .env file next to this script. Copy .env.example
// to .env and fill it in. Never commit .env.
//
// Box auth is handled in boxAuth.mjs. For scheduled runs, set BOX_AUTH_MODE=oauth
// and run `npm run authorize` once; the script renews its own token after that.
//
// Run:  node boxToSmartsheet.mjs

import { loadEnv, requireEnv, getBoxToken, authMode } from './boxAuth.mjs';

loadEnv();

console.log(`Run started ${new Date().toISOString()} (Box auth: ${authMode()})`);

let boxToken;
try {
  boxToken = await getBoxToken();
} catch (err) {
  console.error(`Box sign-in problem: ${err.message}`);
  process.exit(1);
}
const SS_TOKEN = requireEnv('SMARTSHEET_TOKEN');
const BOX_FOLDER_ID = requireEnv('BOX_FOLDER_ID');
const SHEET_ID = requireEnv('SHEET_ID');
// NAME_COLUMN_TITLE is the column that receives the document name.
// KEY_COLUMN_TITLE is still accepted so older .env files keep working.
const NAME_COLUMN_TITLE = (process.env.NAME_COLUMN_TITLE || process.env.KEY_COLUMN_TITLE || '').trim();
if (!NAME_COLUMN_TITLE) {
  console.error('Missing environment variable: NAME_COLUMN_TITLE');
  process.exit(1);
}
// Dry run stays on unless explicitly set to "false", so a missing setting never uploads by accident.
const DRY_RUN = (process.env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';

const BOX_API = 'https://api.box.com/2.0';
const SS_API = 'https://api.smartsheet.com/2.0';

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

async function main() {
  const { nameColumnId, rowsByName } = await loadSheet();
  console.log(`Sheet has ${rowsByName.size} rows with a value in "${NAME_COLUMN_TITLE}".`);

  const existing = await getExistingRowAttachments();
  const files = await listBoxFiles(BOX_FOLDER_ID);
  console.log(`Found ${files.length} files in the Box folder.`);

  let created = 0, attachedExisting = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const docName = stripExtension(file.name).trim();
    const existingRowId = rowsByName.get(docName);

    if (existingRowId && existing.has(`${existingRowId}|${file.name}`)) {
      console.log(`ALREADY DONE, skipping: ${file.name}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(existingRowId
        ? `WOULD ATTACH to existing row: ${file.name} -> "${docName}"`
        : `WOULD ADD ROW + ATTACH: "${docName}" <- ${file.name}`);
      continue;
    }

    try {
      // 1. Download from Box first, so a failed download doesn't leave an empty row.
      const data = await downloadBoxFile(file.id);

      // 2. Use the existing row if there is one, otherwise add a new row.
      let rowId = existingRowId;
      if (!rowId) {
        rowId = await addRow(nameColumnId, docName);
        rowsByName.set(docName, rowId);
      }

      // 3. Attach the file to the row.
      await attachToRow(rowId, file.name, data);

      if (existingRowId) {
        console.log(`ATTACHED to existing row: ${file.name}`);
        attachedExisting++;
      } else {
        console.log(`ADDED ROW + ATTACHED: ${file.name}`);
        created++;
      }
      await sleep(250); // stay well under Smartsheet's rate limit
    } catch (err) {
      console.error(`FAILED: ${file.name} - ${err.message}`);
      failed++;
    }
  }

  console.log(
    `Done${DRY_RUN ? ' (dry run, nothing changed)' : ''}. New rows: ${created}, ` +
    `Attached to existing rows: ${attachedExisting}, Already done: ${skipped}, Failed: ${failed}`
  );
}

// ---------- Smartsheet ----------

// Finds the name column and maps each existing name to its row ID.
async function loadSheet() {
  const sheet = await ssRequest(`/sheets/${SHEET_ID}`);

  const nameColumn = sheet.columns.find(c => c.title === NAME_COLUMN_TITLE);
  if (!nameColumn) {
    const titles = sheet.columns.map(c => `"${c.title}"`).join(', ');
    throw new Error(`Column not found: "${NAME_COLUMN_TITLE}". Columns in this sheet: ${titles}`);
  }

  const rowsByName = new Map();
  for (const row of sheet.rows ?? []) {
    const cell = row.cells.find(c => c.columnId === nameColumn.id);
    const value = cell?.displayValue ?? cell?.value;
    if (value == null || value === '') continue;

    const name = String(value).trim();
    if (!rowsByName.has(name)) rowsByName.set(name, row.id);
  }
  return { nameColumnId: nameColumn.id, rowsByName };
}

// Adds a row at the bottom of the sheet with the document name, returns its row ID.
async function addRow(nameColumnId, docName) {
  const result = await ssRequest(`/sheets/${SHEET_ID}/rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { toBottom: true, cells: [{ columnId: nameColumnId, value: docName }] },
    ]),
  });
  const row = Array.isArray(result.result) ? result.result[0] : result.result;
  if (!row?.id) throw new Error('Row was not created (no row ID returned).');
  return row.id;
}

// Set of "rowId|fileName" for attachments already on rows, so reruns don't duplicate.
async function getExistingRowAttachments() {
  const result = await ssRequest(`/sheets/${SHEET_ID}/attachments?includeAll=true`);
  const set = new Set();
  for (const a of result.data ?? []) {
    if (a.parentType === 'ROW') set.add(`${a.parentId}|${a.name}`);
  }
  return set;
}

async function attachToRow(rowId, fileName, data) {
  const ext = fileName.split('.').pop().toLowerCase();
  const safeName = fileName.replace(/"/g, '');

  await ssRequest(`/sheets/${SHEET_ID}/rows/${rowId}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Content-Length': String(data.length),
    },
    body: data,
  });
}

async function ssRequest(path, options = {}, attempt = 1) {
  const res = await fetch(SS_API + path, {
    ...options,
    headers: { Authorization: `Bearer ${SS_TOKEN}`, ...(options.headers ?? {}) },
  });

  if (res.status === 429 && attempt <= 5) {
    // Rate limited: back off and retry
    await sleep(2000 * attempt);
    return ssRequest(path, options, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`Smartsheet ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// ---------- Box ----------

// Lists all files (not subfolders or web links) in a folder, handling pagination.
async function listBoxFiles(folderId) {
  const files = [];
  const limit = 1000;
  let offset = 0;

  while (true) {
    const res = await boxFetch(
      `${BOX_API}/folders/${folderId}/items?fields=id,name,type&limit=${limit}&offset=${offset}`
    );
    if (!res.ok) throw new Error(`Box ${res.status}: ${await res.text()}`);

    const page = await res.json();
    files.push(...page.entries.filter(e => e.type === 'file'));

    offset += page.entries.length;
    if (page.entries.length === 0 || offset >= page.total_count) break;
  }
  return files;
}

// GET from Box. If the token expires mid-run (401), renew it once and retry.
async function boxFetch(url, retried = false) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${boxToken}` } });
  if (res.status === 401 && !retried && authMode() !== 'token') {
    boxToken = await getBoxToken({ forceRefresh: true });
    return boxFetch(url, true);
  }
  return res;
}

async function downloadBoxFile(fileId) {
  // Box responds with a redirect to the download URL; fetch follows it automatically.
  const res = await boxFetch(`${BOX_API}/files/${fileId}/content`);
  if (!res.ok) throw new Error(`Box download ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Helpers ----------

function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

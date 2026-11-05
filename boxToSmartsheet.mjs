// BoxToSmartsheet.mjs
//
// Downloads every file in a Box folder and attaches each one to the
// Smartsheet row whose key column matches the file name (minus extension).
// Example: "INC12345.pdf" is attached to the row where Key Column = "INC12345".
//
// Requires Node 20.12+ (built-in fetch and .env loading). No npm packages needed.
//
// All settings live in a .env file next to this script. Copy .env.example
// to .env and fill it in. Never commit .env.
//
// Run:  node BoxToSmartsheet.mjs

loadEnv();

const BOX_TOKEN = requireEnv('BOX_TOKEN');
const SS_TOKEN = requireEnv('SMARTSHEET_TOKEN');
const BOX_FOLDER_ID = requireEnv('BOX_FOLDER_ID');
const SHEET_ID = requireEnv('SHEET_ID');
const KEY_COLUMN_TITLE = requireEnv('KEY_COLUMN_TITLE');
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
  const rowsByKey = await buildRowLookup();
  console.log(`Loaded ${rowsByKey.size} rows with a key value.`);

  const existing = await getExistingRowAttachments();
  const files = await listBoxFiles(BOX_FOLDER_ID);
  console.log(`Found ${files.length} files in the Box folder.`);

  let attached = 0, skipped = 0, unmatched = 0, failed = 0;

  for (const file of files) {
    const key = stripExtension(file.name).trim();
    const rowId = rowsByKey.get(key);

    if (!rowId) {
      console.log(`NO MATCH: ${file.name}`);
      unmatched++;
      continue;
    }

    if (existing.has(`${rowId}|${file.name}`)) {
      console.log(`ALREADY ATTACHED, skipping: ${file.name}`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`WOULD ATTACH: ${file.name} -> row ${rowId}`);
      continue;
    }

    try {
      const data = await downloadBoxFile(file.id);   // 1. download from Box (in memory)
      await attachToRow(rowId, file.name, data);     // 2. upload to the Smartsheet row
      console.log(`ATTACHED: ${file.name} -> row ${rowId}`);
      attached++;
      await sleep(250); // stay well under Smartsheet's rate limit
    } catch (err) {
      console.error(`FAILED: ${file.name} - ${err.message}`);
      failed++;
    }
  }

  console.log(
    `Done${DRY_RUN ? ' (dry run)' : ''}. Attached: ${attached}, Already there: ${skipped}, ` +
    `No match: ${unmatched}, Failed: ${failed}`
  );
}

// ---------- Smartsheet ----------

// Maps each key-column value to its row ID.
async function buildRowLookup() {
  const sheet = await ssRequest(`/sheets/${SHEET_ID}`);

  const keyColumn = sheet.columns.find(c => c.title === KEY_COLUMN_TITLE);
  if (!keyColumn) throw new Error(`Column not found: ${KEY_COLUMN_TITLE}`);

  const map = new Map();
  for (const row of sheet.rows) {
    const cell = row.cells.find(c => c.columnId === keyColumn.id);
    const value = cell?.displayValue ?? cell?.value;
    if (value == null || value === '') continue;

    const key = String(value).trim();
    if (map.has(key)) {
      console.log(`WARNING: duplicate key '${key}', using first row.`);
    } else {
      map.set(key, row.id);
    }
  }
  return map;
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
    const res = await fetch(
      `${BOX_API}/folders/${folderId}/items?fields=id,name,type&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${BOX_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`Box ${res.status}: ${await res.text()}`);

    const page = await res.json();
    files.push(...page.entries.filter(e => e.type === 'file'));

    offset += page.entries.length;
    if (page.entries.length === 0 || offset >= page.total_count) break;
  }
  return files;
}

async function downloadBoxFile(fileId) {
  // Box responds with a redirect to the download URL; fetch follows it automatically.
  const res = await fetch(`${BOX_API}/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${BOX_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Box download ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Helpers ----------

function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// Loads .env from the current folder using Node's built-in loader.
function loadEnv() {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('This Node version cannot load .env files. Update to Node 20.12 or newer.');
    process.exit(1);
  }
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('No .env file found. Copy .env.example to .env and fill it in.');
      process.exit(1);
    }
    throw err;
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

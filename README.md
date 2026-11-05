# Box to Smartsheet

Downloads every file in a Box folder and attaches each one to the Smartsheet row whose key column matches the file name (without its extension). For example, `INC12345.pdf` is attached to the row where the key column is `INC12345`.

Files already attached to a row with the same name are skipped, so it is safe to rerun.

## Requirements

- Node.js 20.12 or newer (`node -v` to check)
- A Box access token with access to the folder
- A Smartsheet API token with edit access to the sheet

No npm packages are needed.

## Setup

1. Copy the example settings file:
   ```
   cp .env.example .env
   ```
2. Fill in `.env`:
   - `BOX_TOKEN`: Box access token
   - `SMARTSHEET_TOKEN`: Smartsheet API token
   - `BOX_FOLDER_ID`: the number after `/folder/` in the Box folder URL
   - `SHEET_ID`: in Smartsheet, File > Properties > Sheet ID
   - `KEY_COLUMN_TITLE`: the column whose values match the file names
   - `DRY_RUN`: leave as `true` for the first run

## Usage

```
npm start
```

With `DRY_RUN=true`, the script only prints which files would go to which rows. Check the output, then set `DRY_RUN=false` and run again to upload.

At the end it prints a summary of files attached, already present, unmatched, and failed.

## Notes

- Subfolders in the Box folder are ignored.
- If two rows have the same key value, the first row is used and a warning is printed.
- Each file is held in memory during transfer, so very large files (hundreds of MB) are not a good fit.

## Security

- `.env` is listed in `.gitignore`. Never commit it, and never put tokens in the code.
- If a token is ever committed or shared, revoke it and generate a new one right away. Deleting the commit does not remove it from history.

# Box to Smartsheet

For every file in a Box folder, adds a new row to a Smartsheet sheet with the document name (the file name without its extension) and attaches the file to that row. For example, `Budget Memo.pdf` creates a row with `Budget Memo` in the name column, with the PDF attached.

It is safe to rerun. If a row with that name already has the file attached, the file is skipped. If the row exists but the attachment is missing, the file is attached to that row instead of creating a duplicate.

## Requirements

- Node.js 20.12 or newer (`node -v` to check)
- A Box app (Box Developer Console) with the **Read all files and folders** scope
- A Smartsheet API token with edit access to the sheet

No npm packages are needed.

## Setup

1. Copy the example settings file:
   ```
   cp .env.example .env
   ```
2. Fill in `.env` (for running on your own computer; GitHub Actions uses repo settings instead, see below):
   - Box settings (see **Box authentication** below)
   - `SMARTSHEET_TOKEN`: Smartsheet API token
   - `SHEET_ID`: in Smartsheet, File > Properties > Sheet ID
   - `BOX_FOLDER_ID`: the number after `/folder/` in the Box folder URL
   - `NAME_COLUMN_TITLE`: the column that receives the document name (must match the header exactly)
   - `DRY_RUN`: leave as `true` for the first run

## Box authentication

Set `BOX_AUTH_MODE` in `.env` to one of these.

### `oauth` (recommended for scheduled runs)

Box access tokens always expire after 60 minutes. With OAuth, you sign in once and the script saves a refresh token, which it uses to get a new access token on every run. You don't need a Box admin to approve anything.

1. In the Box Developer Console, open your **User Authentication (OAuth 2.0)** app (the same kind of app used for developer tokens).
2. On the **Configuration** tab:
   - Set **Redirect URI** to `http://localhost:3000/callback` (match `BOX_REDIRECT_PORT` if you change it).
   - Make sure **Read all files and folders** is checked.
   - Save changes.
3. Copy the app's **Client ID** and **Client Secret** into `.env`, and set `BOX_AUTH_MODE=oauth`.
4. Sign in once:
   ```
   npm run authorize
   ```
   Your browser opens to Box. Approve access, and the login is saved to `.box-tokens.json` in this folder.

The saved login acts as you and can reach any Box folder you can. It lasts as long as the script runs at least once every **60 days**. If it lapses or is revoked, the script stops with a message telling you to run `npm run authorize` again.

`.box-tokens.json` is as sensitive as a password. It is in `.gitignore` and saved with owner-only permissions. To revoke it, remove the app under **Apps** in your Box account settings, or delete the file.

### `ccg`

A Box Custom App using **Server Authentication (Client Credentials Grant)**. It must be authorized by a Box admin, and its service account must be invited as a collaborator on the folder. Fill in `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`, `BOX_SUBJECT_TYPE`, and `BOX_SUBJECT_ID`.

### `token`

A developer token pasted into `BOX_TOKEN`. Good for quick tests only, since it expires after 60 minutes.

## Usage

```
npm start
```

With `DRY_RUN=true`, the script only prints which rows it would add and which files it would attach. Check the output, then set `DRY_RUN=false` and run again to upload.

At the end it prints a summary of new rows, attachments to existing rows, files already done, and failures.

## Scheduling (macOS)

This uses `launchd`, the Mac's built-in scheduler. The job runs only while the Mac is on and you are logged in. If the Mac is asleep at the scheduled time, the job runs when it wakes.

1. **Keep the project out of Documents, Desktop, and Downloads.** macOS blocks background jobs from those folders. Something like `~/scripts/box-to-smartsheet` works.
2. Confirm that `npm start` works with `BOX_AUTH_MODE=oauth` and `DRY_RUN=false`.
3. Create the logs folder:
   ```
   mkdir -p logs
   ```
4. Copy the job template into place:
   ```
   cp scheduling/edu.ucdavis.box-to-smartsheet.plist.example ~/Library/LaunchAgents/edu.ucdavis.box-to-smartsheet.plist
   ```
5. Edit `~/Library/LaunchAgents/edu.ucdavis.box-to-smartsheet.plist`:
   - Replace `/Users/YOURNAME/scripts/box-to-smartsheet` with this project's full path (`pwd` prints it).
   - Replace `/opt/homebrew/bin/node` with the output of `which node`.
   - Change the hour and minute if you want a different time.
6. Load it, then run it once right away to test:
   ```
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/edu.ucdavis.box-to-smartsheet.plist
   launchctl kickstart gui/$(id -u)/edu.ucdavis.box-to-smartsheet
   ```
7. Check `logs/run.log` and `logs/error.log`.

After editing the plist, reload it:
```
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/edu.ucdavis.box-to-smartsheet.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/edu.ucdavis.box-to-smartsheet.plist
```

To stop the schedule, run the `bootout` command and delete the plist.

Run the job at most a few times a day, and don't run it by hand while a scheduled run is in progress. Box refresh tokens are single-use, so two runs refreshing at the same moment can invalidate the saved login, which means signing in again.

For a server or GitHub Actions instead of a Mac, use `ccg`. A rotating refresh token is hard to store safely on those platforms.

## Scheduling (GitHub Actions)

The workflow in `.github/workflows/box-to-smartsheet.yml` runs the script on GitHub's servers on weekday mornings, plus on demand from the **Actions** tab. Your Mac doesn't need to be on.

There is no `.env` on GitHub. The same settings are stored in the repo instead, under **Settings > Secrets and variables > Actions**, and the workflow passes them to the script as environment variables. Your local `.env` is only for running it on your own computer.

Box authentication must be `ccg` here: an admin-approved Client Credentials Grant app whose service account is a collaborator on the Box folder.

1. On the **Secrets** tab, add these as **repository secrets**:
   - `BOX_CLIENT_ID`
   - `BOX_CLIENT_SECRET`
   - `BOX_SUBJECT_ID`
   - `SMARTSHEET_TOKEN`
2. On the **Variables** tab, add these as **repository variables**:
   - `SHEET_ID`
   - `BOX_FOLDER_ID`
   - `NAME_COLUMN_TITLE`
   - `DRY_RUN` = `true` for now
   - `BOX_SUBJECT_TYPE` (optional; defaults to `enterprise`)
3. Open the **Actions** tab, choose **Box to Smartsheet**, and click **Run workflow**. Check the log to confirm the dry run looks right.
4. Change the `DRY_RUN` variable to `false`. Scheduled runs will now add rows and upload files.

To change the schedule, edit the `cron` line in the workflow file. Times are in UTC.

Secrets are hidden in logs, but anyone with write access to the repo can create a workflow that uses them, so keep write access limited to people who should have these credentials.

## Notes

- Subfolders in the Box folder are ignored.
- New rows are added at the bottom of the sheet.
- Box is the source: if you delete a row in Smartsheet, the next run adds it again.
- Each file is held in memory during transfer, so very large files (hundreds of MB) are not a good fit.

## Security

- `.env` and `.box-tokens.json` are listed in `.gitignore`. Never commit them, and never put tokens in the code.
- If a token or secret is ever committed or shared, revoke it and generate a new one right away. Deleting the commit does not remove it from history.

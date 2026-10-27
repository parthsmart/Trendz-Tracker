# Emergency Outage Plan — Recording Scores When the Website Is Down

This guide explains in plain English how teachers can continue recording student competition rounds during a temporary website or internet-service outage using the **Score Sheet Mirror**, and how to bring those scores back into Trendz Tracker once the website is back online.

---

## Important Rule Before You Start

> **Never type directly into the main Score Sheet Mirror spreadsheet.**
> The main Score Sheet Mirror is **read-only** and is automatically overwritten from the website database every time the nightly or manual backup runs. Anything typed directly into the mirror spreadsheet will be erased on the next backup.

---

## Step 1: Make a Working Copy of the Mirror Sheet

1. Open the **Score Sheet Mirror** in Google Sheets (bookmark the link from **Setup &rarr; Backup &rarr; Open score-sheet mirror ↗** ahead of time so you always have it handy).
2. In the top Google Sheets menu, click **File &rarr; Make a copy**.
3. Give the copy a clear name such as `Trendz Working Copy - Outage <Date>` and click **Make a copy**.
4. Close the original read-only mirror tab so you only type inside your new copy.

---

## Step 2: Enter New Rounds in Your Copy Using the Same Layout

Inside your copied spreadsheet, each active student has their own tab (`<Name> (<ID>)`) in the classic Jr. MCWC score-sheet layout:

1. Locate the student's tab and look at the **first block on the left** (the current round series).
2. To add a new round, insert two new columns (`Score` and `Time`) to the left of the newest round (starting at column D, or add a new pair of columns at the end of the current block):
   - **Row 1**: Student's level in capitals (e.g. `JUNIOR 1`) above the `Score` column.
   - **Row 2**: `ROUND <n>` (e.g. `ROUND 15`) above the `Score` column.
   - **Row 3**: `Date - dd/mm/yyyy` (e.g. `Date - 27/10/2026`) above the `Score` column.
   - **Row 4**: `Score` in the left column and `Time` in the right column.
3. Fill in each category row:
   - **Score column**: Enter `correct/total` (for example `19/20`). For `Surprise Task`, enter `correct/total`, a short text note, or `........` if not attempted.
   - **Time column**: Enter `m:ss` (for example `2:18`) or `h:mm:ss` (`1:05:09`) for Category-wise rounds. Leave per-category `Time` cells **blank** for Flat rounds.
4. Fill in the 5 summary rows at the bottom of the round's `Score` column:
   - `Round Type`: `Category wise` or `Flat Round`
   - `Time Taken`: `hh:mm:ss` (e.g. `01:09:01`) or `Without time`
   - `Final Score`: Sum of `correct`
   - `Total Attempt`: Sum of `total`
   - `Marks TO BE CORRECTED`: `Total Attempt - Final Score`

---

## Step 3: Export Modified Tabs as CSV When the Website Is Back

Once Trendz Tracker is back online:

1. Open your **working copy** spreadsheet in Google Sheets.
2. Click on the tab of a student for whom you entered new rounds during the outage.
3. Click **File &rarr; Download &rarr; Comma Separated Values (.csv)** to download that student's sheet to your computer.
4. Repeat for each student tab that was updated during the outage.

---

## Step 4: Import the CSV Files Through `/pages/import.html`

1. Sign in to Trendz Tracker as an Admin and open **Setup &rarr; Import** (`/pages/import.html`).
2. Select the student in **Step 1** and choose the downloaded `.csv` file.
3. In **Step 2 (Preview)**:
   - Confirm the simulator series for each block.
   - Review the comparison table: **all rounds that already existed before the outage are recognized and skipped/kept automatically**, and only the newly recorded rounds (or new cells) are queued for import.
4. In **Step 3**, click **Import** and confirm.
5. After importing all modified student tabs, open **Setup &rarr; Backup** (`/pages/backup.html`) and click **Update score sheets now** so the read-only Score Sheet Mirror is refreshed with the newly imported rounds.

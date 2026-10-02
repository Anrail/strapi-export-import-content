# strapi-export-import-content

Export the entries of a Strapi 5 collection type from the Content Manager list view as CSV,
JSON or XLSX, edit the file, and import it back into the same project.

- The export takes what the list shows: current filters, search and locale, or the selected rows.
- Media is exported as URLs and matched against the Media Library on import; nothing is downloaded.
- Components and dynamic zones are JSON in one cell.
- Import runs a dry run first. A row changed by someone else after the export is rejected as a
  whole (export again). Empty cells clear a field only after you confirm it per field.
- Changes go to the draft and nothing is published. Types without Draft & Publish have no
  draft: their changes go live immediately.
- XLSX cannot hold more than 32,767 characters in a cell, nor some characters (control
  characters such as a vertical tab pasted from Word, a lone carriage return, text shaped like
  `_x000D_`): such values are replaced by the marker
  `#NOT_EDITABLE_IN_XLSX: edit this field in CSV or JSON#` and left untouched on import — use CSV
  or JSON for them.

Local media URLs are built from the server's public URL, so set `url` in `config/server.ts`;
without it Strapi reports `http://0.0.0.0:<port>` in production.

## Install

    pnpm add strapi-export-import-content

Grant the `Export` and `Import` permissions of the plugin to a role in
Settings → Roles → Plugins.

## Requirements and limits

- A user needs the plugin's `Export` / `Import` permission **and** the Content Manager `Read`
  (and, to import, `Create` / `Update`) permissions on the content type, fields included.
- A file can only be imported into the project it was exported from: entries, media and
  relations are matched by their `documentId` and URLs there.
- A changed row must keep its `updatedAt` column; it is how a row edited by someone else after
  the export is detected.
- Apply writes exactly what the dry run showed: if an entry, a media file or a relation target
  changed in between, nothing is written and a new dry run is shown. The stale check is repeated
  right before each row is written; there is no row lock, so an edit landing in the same
  instant as the write can still be overwritten.
- A row that adds a new locale to an existing document never changes the fields shared by all
  locales; change those in a row of an existing locale.
- A field you may read in general but not on a particular entry is exported empty for that entry
  and cannot be imported for it.
- Large numbers: write a `biginteger` beyond 2^53 as text in a JSON file; a `decimal` with more
  digits than a double holds is kept as text, unrounded.
- Tested on Strapi 5.48. XLSX files are read with `exceljs` 4.4.

## Configuration (`config/plugins.ts`)

    'export-import-content': {
      config: {
        maxExportRows: 5000,
        maxImportRows: 2000,
        maxImportBytes: 10 * 1024 * 1024,
        maxCells: 200000,
        maxCellLength: 1000000,
      },
    },

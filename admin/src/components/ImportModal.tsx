import * as React from 'react';

import { Box, Button, Checkbox, Flex, Modal, Typography } from '@strapi/design-system';
import { useNotification } from '@strapi/strapi/admin';

import { importFile } from '../api';
import type { ImportReport, RowReport } from '../api';
import { clearChoices } from '../utils/clears';
import type { ClearChoice } from '../utils/clears';
import { changedFields } from '../utils/fields';

const MAX_LISTED = 100;

const SummaryLine = ({ report }: { report: ImportReport }) => {
  const { create, update, localize, unchanged, errors, failed } = report.summary;
  const lines: Array<[string, number]> = [
    ['Create', create],
    ['Update', update],
    ['New localizations', localize],
    ['Unchanged', unchanged],
    ['Rows with errors', errors],
  ];
  return (
    <Flex direction="column" alignItems="flex-start" gap={1}>
      {lines.map(([label, count]) => (
        <Typography key={label}>{`${label}: ${count}`}</Typography>
      ))}
      {failed > 0 && <Typography textColor="danger600">{`Failed: ${failed}`}</Typography>}
    </Flex>
  );
};

const RowList = ({ title, rows, pick, textColor }: { title: string; rows: RowReport[]; pick: (row: RowReport) => string[]; textColor: string }) => {
  const lines = rows.flatMap((row) => pick(row).map((message) => `Row ${row.row}${row.documentId ? ` (${row.documentId})` : ''}: ${message}`));
  if (!lines.length) return null;
  return (
    <Box>
      <Typography variant="delta">{`${title} (${lines.length})`}</Typography>
      <Box maxHeight="240px" overflow="auto" paddingTop={2}>
        {lines.slice(0, MAX_LISTED).map((line) => (
          <Typography key={line} tag="p" textColor={textColor}>
            {line}
          </Typography>
        ))}
        {lines.length > MAX_LISTED && <Typography tag="p">{`…and ${lines.length - MAX_LISTED} more`}</Typography>}
      </Box>
    </Box>
  );
};

export const ImportModal = ({ uid, onClose }: { uid: string; onClose: () => void }) => {
  const { toggleNotification } = useNotification();
  const [file, setFile] = React.useState<File | null>(null);
  const [report, setReport] = React.useState<ImportReport | null>(null);
  const [allowClear, setAllowClear] = React.useState<string[]>([]);
  const [sentClear, setSentClear] = React.useState<string[]>([]);
  const [choices, setChoices] = React.useState<ClearChoice[]>([]);
  const [busy, setBusy] = React.useState(false);
  const picker = React.useRef<HTMLInputElement>(null);

  const send = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const next = await importFile(uid, file, dryRun, allowClear, dryRun ? undefined : report?.planHash);
      setReport(next);
      setChoices((shown) => clearChoices(shown, next.clears, allowClear));
      setSentClear(allowClear);
    } catch (error: any) {
      toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message ?? error?.message ?? 'Import failed' });
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setReport(null);
    setAllowClear([]);
    setSentClear([]);
    setChoices([]);
  };

  const toggleClear = (field: string, checked: boolean) =>
    setAllowClear((fields) => (checked ? [...fields, field] : fields.filter((name) => name !== field)));

  const done = Boolean(report?.applied);
  const blocked = !report || report.fileErrors.length > 0 || report.summary.errors > 0;
  const sameClears = allowClear.length === sentClear.length && allowClear.every((field) => sentClear.includes(field));
  const writes = report ? report.summary.create + report.summary.update + report.summary.localize : 0;
  const failed = report?.rows.filter((row) => row.outcome === 'failed') ?? [];
  const changed = report ? changedFields(report.rows) : null;

  const close = () => {
    // While a request runs the server may be writing: leaving now would hide the result and invite a second import.
    if (busy) return;
    onClose();
    if (done) window.location.reload();
  };

  return (
    <Modal.Root open onOpenChange={(open: boolean) => !open && close()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>Import entries</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Flex direction="column" alignItems="stretch" gap={4}>
            <Typography>
              Import a file exported from this list (CSV, JSON or XLSX). Changes go to the draft and nothing is published.
              Types without Draft &amp; Publish have no draft: their changes go live immediately.
              A row changed by someone else after the export is rejected as a whole - export again.
            </Typography>
            <Flex gap={3} alignItems="center">
              <Button variant="secondary" disabled={busy || done} onClick={() => picker.current?.click()}>
                Choose file
              </Button>
              <Typography textColor="neutral600">{file ? file.name : 'No file chosen'}</Typography>
              <input ref={picker} type="file" accept=".csv,.json,.xlsx" onChange={pickFile} hidden />
            </Flex>

            {report && (
              <>
                <Typography variant="delta">{done ? 'Result' : 'Test result'}</Typography>
                <SummaryLine report={report} />
                {changed && <Typography>{`Changed fields: ${changed}`}</Typography>}

                {report.draftAndPublish === false && (
                  <Typography textColor="warning600">
                    This content type has no drafts - applying changes the live entries immediately.
                  </Typography>
                )}

                {report.fileErrors.map((message) => (
                  <Typography key={message} textColor="danger600">
                    {message}
                  </Typography>
                ))}

                {!done && choices.length > 0 && (
                  <Box>
                    <Typography variant="delta">Empty cells over existing values</Typography>
                    <Typography tag="p">
                      Tick a field to clear it in those rows. Unticked fields are left untouched. Test the file again after changing the ticks.
                    </Typography>
                    {choices.map(({ field, rows }) => (
                      <Checkbox key={field} checked={allowClear.includes(field)} onCheckedChange={(checked: boolean) => toggleClear(field, checked === true)}>
                        {`Clear "${field}" in ${rows} row(s)`}
                      </Checkbox>
                    ))}
                  </Box>
                )}

                {report.allLocales.length > 0 && (
                  <Typography textColor="warning600">
                    {`Applies to all locales: ${report.allLocales.map(({ field, rows }) => `${field} (${rows})`).join(', ')}`}
                  </Typography>
                )}
                {report.willBecomeModified > 0 && !done && (
                  <Typography textColor="warning600">
                    {`${report.willBecomeModified} published entries will become "Modified" until you publish them.`}
                  </Typography>
                )}

                <RowList title="Errors" rows={report.rows} pick={(row) => row.errors} textColor="danger600" />
                <RowList title="Warnings" rows={report.rows} pick={(row) => row.warnings} textColor="warning600" />
                {done && (
                  <RowList title="Failed while writing" rows={failed} pick={(row) => [row.message ?? 'failed']} textColor="danger600" />
                )}
                {done && failed.length > 0 && (
                  <Typography textColor="danger600">Rows that were written before or after a failure stay written.</Typography>
                )}
              </>
            )}
          </Flex>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="tertiary" onClick={close} disabled={busy}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done && (
            <Flex gap={2}>
              <Button variant="secondary" disabled={!file || busy} loading={busy} onClick={() => send(true)}>
                Testing file before apply
              </Button>
              <Button disabled={blocked || busy || writes === 0 || !sameClears} onClick={() => send(false)}>
                {`Apply ${writes} change(s)`}
              </Button>
            </Flex>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};

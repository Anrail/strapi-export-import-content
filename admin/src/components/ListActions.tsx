import * as React from 'react';

import { Menu, VisuallyHidden } from '@strapi/design-system';
import { Download } from '@strapi/icons';
import { useNotification, useQueryParams, useRBAC } from '@strapi/strapi/admin';
import { useParams } from 'react-router-dom';

import { collectDocumentIds, exportEntries, exportMessage, FORMATS, localeOf, PERMISSION_LIST } from '../api';
import type { Format } from '../api';
import { ImportModal } from './ImportModal';

export const ListActions = () => {
  const { collectionType, slug } = useParams<{ collectionType: string; slug: string }>();
  const [{ query }] = useQueryParams<Record<string, any>>();
  const { toggleNotification } = useNotification();
  const { allowedActions } = useRBAC(PERMISSION_LIST);
  const [busy, setBusy] = React.useState(false);
  const [importing, setImporting] = React.useState(false);

  const canExport = Boolean(allowedActions.canExport);
  const canImport = Boolean(allowedActions.canImport);
  if (collectionType !== 'collection-types' || !slug || !slug.startsWith('api::') || (!canExport && !canImport)) {
    return null;
  }

  const runExport = async (format: Format) => {
    setBusy(true);
    try {
      const ids = await collectDocumentIds(slug, query);
      if (!ids.length) {
        toggleNotification({ type: 'info', message: 'Nothing to export: the list is empty.' });
        return;
      }
      const result = await exportEntries(slug, localeOf(query), ids, format);
      toggleNotification(exportMessage(result.rowCount, result.longCells));
    } catch (error: any) {
      toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message ?? error?.message ?? 'Export failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger variant="tertiary" endIcon={null} paddingLeft="7px" paddingRight="7px" disabled={busy} loading={busy}>
          <Download aria-hidden focusable={false} />
          <VisuallyHidden tag="span">Export or import entries</VisuallyHidden>
        </Menu.Trigger>
        <Menu.Content popoverPlacement="bottom-end">
          {canExport &&
            FORMATS.map((format) => (
              <Menu.Item key={format} onSelect={() => runExport(format)}>
                {`Export ${format.toUpperCase()}`}
              </Menu.Item>
            ))}
          {canImport && <Menu.Item onSelect={() => setImporting(true)}>Import…</Menu.Item>}
        </Menu.Content>
      </Menu.Root>
      {importing && <ImportModal uid={slug} onClose={() => setImporting(false)} />}
    </>
  );
};

import * as React from 'react';

import { Button, Flex, Typography } from '@strapi/design-system';
import { useNotification, useQueryParams, useRBAC } from '@strapi/strapi/admin';

import { exportEntries, exportMessage, FORMATS, localeOf, PERMISSION_LIST } from '../api';
import type { Format } from '../api';

interface ChoicesProps {
  model: string;
  documentIds: string[];
  onClose: () => void;
}

const FormatChoices = ({ model, documentIds, onClose }: ChoicesProps) => {
  const [{ query }] = useQueryParams<Record<string, any>>();
  const { toggleNotification } = useNotification();
  const [busy, setBusy] = React.useState(false);

  const run = async (format: Format) => {
    setBusy(true);
    try {
      const result = await exportEntries(model, localeOf(query), documentIds, format);
      toggleNotification(exportMessage(result.rowCount, result.longCells));
      onClose();
    } catch (error: any) {
      toggleNotification({ type: 'danger', message: error?.response?.data?.error?.message ?? error?.message ?? 'Export failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" alignItems="stretch" gap={4} padding={6}>
      <Typography>{`Export ${documentIds.length} selected entries as:`}</Typography>
      <Flex gap={2}>
        {FORMATS.map((format) => (
          <Button key={format} variant="secondary" disabled={busy} onClick={() => run(format)}>
            {format.toUpperCase()}
          </Button>
        ))}
      </Flex>
    </Flex>
  );
};

/** Content Manager bulk action: shown in the bar that appears when rows are selected. */
export const ExportBulkAction = ({ documents, model, collectionType }: { documents: any[]; model: string; collectionType: string }) => {
  const { allowedActions } = useRBAC(PERMISSION_LIST);
  const documentIds = documents.map((document) => document.documentId);
  const idsKey = documentIds.join(',');
  // Stable component identity: an inline arrow would remount FormatChoices on every render.
  const content = React.useMemo(() => {
    const ids = idsKey ? idsKey.split(',') : [];
    const Content = ({ onClose }: { onClose: () => void }) => (
      <FormatChoices model={model} documentIds={ids} onClose={onClose} />
    );
    return Content;
  }, [model, idsKey]);
  if (collectionType !== 'collection-types' || !model.startsWith('api::') || !allowedActions.canExport) return null;

  return {
    label: 'Export',
    variant: 'secondary' as const,
    dialog: {
      type: 'modal' as const,
      title: 'Export selected entries',
      content,
    },
  };
};

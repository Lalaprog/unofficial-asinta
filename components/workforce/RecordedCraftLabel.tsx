import React from 'react';
import type {HistoryRecord} from '@/lib/attendance/history';
import {parseRecordedCraft} from '@/lib/workforce/recordedCraft';

export function RecordedCraftLabel({record}: {record: HistoryRecord}) {
  const craft = parseRecordedCraft(record as unknown as Record<string,unknown>);
  if (craft) return <div className="text-ink-secondary">Craft at entry: {craft.label} (may differ from work date)</div>;
  return record.worker_position ? <div className="text-ink-secondary">Current craft: {record.worker_position} (historical craft not recorded)</div> : null;
}

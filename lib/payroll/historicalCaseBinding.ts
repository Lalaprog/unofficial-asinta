// Protocol for the HELD case-binding candidate. This module is not a feature
// flag, installer, UI cutover, or permission to reuse legacy retry records.
import {attributionArguments, attributionStatusMatches, parseAttributionAttempt, sameAttributionEvidence, type AttributionAttempt, type AttributionStatus} from './historicalAttribution';
import {parsePeriodCases, samePeriodSnapshot, snapshotFromExternal, type PeriodCase} from './paidPeriodCases';
import type {ExternalRow} from './historicalExternalWorker';

type CaseInventory = {snapshot: unknown; total: number; items: unknown[]};
export type BoundAttributionAttempt = {version: 2; attribution: AttributionAttempt; reviewed_cases: CaseInventory};
export type BoundAttributionVerification = {casesChanged: boolean};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, expected: string) => Object.keys(x).sort().join(',') === expected;

// Keep the full server JSON, not only the parsed display items: the database
// compares and stores that exact JSONB inventory, including its source snapshot.
export function parseBoundCaseInventory(raw: unknown, source: ExternalRow): {inventory: CaseInventory; cases: PeriodCase[]} {
 if (!object(raw) || !keys(raw, 'items,snapshot,total')) throw Error('Invalid case inventory shape');
 const serialized = JSON.stringify(raw);
 if (!serialized || new TextEncoder().encode(serialized).length > 1048576) throw Error('Case inventory too large');
 const inventory = JSON.parse(serialized) as CaseInventory;
 const expected = snapshotFromExternal(source), cases = parsePeriodCases(inventory, expected);
 if (cases.some(item => !samePeriodSnapshot(item.original_snapshot, expected))) throw Error('Case original differs from source');
 return {inventory, cases};
}

export function parseBoundAttributionAttempt(raw: unknown, actor: string, worker: string, sourceId: string): BoundAttributionAttempt {
 if (!object(raw) || !keys(raw, 'attribution,reviewed_cases,version') || raw.version !== 2) throw Error('Invalid case-bound retry version');
 const attribution = parseAttributionAttempt(raw.attribution, actor, worker, sourceId);
 const {inventory} = parseBoundCaseInventory(raw.reviewed_cases, attribution.source);
 return {version: 2, attribution, reviewed_cases: inventory};
}

export function boundAttributionArguments(a: BoundAttributionAttempt) {
 return {...attributionArguments(a.attribution), p_cases: a.reviewed_cases};
}

// Read both the original attribution and binding. A missing binding cannot be
// upgraded to a bound decision; later case changes don't prevent exact replay,
// but must be surfaced to the caller, not mistaken for a fresh review.
export function verifyBoundAttribution(raw: unknown, original: AttributionStatus, a: BoundAttributionAttempt): BoundAttributionVerification {
 if (!object(raw) || !keys(raw, 'actor_id,cases_changed,found,recorded_at,request_id,reviewed_cases,source_changed,source_id') || raw.found !== true ||
     raw.request_id !== a.attribution.id || raw.source_id !== a.attribution.source.request_id || raw.actor_id !== a.attribution.actor ||
     typeof raw.recorded_at !== 'string' || !Number.isFinite(Date.parse(raw.recorded_at)) || typeof raw.cases_changed !== 'boolean' || raw.source_changed !== false ||
     !attributionStatusMatches(original, a.attribution)) throw Error('Case-bound attribution evidence differs');
 const reviewed = parseBoundCaseInventory(raw.reviewed_cases, a.attribution.source).inventory;
 if (!sameAttributionEvidence(reviewed, a.reviewed_cases)) throw Error('Reviewed case evidence differs');
 return {casesChanged: raw.cases_changed};
}

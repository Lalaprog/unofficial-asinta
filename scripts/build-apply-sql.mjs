#!/usr/bin/env node
/**
 * Disabled intentionally: the historical generator did not account for hosted
 * migration history, complete client-install dependencies, or writes embedded
 * in some migrations. A syntactically valid bundle is not a deployment plan.
 * Do not add an override; restore a generator only after its replacement and
 * isolated installation/upgrade procedures have been reviewed and verified.
 * Historical source is available in Git history.
 */
console.error(
  'SQL bundle generation is disabled: current bundles and migration history have not been verified for installation or upgrade. ' +
  'No files were written. See supabase/apply/README.md and docs/CLIENT_CHANGE_PLAN.md.'
);
process.exitCode = 1;

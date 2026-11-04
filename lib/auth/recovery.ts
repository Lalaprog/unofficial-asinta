// A presentation-only marker, not an authorization or identity decision.
// It keeps the optional password choice through an authenticator challenge.
export const RECOVERY_CHOICE_KEY = 'bale-email-signin-password-choice';

export function markRecoveryChoice() {
  try { window.sessionStorage.setItem(RECOVERY_CHOICE_KEY, '1'); } catch { /* storage can be disabled */ }
  // Presentation-only cookie lets middleware preserve the choice on refresh.
  document.cookie = `${RECOVERY_CHOICE_KEY}=1; Path=/; Max-Age=1800; SameSite=Lax`;
}
export function hasRecoveryChoice() {
  let stored = false;
  try { stored = window.sessionStorage.getItem(RECOVERY_CHOICE_KEY) === '1'; } catch { /* storage can be disabled */ }
  return stored || document.cookie.split('; ').includes(`${RECOVERY_CHOICE_KEY}=1`);
}
export function clearRecoveryChoice() {
  try { window.sessionStorage.removeItem(RECOVERY_CHOICE_KEY); } catch { /* non-fatal */ }
  document.cookie = `${RECOVERY_CHOICE_KEY}=; Path=/; Max-Age=0; SameSite=Lax`;
}

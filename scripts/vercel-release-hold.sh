#!/usr/bin/env bash
# Vercel ignore step: 0 cancels, 1 continues. This narrow exception is for
# one explicit development-site release, not a client go-live. The build step
# independently verifies the flags and target even if this ignore step is bypassed.
case "${VERCEL_ENV:-}" in
  preview|development)
    echo 'Preview/development build allowed; it may still connect to shared services.'
    exit 1
    ;;
  production)
    if [[ "${VERCEL_GIT_COMMIT_REF:-}" == 'arena/e137cf5b-unofficial-asinta' && "${ASINTA_DEVELOPMENT_RELEASE_SHA:-}" =~ ^[a-f0-9]{40}$ && "${VERCEL_GIT_COMMIT_SHA:-}" == "${ASINTA_DEVELOPMENT_RELEASE_SHA}" ]]; then
      echo 'Pinned development-site build allowed; build-time target checks still apply.'
      exit 1
    fi
    ;;
esac
echo 'Production or unknown-environment build held pending a coordinated release.'
exit 0

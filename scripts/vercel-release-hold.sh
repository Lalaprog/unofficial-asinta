#!/usr/bin/env bash
# Vercel ignore step: 0 cancels, 1 continues. A release must deliberately
# remove or replace this hold after website/database compatibility is verified.
# Missing or unexpected environment is held rather than assumed to be preview.
case "${VERCEL_ENV:-}" in
  preview|development)
    echo 'Preview/development build allowed; it may still connect to shared services.'
    exit 1
    ;;
  *)
    echo 'Production or unknown-environment build held pending a coordinated release.'
    exit 0
    ;;
esac

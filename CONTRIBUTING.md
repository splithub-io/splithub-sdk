# Contributing

Thanks for helping. A few things to know first.

## How this repository works

This repository is a published copy of the SDK. We develop it next to SplitHub Cloud and copy it here with every release. That means:

- We review your pull request here, then apply it on our side and credit you in the commit. Your PR is closed when the release that contains it lands.
- Commit history here is one commit per release.

## Before you open a pull request

- Run `pnpm build && pnpm test` and keep both green.
- Keep `@splithub/core` free of runtime dependencies.
- Assignment must stay identical in the SDK, the Next middleware and the browser script. If you touch it, add a test for each.
- User-facing text is warm and plain: one idea per sentence, no more than two sentences.

## Reporting a security problem

Please don't open a public issue. Write to security@splithub.io and we'll answer within two working days.

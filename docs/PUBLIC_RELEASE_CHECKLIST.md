# Public release checklist

This checklist records the local release candidate and separates it from work that requires a separately reviewed GitHub publication step. It does not authorize GitHub creation, remote configuration, or publication.

## Complete now

- [x] Complete test suite passes locally: 215 passed, 0 failed, 0 skipped.
- [x] Core TypeScript check passes with `npm run typecheck`.
- [x] Worker TypeScript check passes with `npm run typecheck:worker`.
- [x] Hardware-free offline demo passes with `npm run demo`.
- [x] Clean-room reproduction passes using a temporary copy of public files.
- [x] Apache License 2.0 `LICENSE` is present; project attribution is in `NOTICE`.
- [x] README reviewed for implemented behavior, unsupported capabilities, safety boundaries, and local setup.
- [x] `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` are present.
- [x] CI workflow runs tests, both type checks, and the offline demo without Cloud credentials or deployment steps.
- [x] Documentation index is present at `docs/README.md`.
- [x] Privacy/secret scan found no blocking secret; synthetic public test vectors are clearly non-production material.
- [x] Local Wrangler configuration, environment files, logs, and generated state are excluded by `.gitignore`; the public Wrangler example uses a placeholder.
- [x] Unnecessary production-only identifiers are omitted from public documentation.
- [x] No production credentials are included in the public candidate files.
- [x] Verified private security-reporting contact is documented in `SECURITY.md`.
- [x] Verified Code of Conduct enforcement contact is documented in `CODE_OF_CONDUCT.md`.
- [x] Local Git repository initialized on `main`; no remote is configured.
- [x] Pre-Git inventory reviewed; only intended public files are staged.
- [x] Exact staged-content privacy/secret scan and staged diff review passed.
- [x] No Cloud operation or hardware contact occurred during this completion phase.
- [x] One local initial commit created; committed tree reviewed and exact committed-content scan passed.

## Required at publication

- [ ] Create the GitHub repository only after selecting its visibility and confirming the Apache-2.0 license choice.
- [ ] Make the first push only after reviewing the remote repository target and visibility.
- [ ] Verify GitHub CI passes on the pushed default branch and on a pull request.
- [ ] Inspect rendered README, documentation links, license, and Code of Conduct on GitHub.
- [ ] Verify repository visibility and displayed license after creation.
- [ ] Confirm no production credentials, local Wrangler file, production-only identifiers, or private household data were committed.

Publication is not complete until the required-at-publication items are reviewed and checked by the repository owner.

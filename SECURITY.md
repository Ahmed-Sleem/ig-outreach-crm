# Security

## Reporting a vulnerability

Do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting on this repository, or the contact address on the
maintainer's GitHub profile.

Please include:

- the version or commit you tested;
- the smallest reproduction you can manage;
- whether the problem needs a logged-in Instagram session to trigger.

Reports are acknowledged as they arrive. Fixes are released before any public
description of the problem.

## Threat model

This extension runs inside your real, logged-in Instagram session. Three
properties matter more than any feature:

1. **Scraped content is untrusted input.** Usernames, display names, bios,
   comments and message bodies are rendered as text nodes only. There is no
   `innerHTML` assignment anywhere in `src/`, and `npm run verify` fails the
   build if one appears.
2. **Credentials never leave the browser, and never reach disk.** Session and
   CSRF values are read from the live page when a request needs them, held in
   memory, and stripped from every export and backup by the redaction step in
   `src/storage/settings.js`. No `.igcrm.json` backup contains a cookie.
3. **No third-party network access.** The only hosts contacted are
   `instagram.com` and Instagram's own CDNs. The content security policy is
   `script-src 'self'; object-src 'self'; style-src 'self'`: no remote script,
   no CDN font, no analytics pixel.

## Exported CSV files

Every CSV cell matching `/^[=+\-@\t\r]/` is prefixed with a single quote before
it is written. A scraped display name such as `=CMD()` therefore cannot execute
when the file is opened in a spreadsheet. The escaping is covered by
`tests/export.test.js`.

## Out of scope

Reports that amount to "Instagram could detect this traffic" are not
vulnerabilities in this code; they are the platform's normal behaviour and are
documented in `docs/SAFETY.md`.

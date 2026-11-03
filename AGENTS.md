# Working on this sample

- Scope: a basic Webex Contact Center Media Forking receiver and developer setup path.
- Use Node.js 24, the published protobuf contract, and the existing small module structure.
- Run `npm run check`, `npm run demo`, and `npm audit` before a PR is ready.
- Keep authentication enabled. Never log or commit tokens, raw audio, private keys, or tenant configuration.
- Keep synthetic test/demo trust material isolated from the real receiver entry point.
- Validate overload, cancellation, and failures when changing the audio lifecycle.
- Live tenant validation is a separate step recorded in `docs/VALIDATION.md`; local tests do not prove it.
- Do not merge, change repository visibility, or deploy without the user's selected delivery scope.

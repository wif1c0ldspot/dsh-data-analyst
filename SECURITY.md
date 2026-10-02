# Security policy

## Supported version

Security fixes currently target the latest revision of the default branch. The
project is pre-1.0 and pins the dsh revision it has reviewed in
`profiles/data-analyst/upstream-lock.json`.

## Reporting a vulnerability

Use the repository host's private security-advisory channel. Do not include API
keys, dataset contents, local paths or other sensitive information in a public
issue. Include the affected revision, reproduction steps, observed capability
boundary and expected behavior. Maintainers should acknowledge a report before
requesting additional sensitive evidence.

## Security boundary

The supported deployment is a single-user local dsh profile bound to loopback.
The model can access only the documented analyst tools. SQL authorization,
immutable dataset selection, worker environment scrubbing, artifact authorization
and report escaping are enforced by services independently of prompts and skills.
Internet-facing or multi-user hosting is outside the supported security model.

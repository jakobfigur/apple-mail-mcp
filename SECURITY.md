# Security policy

## Scope

`apple-mail-mcp` is a local MCP server. It controls the Apple Mail app on the
machine where it is run, and should only be installed by a user who trusts the
MCP client that launches it.

It never stores mail passwords or opens a network listener. macOS Automation
permissions are still required and should be reviewed by the user.

## Reporting a vulnerability

Please do not open a public issue for a potential security vulnerability.
Instead, use GitHub's private vulnerability reporting feature for this
repository, or contact the maintainer through the email address listed on the
GitHub profile.

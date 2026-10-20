# Contributing to StayPilot

Thanks for helping improve StayPilot. Keep changes focused and describe the behavior or documentation they improve.

## Set up a checkout

Use Node.js 20.12 or newer and an installed Google Chrome or Microsoft Edge browser. If you do not have write access to this repository, fork it first and clone your fork instead.

```sh
git clone https://github.com/yestto/Agenthotel-booking.git
cd Agenthotel-booking
npm ci
git switch -c your-change-name
```

Create a local environment file using the command for your shell:

```powershell
# PowerShell
Copy-Item .env.example .env
```

```sh
# Bash or another POSIX shell
cp .env.example .env
```

For a live agent run, configure `LLM_PROVIDER` and its matching API key in `.env`, following the [README](README.md#run-the-complete-platform). On non-Windows hosts, also set `CHROME_PATH` to your installed Chrome or Chromium executable. Never include credentials in a commit, issue, pull request, screenshot, or test report.

### Browser path on Linux and macOS

Set `CHROME_PATH` in the same shell you use to start the agent. These examples use common Google Chrome installation paths; replace the path if your browser is installed elsewhere.

```sh
# Linux
export CHROME_PATH="/usr/bin/google-chrome"
```

```sh
# macOS
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

On macOS, choose the executable inside the application bundle, rather than the `.app` directory itself. On Linux, use the installed Chrome or Chromium executable rather than a desktop shortcut.

Start the local console with:

```sh
npm run agent-ui
```

Open <http://127.0.0.1:4180>. Live supplier runs must stop before entering personal details or completing a booking or payment.

## Check your change

Choose checks relevant to the files you changed:

| Command | Coverage |
| --- | --- |
| `npm test` | Syntax, core behavior, build, Worker, and deployment artifact checks. |
| `npm run test:scenarios` | Model-provider contracts, browser/workflow agents, discovery, and controlled workflow scenarios. |
| `npm run test:server` | Local API behavior. |
| `npm run test:share` | Sharing gateway with an isolated HTTP fixture. |
| `npm run test:browser` | Browser fixtures, checkout proof, adversarial cases, and discovery UI. |
| `npm run test:all` | All of the suites above. |

Browser tests need an installed browser. For documentation-only changes, verify commands, links, and examples against the current source; an unchanged runtime does not require a full live hotel run.

Live commands are listed separately in the [verification section](README.md#verification). They can call external models or supplier websites and consume provider quota. Run them deliberately, report what actually passed, and distinguish live evidence from controlled fixtures. Never present an older report as validation of a new change.

## Open a pull request

1. Commit only files relevant to your change. Keep `.env`, `.env.share`, browser profiles, and generated `artifacts/` out of Git.
2. Push your branch and open a pull request targeting `main`.
3. Explain the problem, the resulting behavior, and the checks you ran. Link a related issue with `Fixes #<issue-number>` when the change resolves it.
4. If another person contributed to the commit, credit their actual work with a `Co-authored-by: Name <email>` trailer using an email associated with their GitHub account.
5. Address feedback and check the final diff before merging.

Preserve the provider restrictions, date and occupancy validation, exact-price checks, cancellation handling, and the read-only boundary at guest details. Add focused regression coverage when changing these behaviors.

## Report a problem

Include reproduction steps, expected and actual behavior, your operating system and Node.js version, and a sanitized error message. Remove credentials and personal or booking information before sharing any evidence.

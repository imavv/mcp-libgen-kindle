# mcp-libgen

MCP server that searches Library Genesis for EPUBs, stores them in Google Drive,
and emails them to a Kindle. Runs on Vercel so it works from the Claude mobile
app, not just a local desktop client.

## How it works

```
search_libgen(query)      HTTP only. Fetches the search page, extracts the id
                          list behind its JSON tab, resolves metadata through
                          json.php. No browser automation.
        |
        v   model picks a row
download_book(md5)        Fetches the file, validates it is a real EPUB,
                          uploads it to Google Drive.
        |
        v
send_to_kindle(file_id)   Pulls it back out of Drive and emails it.
```

Drive sits between the two halves because they are separate Vercel invocations
on potentially different instances, and `/tmp` is not guaranteed to survive
between them. It also gives you a durable library, so `list_library` can
re-send a book without touching libgen again.

### The confirmation checkpoint

`download_book` stops after storing and does not hand the model a next step.
Its tool result says the file is not yet sent and instructs the model to show
the preview link and ask. `send_to_kindle` says in its description that it
requires explicit confirmation first.

This is deliberate and worth preserving if you edit those strings. An earlier
version ended the `download_book` result with `Next: call send_to_kindle with
drive_file_id=...` and the model reliably chained straight through to sending,
giving no chance to look at the file. Sending is the irreversible step.

Note the limit: this is influence, not enforcement. The server cannot tell
whether a human actually confirmed. The only hard gate is client-side — if
`send_to_kindle` is set to "always allow" in the connector's permissions, no
prompt appears regardless of what these descriptions say.

**No Playwright.** Serverless bundles cap out around 250 MB and Chromium does
not fit. Everything here is plain `fetch`.

### The download chain

Worth knowing before debugging this, because none of it is guessable:

`get.php?md5=...` does not serve the file. It redirects to `ads.php`, whose
HTML carries the real link with a per-request key:

```
get.php?md5=23fcc521...&key=RRSN1X66L729FJNH
```

That key changes on every fetch, so it must be read from the page just loaded
and used immediately. It cannot be cached or constructed. Following it lands on
a CDN host (`cdn2.booksdl.lc` at time of writing) which returns
`application/octet-stream`.

The link-matching pattern is deliberately narrow. A looser one that also
matched `cdn.` picked up the ads page's own `bootstrap.min.css` from jsDelivr
and fed the stylesheet to the epub validator, which reported it as
`got bytes 2f 2a` — the opening of a CSS comment. If this breaks again, check
what `fetchFileOrFollow` actually retrieved before assuming the mirror is down.

## Setup

### 1. Install

```bash
npm install
```

### 2. Google Drive credentials

Service accounts do not work here. They have no Drive storage quota on personal
(non-Workspace) Google accounts, so they cannot own files in your My Drive. You
need OAuth2 with a stored refresh token.

1. Google Cloud Console, new project, enable the **Google Drive API**.
2. **Credentials** -> Create credentials -> OAuth client ID. Either application
   type works. If you pick **Web application**, you must add
   `http://localhost:53682/callback` under **Authorised redirect URIs** or the
   consent flow fails with `redirect_uri_mismatch`. **Desktop app** clients
   accept loopback addresses without registering them.
3. **OAuth consent screen** -> **Audience**:
   - User type **External** (personal Gmail cannot use Internal).
   - Add yourself under **Test users**.
   - Then **Publish app** to move from Testing to **In production**. Refresh
     tokens issued while an app is in Testing expire after 7 days, and the
     resulting failure days later does not obviously point back at this.
4. Download `credentials.json` into the project root. `npm run auth` reads it
   directly, so you do not need to copy the id and secret by hand. It is
   gitignored.
5. Run the one-time consent flow:

```bash
npm run auth
```

Keep that terminal open, approve in the browser, and paste the resulting
`GOOGLE_REFRESH_TOKEN` into `.env.local`.

The scope is `drive.file`, which is per-file access to files this app creates.
It cannot see the rest of your Drive, and it is not a restricted scope, so
publishing the consent screen needs no verification review.

### 3. Gmail app password

Requires 2FA on the account. Generate at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
and put the 16 characters in `GMAIL_APP_PASSWORD`, with no spaces. This is not
your Google account password.

### 4. Amazon approved sender

In Amazon -> Manage Your Content and Devices -> Preferences -> Personal Document
Settings, add `SENDER_EMAIL` to the **Approved Personal Document E-mail List**.
It must match exactly. If it does not, Amazon discards the email silently and
nothing in this server can detect it.

### 5. MCP auth token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put it in `MCP_AUTH_TOKEN`. The endpoint downloads files and sends mail from
your Gmail, so it must not be open.

### 6. Verify credentials

```bash
npm run check
```

Exchanges the refresh token, calls the Drive API, and authenticates against
Gmail SMTP, without writing a file to Drive or sending an email. Run this
before deploying, and again first thing whenever something breaks: most
failures in this system are credential problems that surface far from their
cause.

### 7. Deploy

```bash
vercel deploy
```

Add every variable from `.env.example` to the Vercel project's environment
variables. Raise `maxDuration` in `app/api/[transport]/route.ts` as far as your
plan allows. libgen mirrors are slow, and the cap is a hard kill with no
partial result.

### 8. Smoke test before anything else

```bash
curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" "https://<deployment>/selftest?q=of+mice+and+men"
```

This exercises search and a real download from inside a Vercel function, which
answers the one remaining unknown: **does libgen serve Vercel's IPs at all?**
Vercel egresses from AWS ranges, and Cloudflare-fronted mirrors challenge
datacenter traffic more than residential. Working from your laptop proves
nothing about this. If it fails here, the host choice is wrong and no amount of
code fixes it.

Add `&download=0` to test search only.

### 9. Connect to Claude

Add as a custom connector, using this exact URL shape:

```
https://<deployment>/api/mcp?token=<MCP_AUTH_TOKEN>
```

The token has to be in the URL, not a header — the connector UI has no field
for custom headers, and if the URL is configured without any credential its
first request gets a 401, which the client reads as an invitation to attempt
OAuth sign-in ("couldn't register with mcp-libgen-kindle's sign-in service").
This server doesn't implement OAuth, so that always fails. Putting the token
in the URL means the very first request already authenticates, so no 401 is
ever produced and the OAuth attempt never triggers.

This is a real downgrade from a header: the token now sits in Vercel's access
logs, and leaks if the URL is ever pasted anywhere else. Treat the full URL,
not just the token, as something to keep private — if it needs to be rotated,
changing `MCP_AUTH_TOKEN` in Vercel and reconnecting the connector is enough.

## Local commands

```bash
npm run check      # validate all credentials, no side effects
npm run preview -- "of mice and men steinbeck"   # see what the model would see
npm run auth       # one-time Google consent flow
```

## Known limits

- **No delivery confirmation.** Amazon does not acknowledge personal document
  delivery. `send_to_kindle` can only report that the message was accepted by
  the mail server. If a book never appears, the approved-sender list is the
  first thing to check.
- **Mirrors rotate.** libgen domains get seized and move. `LIBGEN_MIRRORS` is
  a comma-separated list tried in order; update it when one dies. This is the
  most likely reason for this to stop working months from now.
- **50 MB attachment cap**, enforced before sending.
- **No language field.** Verified against the live API: neither `object=f` nor
  `object=e` returns a language, even though the HTML results table shows one.
  There is deliberately no language filter, because it would silently match
  nothing. The model infers language from title and author instead.
- **`fields=*` does nothing.** Tested against libgen.li. File records never
  carry titles, so the second `object=e` lookup is mandatory, not a fallback.
- **Broad queries are truncated.** A query like "dune frank herbert" matches
  2000 files. Resolving all of them would take twenty-plus sequential round
  trips and blow the function's time budget, so scanning stops early and the
  result table says so.
- **Metadata is sparse.** Edition records frequently have blank author, year,
  and publisher. Blank columns are dropped from the table, and title/author
  fall back to parsing the `locator` shelf path.
- Results routinely include study guides, omnibus editions, and abridgements
  alongside the actual book. Picking correctly is left to the model on purpose;
  it is not reliably decidable in code.

# Gmail Plugin

Send, read, and search Gmail messages via the Gmail REST API. This plugin is a
**reference implementation** showing how to build Co-Assistant plugins end-to-end.

## Features

| Tool             | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `search_emails`  | Search Gmail using the same query syntax as the Gmail UI |
| `read_email`     | Read the full content of an email by message ID          |
| `send_email`     | Compose and send a plain-text email                      |

## Getting Google OAuth2 Credentials

Follow these steps to obtain the credentials the plugin requires:

1. **Create a Google Cloud project**
   - Go to the [Google Cloud Console](https://console.cloud.google.com/).
   - Create a new project (or select an existing one).

2. **Configure the OAuth consent screen**
   - Navigate to **APIs & Services → OAuth consent screen**.
   - Set to "External" for personal use, add your email as a test user.

3. **Enable the Gmail API**
   - Navigate to **APIs & Services → Library**.
   - Search for "Gmail API" and click **Enable**.

4. **Create OAuth2 credentials**
   - Go to **APIs & Services → Credentials**.
   - Click **Create Credentials → OAuth client ID**.
   - Choose **Desktop app** as the application type (recommended — allows automatic localhost redirect).
   - Download the **client secret JSON file**.

5. **Run the setup wizard**
   ```bash
   npx tsx src/cli/index.ts setup --plugin gmail
   ```
   The setup will:
   - Ask for your downloaded JSON file path (extracts credentials, does not store the file)
   - Open your browser to authorize Gmail access
   - Capture the refresh token automatically via a local callback server

## Required Credentials

| Key                    | Description                    | Type    |
| ---------------------- | ------------------------------ | ------- |
| `GMAIL_CLIENT_ID`     | Google OAuth2 Client ID        | `oauth` |
| `GMAIL_CLIENT_SECRET`  | Google OAuth2 Client Secret    | `oauth` |
| `GMAIL_REFRESH_TOKEN`  | Google OAuth2 Refresh Token    | `oauth` |

Configure them via the CLI:

```bash
co-assistant plugin configure gmail
```

Or set them in `config.json` under `plugins.gmail.credentials`.

## Example Usage

Once configured, the AI assistant can use the tools naturally:

> **User:** Do I have any unread emails from Alice?
>
> The assistant calls `search_emails` with query `from:alice is:unread` and
> returns a summary of matching messages.

> **User:** Read message ID `18f1a2b3c4d5e6f7`
>
> The assistant calls `read_email` and returns the full subject, sender, date,
> and body text.

> **User:** Send an email to bob@example.com about tomorrow's meeting
>
> The assistant calls `send_email` with the recipient, a generated subject line,
> and the composed body text.

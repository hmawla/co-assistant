# Google Calendar Plugin

View, create, update, and delete Google Calendar events from your Co-Assistant bot.

## Features

| Tool | Description |
|------|-------------|
| `list_events` | List upcoming events with optional date-range filtering |
| `create_event` | Create a new calendar event with attendees and location |
| `update_event` | Update an existing event by ID |
| `delete_event` | Delete an event by ID |

## Setup

### 1. Create Google Cloud credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Configure the **OAuth consent screen** (APIs & Services → OAuth consent screen).
   - Set to "External" for personal use, add your email as a test user.
4. Navigate to **APIs & Services → Library** and enable the **Google Calendar API**.
5. Go to **APIs & Services → Credentials** and create an **OAuth 2.0 Client ID**.
   - Application type: **Desktop app** (recommended — allows automatic localhost redirect).
6. Download the **client secret JSON file**.

### 2. Run the setup wizard

```bash
npx tsx src/cli/index.ts setup --plugin google-calendar
```

The setup will:
- Ask for your downloaded JSON file path (extracts credentials, does not store the file)
- Open your browser to authorize Google Calendar access
- Capture the refresh token automatically via a local callback server

| Key | Description |
|-----|-------------|
| `GCAL_CLIENT_ID` | Google OAuth2 Client ID |
| `GCAL_CLIENT_SECRET` | Google OAuth2 Client Secret |
| `GCAL_REFRESH_TOKEN` | Google OAuth2 Refresh Token |

## Usage Examples

Once configured, the AI assistant can use natural language to manage your calendar:

- *"What's on my calendar today?"*
- *"Schedule a meeting with alice@example.com tomorrow at 2 PM for one hour."*
- *"Update event abc123 to start at 3 PM instead."*
- *"Delete the event with ID xyz789."*

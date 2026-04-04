/**
 * @module google-calendar/tools
 * @description Google Calendar AI tool definitions for listing, creating,
 * updating, and deleting calendar events via the Google Calendar v3 API.
 */

import type { ToolDefinition } from "../../src/plugins/types.js";
import type { CalendarAuth } from "./auth.js";

/** Base URL for the Google Calendar v3 REST API. */
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Google Calendar API.
 *
 * @returns The parsed JSON response body.
 */
async function calendarFetch(
  auth: CalendarAuth,
  path: string,
  options: RequestInit = {},
): Promise<unknown> {
  const token = await auth.getAccessToken();
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar API error (${res.status}): ${text}`);
  }

  // DELETE returns 204 No Content
  if (res.status === 204) return { success: true };
  return res.json();
}

/** Formats Google Calendar event datetime for display. */
function formatEventTime(dt: { dateTime?: string; date?: string }): string {
  if (dt.dateTime) {
    return new Date(dt.dateTime).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }
  if (dt.date) {
    return new Date(dt.date + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return "N/A";
}

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email: string; responseStatus?: string }[];
  htmlLink?: string;
  status?: string;
}

/** Build a concise, human-readable summary of a single event. */
function formatEvent(event: CalendarEvent): string {
  const lines: string[] = [];
  lines.push(`📅 ${event.summary ?? "(no title)"}`);
  if (event.start) lines.push(`   Start: ${formatEventTime(event.start)}`);
  if (event.end) lines.push(`   End:   ${formatEventTime(event.end)}`);
  if (event.location) lines.push(`   📍 ${event.location}`);
  if (event.description) lines.push(`   ${event.description}`);
  if (event.attendees?.length) {
    const emails = event.attendees.map((a) => a.email).join(", ");
    lines.push(`   👥 ${emails}`);
  }
  lines.push(`   ID: ${event.id}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Creates all Google Calendar tool definitions for the plugin.
 *
 * @param auth - An initialised {@link CalendarAuth} instance.
 */
export function createCalendarTools(auth: CalendarAuth): ToolDefinition[] {
  // -----------------------------------------------------------------------
  // list_events
  // -----------------------------------------------------------------------
  const listEvents: ToolDefinition = {
    name: "list_events",
    description:
      "List upcoming calendar events. Optionally filter by date range.",
    parameters: {
      type: "object",
      properties: {
        maxResults: {
          type: "number",
          description: "Maximum number of events to return (default 10).",
        },
        timeMin: {
          type: "string",
          description:
            "Start of the time range as an ISO 8601 date-time string. Defaults to now.",
        },
        timeMax: {
          type: "string",
          description:
            "End of the time range as an ISO 8601 date-time string.",
        },
        calendarId: {
          type: "string",
          description: 'Calendar ID to query (default "primary").',
        },
      },
    },
    handler: async (args) => {
      try {
        const calendarId = encodeURIComponent(
          (args.calendarId as string) ?? "primary",
        );
        const params = new URLSearchParams({
          maxResults: String((args.maxResults as number) ?? 10),
          timeMin: (args.timeMin as string) ?? new Date().toISOString(),
          orderBy: "startTime",
          singleEvents: "true",
        });
        if (args.timeMax) params.set("timeMax", args.timeMax as string);

        const data = (await calendarFetch(
          auth,
          `/calendars/${calendarId}/events?${params.toString()}`,
        )) as { items?: CalendarEvent[] };

        const events: CalendarEvent[] = data.items ?? [];
        if (events.length === 0) {
          return "No upcoming events found.";
        }

        return events.map(formatEvent).join("\n\n");
      } catch (error) {
        return `Error listing events: ${(error as Error).message}`;
      }
    },
  };

  // -----------------------------------------------------------------------
  // create_event
  // -----------------------------------------------------------------------
  const createEvent: ToolDefinition = {
    name: "create_event",
    description: "Create a new calendar event.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title." },
        description: { type: "string", description: "Event description." },
        startTime: {
          type: "string",
          description: "Start date-time in ISO 8601 format.",
        },
        endTime: {
          type: "string",
          description: "End date-time in ISO 8601 format.",
        },
        location: { type: "string", description: "Event location." },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "List of attendee email addresses.",
        },
        calendarId: {
          type: "string",
          description: 'Calendar ID (default "primary").',
        },
      },
      required: ["summary", "startTime", "endTime"],
    },
    handler: async (args) => {
      try {
        const calendarId = encodeURIComponent(
          (args.calendarId as string) ?? "primary",
        );

        const body: Record<string, unknown> = {
          summary: args.summary,
          start: { dateTime: args.startTime },
          end: { dateTime: args.endTime },
        };
        if (args.description) body.description = args.description;
        if (args.location) body.location = args.location;
        if (args.attendees) {
          body.attendees = (args.attendees as string[]).map((email) => ({
            email,
          }));
        }

        const event = (await calendarFetch(
          auth,
          `/calendars/${calendarId}/events`,
          { method: "POST", body: JSON.stringify(body) },
        )) as CalendarEvent;

        return `✅ Event created successfully!\n\n${formatEvent(event)}`;
      } catch (error) {
        return `Error creating event: ${(error as Error).message}`;
      }
    },
  };

  // -----------------------------------------------------------------------
  // update_event
  // -----------------------------------------------------------------------
  const updateEvent: ToolDefinition = {
    name: "update_event",
    description: "Update an existing calendar event by event ID.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID to update." },
        summary: { type: "string", description: "New event title." },
        description: { type: "string", description: "New event description." },
        startTime: {
          type: "string",
          description: "New start date-time in ISO 8601 format.",
        },
        endTime: {
          type: "string",
          description: "New end date-time in ISO 8601 format.",
        },
        location: { type: "string", description: "New event location." },
        calendarId: {
          type: "string",
          description: 'Calendar ID (default "primary").',
        },
      },
      required: ["eventId"],
    },
    handler: async (args) => {
      try {
        const calendarId = encodeURIComponent(
          (args.calendarId as string) ?? "primary",
        );
        const eventId = encodeURIComponent(args.eventId as string);

        const body: Record<string, unknown> = {};
        if (args.summary !== undefined) body.summary = args.summary;
        if (args.description !== undefined)
          body.description = args.description;
        if (args.startTime !== undefined)
          body.start = { dateTime: args.startTime };
        if (args.endTime !== undefined) body.end = { dateTime: args.endTime };
        if (args.location !== undefined) body.location = args.location;

        const event = (await calendarFetch(
          auth,
          `/calendars/${calendarId}/events/${eventId}`,
          { method: "PATCH", body: JSON.stringify(body) },
        )) as CalendarEvent;

        return `✅ Event updated successfully!\n\n${formatEvent(event)}`;
      } catch (error) {
        return `Error updating event: ${(error as Error).message}`;
      }
    },
  };

  // -----------------------------------------------------------------------
  // delete_event
  // -----------------------------------------------------------------------
  const deleteEvent: ToolDefinition = {
    name: "delete_event",
    description: "Delete a calendar event by event ID.",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "The event ID to delete." },
        calendarId: {
          type: "string",
          description: 'Calendar ID (default "primary").',
        },
      },
      required: ["eventId"],
    },
    handler: async (args) => {
      try {
        const calendarId = encodeURIComponent(
          (args.calendarId as string) ?? "primary",
        );
        const eventId = encodeURIComponent(args.eventId as string);

        await calendarFetch(
          auth,
          `/calendars/${calendarId}/events/${eventId}`,
          { method: "DELETE" },
        );

        return `✅ Event ${args.eventId} deleted successfully.`;
      } catch (error) {
        return `Error deleting event: ${(error as Error).message}`;
      }
    },
  };

  return [listEvents, createEvent, updateEvent, deleteEvent];
}

/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    lines.push(`Your destination is \`${d.name}\`${label}.`);
    lines.push('');
    lines.push(
      '**To reply, call the `send_message` tool with your text.** You can omit `to` — it goes to this destination automatically. Prefer the tool: a tool call is far harder to forget than remembering to wrap your final text.',
    );
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      lines.push(`- \`${d.name}\`${label}`);
    }
    lines.push('');
    lines.push(
      '**To reply, call the `send_message` tool** with `to` set to the destination name and your text. Prefer the tool: a tool call is far harder to forget than remembering to wrap your final text. When replying to an incoming message, default to the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute); pick a different one when the request asks for it (e.g., "tell Laura that…").',
    );
  }
  lines.push('');
  lines.push(
    '`send_message` can be called any number of times and at any point in a turn — each call lands as its own message, so a quick "on it" before a slow tool call and the final answer read as a sequence. **Put everything you want delivered into `send_message` calls.**',
  );
  lines.push('');
  lines.push(
    '**MCP priority — important:** if you call `send_message` at all this turn, that *is* your reply. Your final-turn text is then treated as private and is NOT delivered, so do not restate your answer there (it would otherwise be dropped — or, before this rule, sent twice). The `<message to="name">…</message>` wrapper in your final text is the fallback for when you did NOT call `send_message` at all; it delivers identically. Use `<internal>…</internal>` for thinking you never want sent.',
  );
  lines.push('');
  lines.push(
    'Bottom line: reply via `send_message` (preferred), OR wrap your final text in `<message>` — never rely on both for the same reply. Before you end a turn, confirm your reply actually went out one of those two ways.',
  );
  return lines.join('\n');
}

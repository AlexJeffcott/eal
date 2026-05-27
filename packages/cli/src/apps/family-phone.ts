import type { EalClient, FamilyPhoneDevice } from '@eal/client';
import type { CliMcpApp, EalMcpTool } from './types.ts';

/**
 * Family-phone MCP tools — the assistant's user-facing surface for
 * placing calls. When the user says "ring Mum" in a chat with the
 * assistant, Claude calls `place_call` here; the tool resolves the
 * contact, claims the agent's phone lock, and inserts a pending action.
 * The worker's scheduler tick picks the action up and drives the actual
 * `call:invite` over its own family-phone WS — the MCP child has no
 * direct WS to use, which is the whole reason the lock + action row
 * exist server-side.
 */

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function normaliseLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Resolve a contact label to a single device the agent may dial. The
 * agent's own device is filtered out (you can't call yourself), and an
 * ambiguous match — two devices share a label, which the schema does
 * not prevent today — surfaces a clear error so Claude can ask for a
 * disambiguator. The match is case-insensitive and ignores surrounding
 * whitespace, since the user typically speaks the label.
 */
export interface ResolvedFamilyPhoneContact {
  device: FamilyPhoneDevice;
}

export async function resolveFamilyPhoneContact(
  client: EalClient,
  rawLabel: string,
): Promise<ResolvedFamilyPhoneContact> {
  const wanted = normaliseLabel(rawLabel);
  if (wanted.length === 0) throw new Error('contact label cannot be empty');
  const devices = await client.listFamilyPhoneDevices();
  const matches = devices.filter(
    (d) => d.kind !== 'agent' && normaliseLabel(d.label) === wanted,
  );
  if (matches.length === 0) {
    throw new Error(`no household contact matches "${rawLabel}"`);
  }
  if (matches.length > 1) {
    const owners = matches.map((m) => m.ownerDisplayName).join(', ');
    throw new Error(
      `"${rawLabel}" is ambiguous (matches devices owned by ${owners}); reword to a unique label`,
    );
  }
  const device = matches[0];
  if (device === undefined) {
    throw new Error('resolveFamilyPhoneContact: unreachable empty match');
  }
  return { device };
}

const TOOLS: EalMcpTool[] = [
  {
    name: 'place_call',
    description:
      'Place a family-phone call from the assistant to a household contact. ' +
      'Use only when the user explicitly asks the assistant to ring someone. ' +
      'Returns immediately after the call is queued; the assistant cannot '
      + 'observe whether the recipient answered.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: {
          type: 'string',
          description:
            'The device label to ring, e.g. "Leo handset". Matched case-insensitively.',
        },
      },
      required: ['contact'],
    },
    run: async (client, args) => {
      const contact = requireString(args, 'contact');
      const { device } = await resolveFamilyPhoneContact(client, contact);
      const action = await client.createAgentPlaceCallAction({
        targetDeviceId: device.id,
        trigger: 'tool',
      });
      if (action === null) {
        return `Cannot ring ${device.label} — the assistant is already on a call.`;
      }
      return `Ringing ${device.label} (action #${action.id}).`;
    },
  },
];

export const familyPhoneMcpApp: CliMcpApp = {
  id: 'family-phone',
  tools: TOOLS,
};

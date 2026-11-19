// The comment left on a merge request when somebody approves (or revokes) from Microsoft Teams.
// The approval itself is made by the bot's GitLab account, so GitLab alone would not say who asked.
// Pure functions: data in, markdown out.

import { isIP } from 'node:net';
import { teamsMessageLink } from './message-links.mjs';

const MRI = /8:orgid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Link that opens a Teams chat with a person, from their MRI (also found inside a longer contact URL); '' when unknown. */
export function teamsUserLink(mri) {
  const match = String(mri ?? '').match(MRI);
  return match ? `https://teams.microsoft.com/l/chat/0/0?users=${match[0]}` : '';
}

const clean = (value) => String(value ?? '').replace(/[@\r\n`*_[\]<>]/g, '').trim();

/**
 * @param {object} p
 * @param {'approved'|'revoked'} [p.action]
 * @param {{name?: string, gitlabUser?: string, mri?: string}} [p.requester] who asked, as far as known
 * @param {string} [p.requesterNote] replaces the requester when no person is known ("the card's Approve link ...")
 * @param {string} p.trigger  how: '/approve', '/approve all', '/revoke', '👍 reaction' or 'button'
 * @param {{conversationId?: string, messageId?: string}} [p.message] the Teams message that triggered it (for the
 *   Approve button: the card that carries the button)
 * @param {string} [p.ip] the address the request came from, when it is known (the button's web page)
 * @param {string} [p.place] where that address is, as text (see geoip.mjs formatPlace), when it is known
 */
export function buildApprovalNote({ action = 'approved', requester = {}, requesterNote = '', trigger, message = {}, ip = '', place = '' }) {
  const revoked = action === 'revoked';
  const title = revoked ? 'Approval revoked via Microsoft Teams' : 'Approved via Microsoft Teams';

  const name = clean(requester.name) || 'someone';
  const chat = teamsUserLink(requester.mri);
  const person = chat ? `[🗨️ ${name}](${chat})` : `**${name}**`;
  const gitlabUser = /^[A-Za-z0-9_.-]+$/.test(requester.gitlabUser || '') ? requester.gitlabUser : '';
  const by = requesterNote || (gitlabUser ? `@${gitlabUser} (${person})` : person);

  const link = teamsMessageLink(message.conversationId, message.messageId);
  const where = link ? ` on [this Teams message](${link})` : '';
  let how;
  if (trigger === 'button') how = link ? `Approve button on [this Teams card](${link})` : 'Approve button on a Teams card';
  else if (trigger.startsWith('/')) how = `Command \`${trigger}\`${link ? ` in [this Teams message](${link})` : ''}`;
  else how = `${trigger}${where}`;

  return [
    `**${title}**`,
    '',
    `- **Requested by:** ${by}`,
    `- **Trigger:** ${how}`,
    ...(isIP(String(ip || '')) ? [`- **IP address:** \`${ip}\`${place ? ` · ${clean(place)}` : ''}`] : []),
    '',
    `_The ${revoked ? 'approval was withdrawn' : 'approval was submitted'} by the MS Teams bot on the requester's behalf._`,
  ].join('\n');
}

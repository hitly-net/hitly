import { SITE_URL } from '@/lib/site'

/**
 * Plain-text guide for AI agents (served at /agents.md and /agents.txt).
 * Keep this factual: the MCP endpoint, auth, the tool surface, and links.
 */
export function buildAgentsMarkdown(): string {
  return [
    '# HITLy — guide for AI agents',
    '',
    'HITLy is a human-in-the-loop approval inbox for agent work (Apache-2.0, self-hostable).',
    'Origin frameworks (Mastra, Hermes, HTTP, LangGraph, Temporal) pause their run;',
    'human reviewers decide in the HITLy inbox; the plugin adapter resumes the run.',
    'Agents never decide — approvals belong to humans.',
    '',
    '## MCP server',
    '',
    `- Endpoint: \`https://mcp.hitly.net/mcp\``,
    '- Auth: `Authorization: Bearer <project API key>` — mint a project API key in the',
    '  HITLy web app under project settings.',
    '',
    '## Tools',
    '',
    '- `request_approval` — submit an approval request for a human decision.',
    '- `ask_user` — ask the reviewer a question and return their answer.',
    '- `get_decision` — poll the outcome of a previously submitted request.',
    '- `list_pending` — list the still-open requests created with the same project API key (requester scope; not the whole project).',
    '- `cancel` — withdraw an open request the same key created.',
    '',
    'There is intentionally **no decide tool**: agents cannot approve or reject their',
    'own work. Decisions are made only by human reviewers in the HITLy inbox.',
    '',
    '## Links',
    '',
    `- MCP docs: [${SITE_URL}/docs/mcp](${SITE_URL}/docs/mcp)`,
    `- Docs index for agents: [${SITE_URL}/llms.txt](${SITE_URL}/llms.txt)`,
    `- Full docs for agents: [${SITE_URL}/llms-full.txt](${SITE_URL}/llms-full.txt)`,
    '',
  ].join('\n')
}

#!/usr/bin/env node
/*
 Mission Control MCP Server (stdio transport)
 - Zero dependencies (Node.js built-ins only)
 - JSON-RPC 2.0 over stdin/stdout
 - Wraps Mission Control REST API as MCP tools
 - Add with: claude mcp add mission-control -- node /path/to/mc-mcp-server.cjs

 Environment:
   MC_URL       Base URL (default: http://127.0.0.1:3000)
   MC_API_KEY   API key for auth
   MC_COOKIE    Session cookie (alternative auth)
*/

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  // Try profile first, then env vars
  const profilePath = path.join(os.homedir(), '.mission-control', 'profiles', 'default.json');
  let profile = {};
  try {
    profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  } catch { /* no profile */ }

  return {
    baseUrl: (process.env.MC_URL || profile.url || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    apiKey: process.env.MC_API_KEY || profile.apiKey || '',
    cookie: process.env.MC_COOKIE || profile.cookie || '',
  };
}

// ---------------------------------------------------------------------------
// HTTP client (same pattern as mc-cli.cjs)
// ---------------------------------------------------------------------------

async function api(method, route, body) {
  const config = loadConfig();
  const headers = { 'Accept': 'application/json' };
  if (config.apiKey) headers['x-api-key'] = config.apiKey;
  if (config.cookie) headers['Cookie'] = config.cookie;

  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const url = `${config.baseUrl}${route.startsWith('/') ? route : `/${route}`}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}: ${text.slice(0, 200)}`);
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new Error('Request timeout (30s)');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Shared primitives (used by multiple MCP tools)
// ---------------------------------------------------------------------------

async function controlSession(id, action) {
  return api('POST', `/api/sessions/${id}/control`, { action });
}

async function listKnowledgeFiles({ path, depth } = {}) {
  const params = new URLSearchParams({ action: 'tree' });
  if (path) params.set('path', path);
  if (depth !== undefined) params.set('depth', String(depth));
  return api('GET', `/api/memory?${params}`);
}

async function fetchKnowledgeLinkGraph({ file } = {}) {
  const qs = file ? `?file=${encodeURIComponent(file)}` : '';
  return api('GET', `/api/memory/links${qs}`);
}

async function fetchKnowledgeContext() {
  return api('GET', '/api/memory/context');
}

async function fetchKnowledgeHealth() {
  return api('GET', '/api/memory/health');
}

async function runKnowledgeProcess(action) {
  return api('POST', '/api/memory/process', { action });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // --- Agents ---
  {
    name: 'mc_list_agents',
    description: 'List all agents registered in Mission Control',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/agents'),
  },
  {
    name: 'mc_get_agent',
    description: 'Get details of a specific agent by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('GET', `/api/agents/${id}`),
  },
  {
    name: 'mc_heartbeat',
    description: 'Send a heartbeat for an agent to indicate it is alive',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('POST', `/api/agents/${id}/heartbeat`),
  },
  {
    name: 'mc_wake_agent',
    description: 'Wake a sleeping agent',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('POST', `/api/agents/${id}/wake`),
  },
  {
    name: 'mc_agent_diagnostics',
    description: 'Get diagnostics info for an agent (health, config, recent activity)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('GET', `/api/agents/${id}/diagnostics`),
  },
  {
    name: 'mc_agent_attribution',
    description: 'Get cost attribution, audit trail, and mutation history for an agent',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Agent ID' },
        hours: { type: 'number', description: 'Lookback window in hours (default 24)' },
        section: { type: 'string', description: 'Comma-separated sections: identity,audit,mutations,cost' },
      },
      required: ['id'],
    },
    handler: async ({ id, hours, section }) => {
      let qs = `?hours=${hours || 24}`;
      if (section) qs += `&section=${encodeURIComponent(section)}`;
      return api('GET', `/api/agents/${id}/attribution${qs}`);
    },
  },
  {
    name: 'mc_create_agent',
    description: 'Create a new agent in Mission Control',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name (required)' },
        role: { type: 'string', description: 'Agent role (required unless template is set)' },
        template: { type: 'string', description: 'Agent template name to apply' },
        status: { type: 'string', description: 'Initial status: online, offline, busy, idle, error' },
        session_key: { type: 'string', description: 'Session key identifier' },
        soul_content: { type: 'string', description: 'Initial SOUL content' },
        runtime_type: { type: 'string', description: 'Runtime: hermes, openclaw, claude, codex, custom' },
        config: { type: 'object', description: 'Agent config object' },
        gateway_config: { type: 'object', description: 'OpenClaw gateway config fields' },
        write_to_gateway: { type: 'boolean', description: 'Write config to gateway after create' },
        provision_openclaw_workspace: { type: 'boolean', description: 'Provision OpenClaw workspace on create' },
      },
      required: ['name'],
    },
    handler: async (args) => api('POST', '/api/agents', args),
  },
  {
    name: 'mc_update_agent',
    description: 'Update an agent by ID or name (role, gateway_config, write_to_gateway)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Agent ID or name' },
        role: { type: 'string', description: 'New role' },
        gateway_config: { type: 'object', description: 'OpenClaw gateway config fields to merge' },
        write_to_gateway: { type: 'boolean', description: 'Write gateway_config to gateway file' },
      },
      required: ['id'],
    },
    handler: async ({ id, ...fields }) => api('PUT', `/api/agents/${id}`, fields),
  },
  {
    name: 'mc_delete_agent',
    description: 'Delete an agent by ID or name (admin role required)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Agent ID or name' },
        remove_workspace: { type: 'boolean', description: 'Also remove OpenClaw agent workspace (destructive)' },
      },
      required: ['id'],
    },
    handler: async ({ id, remove_workspace }) => {
      const body = remove_workspace ? { remove_workspace: true } : undefined;
      return api('DELETE', `/api/agents/${id}`, body);
    },
  },

  // --- Agent Memory ---
  {
    name: 'mc_read_memory',
    description: 'Read an agent\'s working memory',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('GET', `/api/agents/${id}/memory`),
  },
  {
    name: 'mc_write_memory',
    description: 'Write or append to an agent\'s working memory',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Agent ID' },
        working_memory: { type: 'string', description: 'Memory content to write' },
        append: { type: 'boolean', description: 'Append to existing memory instead of replacing (default false)' },
      },
      required: ['id', 'working_memory'],
    },
    handler: async ({ id, working_memory, append }) =>
      api('PUT', `/api/agents/${id}/memory`, { working_memory, append: append || false }),
  },
  {
    name: 'mc_clear_memory',
    description: 'Clear an agent\'s working memory',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('DELETE', `/api/agents/${id}/memory`),
  },

  // --- Knowledge Base (filesystem memory) ---
  {
    name: 'mc_search_knowledge',
    description: 'Full-text search across the knowledge base (memory files). Uses FTS5 with BM25 ranking. Supports operators: AND, OR, NOT, NEAR, "exact phrase", prefix*. Auto-builds index on first search.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query (supports FTS5 syntax)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
      required: ['q'],
    },
    handler: async ({ q, limit }) => {
      const params = new URLSearchParams({ q });
      if (limit) params.set('limit', String(limit));
      return api('GET', `/api/memory/search?${params}`);
    },
  },
  {
    name: 'mc_read_knowledge_file',
    description: 'Read a file from the knowledge base (memory filesystem). Returns content, wiki-links, and schema validation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path (e.g., "memory/projects/my-project.md")' },
      },
      required: ['path'],
    },
    handler: async ({ path }) => api('GET', `/api/memory?action=content&path=${encodeURIComponent(path)}`),
  },
  {
    name: 'mc_write_knowledge_file',
    description: 'Create or update a file in the knowledge base. Use for saving decisions, project notes, lessons learned.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path (e.g., "memory/decisions/auth-strategy.md")' },
        content: { type: 'string', description: 'File content (markdown)' },
        create: { type: 'boolean', description: 'If true, create new file (fails if exists). If false/omitted, overwrite existing.' },
      },
      required: ['path', 'content'],
    },
    handler: async ({ path, content, create }) =>
      api('POST', '/api/memory', { action: create ? 'create' : 'save', path, content }),
  },
  {
    name: 'mc_list_knowledge_files',
    description: 'List knowledge base files and directories with metadata (path, name, type, size, modified). Raw primitive — use this to inspect structure before applying judgment in prompts.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Subdirectory to list (omit for full tree)' },
        depth: { type: 'number', description: 'Max directory depth (0-8, default unlimited)' },
      },
      required: [],
    },
    handler: async (args) => listKnowledgeFiles(args),
  },
  {
    name: 'mc_knowledge_link_graph',
    description: 'Read the wiki-link graph: all nodes with incoming/outgoing links and orphans, or per-file links when file is set. Raw primitive — interpret connectivity in prompts, not via analysis tools.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional file path for per-file wiki-links and backlinks' },
      },
      required: [],
    },
    handler: async (args) => fetchKnowledgeLinkGraph(args),
  },
  {
    name: 'mc_knowledge_context',
    description: 'Read raw workspace context payload: file tree, recent files, health summary, and maintenance signals. No scoring judgment — use prompts to interpret.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => fetchKnowledgeContext(),
  },
  {
    name: 'mc_knowledge_health',
    description: '[Analysis helper] Pre-computed health scores (schema, links, freshness, etc.). Prefer mc_list_knowledge_files + mc_knowledge_link_graph for raw data; apply judgment in prompts/skills.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => fetchKnowledgeHealth(),
  },
  {
    name: 'mc_rebuild_search_index',
    description: 'Rebuild the full-text search index from all knowledge base files. Use after bulk imports or if search results seem stale.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('POST', '/api/memory/search', { action: 'rebuild' }),
  },
  {
    name: 'mc_knowledge_gaps',
    description: '[Analysis helper] Pre-computed gap detection (broken links, orphans, stale content). Prefer mc_knowledge_link_graph + mc_list_knowledge_files for raw data; apply judgment in prompts/skills.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => runKnowledgeProcess('gap-detect'),
  },
  {
    name: 'mc_knowledge_consolidate',
    description: '[Analysis helper] Pre-computed graph analysis (hubs, bridges, clusters). Prefer mc_knowledge_link_graph for raw connectivity; apply judgment in prompts/skills.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => runKnowledgeProcess('consolidate'),
  },

  // --- Agent Soul ---
  {
    name: 'mc_read_soul',
    description: 'Read an agent\'s SOUL (System of Unified Logic) content — the agent\'s identity and behavioral directives',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Agent ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('GET', `/api/agents/${id}/soul`),
  },
  {
    name: 'mc_write_soul',
    description: 'Write an agent\'s SOUL content, or apply a named template',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Agent ID' },
        soul_content: { type: 'string', description: 'SOUL content to write (omit if using template_name)' },
        template_name: { type: 'string', description: 'Name of a SOUL template to apply (omit if providing soul_content)' },
      },
      required: ['id'],
    },
    handler: async ({ id, soul_content, template_name }) => {
      const body = {};
      if (template_name) body.template_name = template_name;
      else if (soul_content) body.soul_content = soul_content;
      return api('PUT', `/api/agents/${id}/soul`, body);
    },
  },
  {
    name: 'mc_list_soul_templates',
    description: 'List available SOUL templates, or retrieve a specific template\'s content',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Agent ID' },
        template: { type: 'string', description: 'Template name to retrieve (omit to list all)' },
      },
      required: ['id'],
    },
    handler: async ({ id, template }) => {
      const qs = template ? `?template=${encodeURIComponent(template)}` : '';
      return api('PATCH', `/api/agents/${id}/soul${qs}`);
    },
  },

  // --- Tasks ---
  {
    name: 'mc_list_tasks',
    description: 'List tasks in Mission Control with optional filters',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: backlog, inbox, assigned, awaiting_owner, in_progress, review, quality_review, done, failed' },
        assigned_to: { type: 'string', description: 'Filter by assigned agent name' },
        priority: { type: 'string', description: 'Filter by priority: low, medium, high, critical' },
        search: { type: 'string', description: 'Search in task title (partial match)' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
      required: [],
    },
    handler: async ({ status, assigned_to, priority, search, limit } = {}) => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (assigned_to) params.set('assigned_to', assigned_to)
      if (priority) params.set('priority', priority)
      if (limit) params.set('limit', String(Math.min(limit, 200)))
      const qs = params.toString() ? `?${params.toString()}` : ''
      const result = await api('GET', `/api/tasks${qs}`)
      if (search && result?.tasks) {
        const term = search.toLowerCase()
        result.tasks = result.tasks.filter(t => t.title?.toLowerCase().includes(term))
      }
      return result
    },
  },
  {
    name: 'mc_get_task',
    description: 'Get a specific task by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Task ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('GET', `/api/tasks/${id}`),
  },
  {
    name: 'mc_create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        priority: { type: 'string', description: 'Priority: low, medium, high, critical' },
        assigned_to: { type: 'string', description: 'Agent name to assign to' },
      },
      required: ['title'],
    },
    handler: async (args) => api('POST', '/api/tasks', args),
  },
  {
    name: 'mc_update_task',
    description: 'Update an existing task (status, priority, assigned_to, title, description, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Task ID' },
        status: { type: 'string', description: 'New status' },
        priority: { type: 'string', description: 'New priority' },
        assigned_to: { type: 'string', description: 'New assignee agent name' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
      },
      required: ['id'],
    },
    handler: async ({ id, ...fields }) => api('PUT', `/api/tasks/${id}`, fields),
  },
  {
    name: 'mc_delete_task',
    description: 'Delete a task by ID',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Task ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('DELETE', `/api/tasks/${id}`),
  },
  {
    name: 'mc_poll_task_queue',
    description: 'Poll the task queue for an agent — returns the next available task(s) to work on',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name to poll for' },
        max_capacity: { type: 'number', description: 'Max tasks to return (default 1)' },
      },
      required: ['agent'],
    },
    handler: async ({ agent, max_capacity }) => {
      let qs = `?agent=${encodeURIComponent(agent)}`;
      if (max_capacity) qs += `&max_capacity=${max_capacity}`;
      return api('GET', `/api/tasks/queue${qs}`);
    },
  },
  {
    name: 'mc_broadcast_task',
    description: 'Broadcast a message to all subscribers of a task',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Task ID' },
        message: { type: 'string', description: 'Message to broadcast' },
      },
      required: ['id', 'message'],
    },
    handler: async ({ id, message }) => api('POST', `/api/tasks/${id}/broadcast`, { message }),
  },

  // --- Task Comments ---
  {
    name: 'mc_list_comments',
    description: 'List comments on a task',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'], description: 'Task ID' } },
      required: ['id'],
    },
    handler: async ({ id }) => api('GET', `/api/tasks/${id}/comments`),
  },
  {
    name: 'mc_add_comment',
    description: 'Add a comment to a task',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'], description: 'Task ID' },
        content: { type: 'string', description: 'Comment text (supports @mentions)' },
        parent_id: { type: 'number', description: 'Parent comment ID for threaded replies' },
      },
      required: ['id', 'content'],
    },
    handler: async ({ id, content, parent_id }) => {
      const body = { content };
      if (parent_id) body.parent_id = parent_id;
      return api('POST', `/api/tasks/${id}/comments`, body);
    },
  },

  // --- Sessions ---
  {
    name: 'mc_list_sessions',
    description: 'List all active sessions',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/sessions'),
  },
  {
    name: 'mc_pause_session',
    description: 'Pause an active session',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
      },
      required: ['id'],
    },
    handler: async ({ id }) => controlSession(id, 'pause'),
  },
  {
    name: 'mc_terminate_session',
    description: 'Terminate an active session',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
      },
      required: ['id'],
    },
    handler: async ({ id }) => controlSession(id, 'terminate'),
  },
  {
    name: 'mc_control_session',
    description: '[Deprecated] Use mc_pause_session, mc_terminate_session, mc_list_sessions, or mc_session_transcript. Shim for compatibility — delegates pause/terminate/monitor to the control API.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID' },
        action: { type: 'string', description: 'Action: monitor, pause, or terminate' },
      },
      required: ['id', 'action'],
    },
    handler: async ({ id, action }) => {
      const allowed = ['monitor', 'pause', 'terminate'];
      if (!allowed.includes(action)) {
        throw new Error(`Invalid action: ${action}. Must be: ${allowed.join(', ')}`);
      }
      return controlSession(id, action);
    },
  },
  {
    name: 'mc_continue_session',
    description: 'Send a follow-up prompt to an existing session',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Session kind: claude-code, codex-cli, hermes' },
        id: { type: 'string', description: 'Session ID' },
        prompt: { type: 'string', description: 'Follow-up prompt to send' },
      },
      required: ['kind', 'id', 'prompt'],
    },
    handler: async ({ kind, id, prompt }) =>
      api('POST', '/api/sessions/continue', { kind, id, prompt }),
  },
  {
    name: 'mc_session_transcript',
    description: 'Get the transcript of a session (messages, tool calls, reasoning)',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Session kind: claude-code, codex-cli, hermes' },
        id: { type: 'string', description: 'Session ID' },
        limit: { type: 'number', description: 'Max messages to return (default 40, max 200)' },
      },
      required: ['kind', 'id'],
    },
    handler: async ({ kind, id, limit }) => {
      let qs = `?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`;
      if (limit) qs += `&limit=${limit}`;
      return api('GET', `/api/sessions/transcript${qs}`);
    },
  },

  // --- Connections ---
  {
    name: 'mc_list_connections',
    description: 'List active agent connections (tool registrations)',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/connect'),
  },
  {
    name: 'mc_register_connection',
    description: 'Register a tool connection for an agent',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Tool name to register' },
        agent_name: { type: 'string', description: 'Agent name to connect' },
      },
      required: ['tool_name', 'agent_name'],
    },
    handler: async (args) => api('POST', '/api/connect', args),
  },

  // --- Tokens & Costs ---
  {
    name: 'mc_token_stats',
    description: 'Get aggregate token usage statistics (total tokens, cost, request count, per-model breakdown)',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'Timeframe: hour, day, week, month, all (default: all)' },
      },
      required: [],
    },
    handler: async ({ timeframe }) => {
      let qs = '?action=stats';
      if (timeframe) qs += `&timeframe=${encodeURIComponent(timeframe)}`;
      return api('GET', `/api/tokens${qs}`);
    },
  },
  {
    name: 'mc_agent_costs',
    description: 'Get per-agent cost breakdown with timeline and model details',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'Timeframe: hour, day, week, month, all' },
      },
      required: [],
    },
    handler: async ({ timeframe }) => {
      let qs = '?action=agent-costs';
      if (timeframe) qs += `&timeframe=${encodeURIComponent(timeframe)}`;
      return api('GET', `/api/tokens${qs}`);
    },
  },
  {
    name: 'mc_costs_by_agent',
    description: 'Get per-agent cost summary over a number of days',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Lookback in days (default 30, max 365)' },
      },
      required: [],
    },
    handler: async ({ days }) =>
      api('GET', `/api/tokens/by-agent?days=${days || 30}`),
  },
  {
    name: 'mc_list_tokens',
    description: 'List recent token usage records with optional timeframe filter',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'Timeframe: hour, day, week, month, all (default: all)' },
      },
      required: [],
    },
    handler: async ({ timeframe }) => {
      let qs = '?action=list';
      if (timeframe) qs += `&timeframe=${encodeURIComponent(timeframe)}`;
      return api('GET', `/api/tokens${qs}`);
    },
  },
  {
    name: 'mc_task_costs',
    description: 'Get per-task cost breakdown with attribution metadata',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'Timeframe: hour, day, week, month, all' },
      },
      required: [],
    },
    handler: async ({ timeframe }) => {
      let qs = '?action=task-costs';
      if (timeframe) qs += `&timeframe=${encodeURIComponent(timeframe)}`;
      return api('GET', `/api/tokens${qs}`);
    },
  },
  {
    name: 'mc_token_trends',
    description: 'Get hourly token usage trends for the last 24 hours',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'Timeframe filter applied before trend aggregation' },
      },
      required: [],
    },
    handler: async ({ timeframe }) => {
      let qs = '?action=trends';
      if (timeframe) qs += `&timeframe=${encodeURIComponent(timeframe)}`;
      return api('GET', `/api/tokens${qs}`);
    },
  },
  {
    name: 'mc_token_export',
    description: 'Export token usage data as JSON or CSV',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: { type: 'string', description: 'Timeframe: hour, day, week, month, all' },
        format: { type: 'string', description: 'Export format: json or csv (default json)' },
        limit: { type: 'number', description: 'Max records to include' },
      },
      required: [],
    },
    handler: async ({ timeframe, format, limit }) => {
      const params = new URLSearchParams({ action: 'export', format: format || 'json' });
      if (timeframe) params.set('timeframe', timeframe);
      if (limit) params.set('limit', String(limit));
      return api('GET', `/api/tokens?${params}`);
    },
  },
  {
    name: 'mc_token_rotate_info',
    description: 'Get metadata about the current API key (masked). Does not rotate the key.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/tokens/rotate'),
  },

  // --- Skills ---
  {
    name: 'mc_list_skills',
    description: 'List all skills available in the system',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/skills'),
  },
  {
    name: 'mc_read_skill',
    description: 'Read the content of a specific skill',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Skill source (e.g. workspace, system)' },
        name: { type: 'string', description: 'Skill name' },
      },
      required: ['source', 'name'],
    },
    handler: async ({ source, name }) =>
      api('GET', `/api/skills?mode=content&source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`),
  },
  {
    name: 'mc_upsert_skill',
    description: 'Create or update a skill SKILL.md by source and name',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Skill source (e.g. project-agents, user-codex)' },
        name: { type: 'string', description: 'Skill directory name' },
        content: { type: 'string', description: 'Full SKILL.md content' },
      },
      required: ['source', 'name', 'content'],
    },
    handler: async ({ source, name, content }) =>
      api('PUT', '/api/skills', { source, name, content }),
  },
  {
    name: 'mc_delete_skill',
    description: 'Delete a skill by source and name',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Skill source' },
        name: { type: 'string', description: 'Skill directory name' },
      },
      required: ['source', 'name'],
    },
    handler: async ({ source, name }) =>
      api('DELETE', `/api/skills?source=${encodeURIComponent(source)}&name=${encodeURIComponent(name)}`),
  },

  // --- Cron ---
  {
    name: 'mc_list_cron',
    description: 'List all cron jobs',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/cron?action=list'),
  },
  {
    name: 'mc_create_cron',
    description: 'Create a cron job (OpenClaw agentTurn schedule)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name (required)' },
        schedule: { type: 'string', description: 'Cron expression (required)' },
        command: { type: 'string', description: 'Agent message/payload to run (required)' },
        model: { type: 'string', description: 'Optional model override' },
        description: { type: 'string', description: 'Optional description' },
        stagger_seconds: { type: 'number', description: 'Optional schedule stagger in seconds' },
      },
      required: ['name', 'schedule', 'command'],
    },
    handler: async ({ name, schedule, command, model, description, stagger_seconds }) => {
      const body = { action: 'add', jobName: name, name, schedule, command };
      if (model) body.model = model;
      if (description) body.description = description;
      if (stagger_seconds !== undefined) body.staggerSeconds = stagger_seconds;
      return api('POST', '/api/cron', body);
    },
  },
  {
    name: 'mc_update_cron',
    description: 'Update a cron job by replacing the job with the same name (API add action)',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Existing job name to replace (required)' },
        schedule: { type: 'string', description: 'New cron expression (required)' },
        command: { type: 'string', description: 'New agent message/payload (required)' },
        model: { type: 'string', description: 'Optional model override' },
        description: { type: 'string', description: 'Optional description' },
        stagger_seconds: { type: 'number', description: 'Optional schedule stagger in seconds' },
      },
      required: ['name', 'schedule', 'command'],
    },
    handler: async ({ name, schedule, command, model, description, stagger_seconds }) => {
      const body = { action: 'add', jobName: name, name, schedule, command };
      if (model) body.model = model;
      if (description) body.description = description;
      if (stagger_seconds !== undefined) body.staggerSeconds = stagger_seconds;
      return api('POST', '/api/cron', body);
    },
  },
  {
    name: 'mc_pause_cron',
    description: 'Toggle cron job off via POST action=toggle. API has no idempotent pause — call mc_list_cron first to verify state.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Cron job ID' },
        job_name: { type: 'string', description: 'Cron job name (alternative to job_id)' },
      },
      required: [],
    },
    handler: async ({ job_id, job_name }) => {
      const id = job_id || job_name;
      if (!id) throw new Error('job_id or job_name is required');
      return api('POST', '/api/cron', { action: 'toggle', jobId: id, jobName: id });
    },
  },
  {
    name: 'mc_resume_cron',
    description: 'Toggle cron job on via POST action=toggle. API has no idempotent resume — call mc_list_cron first to verify state.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Cron job ID' },
        job_name: { type: 'string', description: 'Cron job name (alternative to job_id)' },
      },
      required: [],
    },
    handler: async ({ job_id, job_name }) => {
      const id = job_id || job_name;
      if (!id) throw new Error('job_id or job_name is required');
      return api('POST', '/api/cron', { action: 'toggle', jobId: id, jobName: id });
    },
  },
  {
    name: 'mc_remove_cron',
    description: 'Remove a cron job permanently',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Cron job ID' },
        job_name: { type: 'string', description: 'Cron job name (alternative to job_id)' },
      },
      required: [],
    },
    handler: async ({ job_id, job_name }) => {
      const id = job_id || job_name;
      if (!id) throw new Error('job_id or job_name is required');
      return api('POST', '/api/cron', { action: 'remove', jobId: id, jobName: id });
    },
  },
  {
    name: 'mc_run_cron',
    description: 'Manually trigger a cron job run (requires MISSION_CONTROL_ALLOW_COMMAND_TRIGGER=1 on server)',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Cron job ID' },
        job_name: { type: 'string', description: 'Cron job name (alternative to job_id)' },
        mode: { type: 'string', description: 'Trigger mode: force (default) or due' },
      },
      required: [],
    },
    handler: async ({ job_id, job_name, mode }) => {
      const id = job_id || job_name;
      if (!id) throw new Error('job_id or job_name is required');
      const body = { action: 'trigger', jobId: id, jobName: id };
      if (mode) body.mode = mode;
      return api('POST', '/api/cron', body);
    },
  },

  // --- Status ---
  {
    name: 'mc_health',
    description: 'Check Mission Control health status (no auth required)',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/status?action=health'),
  },
  {
    name: 'mc_dashboard',
    description: 'Get a dashboard summary of the entire Mission Control system (agents, tasks, sessions, costs)',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/status?action=dashboard'),
  },
  {
    name: 'mc_status',
    description: 'Get system status overview (uptime, memory, disk, sessions, processes)',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => api('GET', '/api/status?action=overview'),
  },

  // --- Runs (agent-run protocol) ---
  {
    name: 'mc_list_runs',
    description: 'List agent runs with optional filtering by agent, status, or time range',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Filter by agent ID' },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'timeout'] },
        since: { type: 'string', description: 'ISO 8601 timestamp — only runs after this time' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
      required: [],
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.agent_id) params.set('agent_id', args.agent_id);
      if (args.status) params.set('status', args.status);
      if (args.since) params.set('since', args.since);
      if (args.limit) params.set('limit', String(args.limit));
      return api('GET', `/api/v1/runs?${params}`);
    },
  },
  {
    name: 'mc_get_run',
    description: 'Get a single agent run by ID, including steps, cost, provenance, and eval',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'Run ID' } },
      required: ['run_id'],
    },
    handler: async (args) => api('GET', `/api/v1/runs/${encodeURIComponent(args.run_id)}`),
  },
  {
    name: 'mc_create_run',
    description: 'Report a new agent run to Mission Control (agent-run protocol)',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent identifier' },
        agent_name: { type: 'string', description: 'Human-readable agent name' },
        model: { type: 'string', description: 'Model used (e.g. claude-sonnet-4-5-20250514)' },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
        trigger: { type: 'string', enum: ['manual', 'cron', 'webhook', 'agent', 'pipeline', 'queue'] },
        task_id: { type: 'string', description: 'Associated task ID' },
        started_at: { type: 'string', description: 'ISO 8601 start time' },
      },
      required: ['agent_id', 'status', 'started_at'],
    },
    handler: async (args) => api('POST', '/api/v1/runs', args),
  },
  {
    name: 'mc_update_run',
    description: 'Update a run (status, outcome, cost, error)',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run ID to update' },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled'] },
        outcome: { type: 'string', enum: ['success', 'failed', 'partial', 'abandoned'] },
        ended_at: { type: 'string', description: 'ISO 8601 end time' },
        duration_ms: { type: 'number' },
        error: { type: 'string' },
      },
      required: ['run_id'],
    },
    handler: async (args) => {
      const { run_id, ...updates } = args;
      return api('PATCH', `/api/v1/runs/${encodeURIComponent(run_id)}`, updates);
    },
  },
  {
    name: 'mc_run_provenance',
    description: 'Get the provenance (hash chain, model version, config hash) for a run',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      required: ['run_id'],
    },
    handler: async (args) => api('GET', `/api/v1/runs/${encodeURIComponent(args.run_id)}/provenance`),
  },
  {
    name: 'mc_attach_eval',
    description: 'Attach an evaluation result (pass/fail, score) to a run',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string' },
        pass: { type: 'boolean', description: 'Whether the run passed evaluation' },
        score: { type: 'number', description: 'Score 0-100' },
        task_type: { type: 'string', description: 'Category (e.g. pr-review, bug-fix, test-gen)' },
        detail: { type: 'string', description: 'Evaluation notes' },
      },
      required: ['run_id', 'pass', 'score'],
    },
    handler: async (args) => {
      const { run_id, ...evalData } = args;
      return api('PUT', `/api/v1/runs/${encodeURIComponent(run_id)}/eval`, evalData);
    },
  },
  {
    name: 'mc_eval_leaderboard',
    description: 'Get the eval leaderboard — agents ranked by avg score, pass rate, and cost',
    inputSchema: {
      type: 'object',
      properties: {
        benchmark_id: { type: 'string', description: 'Filter by benchmark pack' },
        limit: { type: 'number', description: 'Max entries (default 50)' },
      },
      required: [],
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.benchmark_id) params.set('benchmark_id', args.benchmark_id);
      if (args.limit) params.set('limit', String(args.limit));
      return api('GET', `/api/v1/evals/leaderboard?${params}`);
    },
  },
];

// Build lookup map
const toolMap = new Map();
for (const tool of TOOLS) {
  toolMap.set(tool.name, tool);
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP protocol handler
// ---------------------------------------------------------------------------

const SERVER_INFO = {
  name: 'mission-control',
  version: '2.1.0',
};

const CAPABILITIES = {
  tools: {},
};

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — just acknowledge
  if (id === undefined) {
    if (method === 'notifications/initialized') return null; // no response needed
    return null;
  }

  switch (method) {
    case 'initialize':
      return makeResponse(id, {
        protocolVersion: '2024-11-05',
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      });

    case 'tools/list':
      return makeResponse(id, {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      const tool = toolMap.get(toolName);

      if (!tool) {
        return makeResponse(id, {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        });
      }

      try {
        const result = await tool.handler(args);
        return makeResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return makeResponse(id, {
          content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return makeResponse(id, {});

    default:
      return makeError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Stdio transport
// ---------------------------------------------------------------------------

function send(msg) {
  if (!msg) return;
  const json = JSON.stringify(msg);
  process.stdout.write(json + '\n');
}

async function main() {
  // Disable stdout buffering for interactive use
  if (process.stdout._handle && process.stdout._handle.setBlocking) {
    process.stdout._handle.setBlocking(true);
  }

  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const msg = JSON.parse(trimmed);
      const response = await handleMessage(msg);
      send(response);
    } catch (err) {
      send(makeError(null, -32700, `Parse error: ${err?.message || 'invalid JSON'}`));
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  // Keep process alive
  process.stdin.resume();
}

if (require.main === module) {
  main();
}

module.exports = {
  TOOLS,
  toolMap,
  handleMessage,
  SERVER_INFO,
};

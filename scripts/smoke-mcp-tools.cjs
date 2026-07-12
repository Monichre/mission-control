#!/usr/bin/env node
/*
 Smoke-check: assert Task 2 MCP mutation tools are registered in mc-mcp-server.cjs
 Usage: node scripts/smoke-mcp-tools.cjs
*/

const { TOOLS } = require('./mc-mcp-server.cjs');

const REQUIRED = [
  'mc_create_agent',
  'mc_update_agent',
  'mc_delete_agent',
  'mc_delete_task',
  'mc_upsert_skill',
  'mc_delete_skill',
  'mc_create_cron',
  'mc_update_cron',
  'mc_pause_cron',
  'mc_resume_cron',
  'mc_remove_cron',
  'mc_run_cron',
  'mc_list_tokens',
  'mc_task_costs',
  'mc_token_trends',
  'mc_token_export',
  'mc_token_rotate_info',
  // Task 8: session primitives + knowledge raw access
  'mc_pause_session',
  'mc_terminate_session',
  'mc_list_knowledge_files',
  'mc_knowledge_link_graph',
  'mc_knowledge_context',
];

const FORBIDDEN = ['mc_rotate_token', 'mc_token_rotate'];

const names = new Set(TOOLS.map((tool) => tool.name));
const missing = REQUIRED.filter((name) => !names.has(name));
const forbidden = FORBIDDEN.filter((name) => names.has(name));

if (missing.length > 0) {
  console.error('Missing MCP tools:', missing.join(', '));
  process.exit(1);
}

if (forbidden.length > 0) {
  console.error('Unsafe MCP tools exposed:', forbidden.join(', '));
  process.exit(1);
}

console.log(`OK: ${REQUIRED.length} required tools registered (${TOOLS.length} total)`);

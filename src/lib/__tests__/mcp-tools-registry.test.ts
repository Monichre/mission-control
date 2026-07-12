import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { TOOLS } = require(path.resolve('scripts/mc-mcp-server.cjs')) as {
  TOOLS: Array<{ name: string; description: string; inputSchema: { type: string } }>
}

const REQUIRED_MUTATION_TOOLS = [
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
]

describe('mc-mcp-server tool registry', () => {
  it('registers all required mutation and token tools', () => {
    const names = new Set(TOOLS.map((tool) => tool.name))
    for (const toolName of REQUIRED_MUTATION_TOOLS) {
      expect(names.has(toolName), `missing tool: ${toolName}`).toBe(true)
    }
  })

  it('keeps unique tool names with schemas', () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(new Set(names).size).toBe(names.length)
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  it('does not expose unsafe token rotation mutation', () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(names).not.toContain('mc_rotate_token')
    expect(names).not.toContain('mc_token_rotate')
  })
})

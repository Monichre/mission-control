import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_CONTEXT_SECTION_MARKER,
  type ContextPayload,
} from '@/lib/memory-utils'

const { generateContextPayloadMock } = vi.hoisted(() => ({
  generateContextPayloadMock: vi.fn<(baseDir: string) => Promise<ContextPayload>>(),
}))

vi.mock('@/lib/memory-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/memory-utils')>()
  return {
    ...actual,
    generateContextPayload: generateContextPayloadMock,
  }
})

vi.mock('@/lib/memory-path', () => ({
  MEMORY_PATH: '/tmp/mission-control-memory',
  MEMORY_ALLOWED_PREFIXES: [],
}))

import {
  buildReviewPrompt,
  buildTaskPrompt,
  CAPABILITIES_SECTION_MARKER,
  formatCapabilitiesSection,
  resolveAgentRunCapabilities,
  resolveTaskDispatchModelOverride,
} from '@/lib/task-dispatch'

const samplePayload: ContextPayload = {
  fileTree: ['memory/context-note.md'],
  recentFiles: [{ path: 'memory/context-note.md', modified: 1_700_000_000_000 }],
  healthSummary: { overall: 'healthy', score: 90 },
  maintenanceSignals: [],
}

const baseTask = {
  id: 42,
  title: 'Inject context into prompts',
  description: 'Ensure workspace context is prepended.',
  status: 'assigned',
  priority: 'high',
  assigned_to: 'jarv',
  workspace_id: 1,
  agent_name: 'jarv',
  agent_id: 1,
  agent_config: null,
  ticket_prefix: 'MC',
  project_ticket_no: 7,
  project_id: null,
}

describe('resolveTaskDispatchModelOverride', () => {
  it('returns null when the agent has no explicit dispatch model override', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: null })).toBeNull()
    expect(resolveTaskDispatchModelOverride({ agent_config: '{"openclawId":"main"}' })).toBeNull()
  })

  it('returns the explicit dispatch model override when present', () => {
    expect(
      resolveTaskDispatchModelOverride({
        agent_config: '{"openclawId":"main","dispatchModel":"openai-codex/gpt-5.4"}',
      })
    ).toBe('openai-codex/gpt-5.4')
  })

  it('ignores malformed agent config payloads', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: '{not json' })).toBeNull()
  })
})

describe('prompt workspace context wiring', () => {
  beforeEach(() => {
    generateContextPayloadMock.mockReset()
    generateContextPayloadMock.mockResolvedValue(samplePayload)
  })

  it('prepends workspace context to task prompts when payload is non-empty', async () => {
    const prompt = await buildTaskPrompt(baseTask)
    expect(prompt.startsWith(WORKSPACE_CONTEXT_SECTION_MARKER)).toBe(true)
    expect(prompt).toContain('- memory/context-note.md')
    expect(prompt).toContain('You have been assigned a task in Mission Control.')
    expect(prompt).toContain('**[MC-007] Inject context into prompts**')
  })

  it('prepends workspace context to review prompts when payload is non-empty', async () => {
    const prompt = await buildReviewPrompt({
      id: baseTask.id,
      title: baseTask.title,
      description: baseTask.description,
      status: 'review',
      priority: baseTask.priority,
      resolution: 'Done.',
      assigned_to: baseTask.assigned_to,
      agent_config: baseTask.agent_config,
      workspace_id: baseTask.workspace_id,
      project_id: baseTask.project_id,
      ticket_prefix: baseTask.ticket_prefix,
      project_ticket_no: baseTask.project_ticket_no,
    })
    expect(prompt.startsWith(WORKSPACE_CONTEXT_SECTION_MARKER)).toBe(true)
    expect(prompt).toContain('Health: healthy (score 90/100)')
    expect(prompt).toContain('You are Aegis, the quality reviewer for Mission Control.')
  })

  it('omits workspace context when payload is empty', async () => {
    generateContextPayloadMock.mockResolvedValue({
      fileTree: [],
      recentFiles: [],
      healthSummary: { overall: 'healthy', score: 100 },
      maintenanceSignals: [],
    })

    const prompt = await buildTaskPrompt(baseTask)
    expect(prompt.startsWith(WORKSPACE_CONTEXT_SECTION_MARKER)).toBe(false)
    expect(prompt.startsWith('You have been assigned a task in Mission Control.')).toBe(true)
  })
})

describe('resolveAgentRunCapabilities', () => {
  it('prefers explicit capabilities from agent config', () => {
    expect(
      resolveAgentRunCapabilities(JSON.stringify({ capabilities: ['code-review', 'testing'] })),
    ).toEqual(['code-review', 'testing'])
  })

  it('falls back to OpenClaw tools.allow when capabilities are absent', () => {
    expect(
      resolveAgentRunCapabilities(JSON.stringify({
        tools: { allow: ['read', 'write', 'exec'], deny: ['cron'] },
      })),
    ).toEqual(['read', 'write', 'exec'])
  })

  it('falls back to universal template capabilities via template field', () => {
    expect(
      resolveAgentRunCapabilities(JSON.stringify({ template: 'researcher' })),
    ).toEqual(['web_browse', 'data_gathering', 'summarization'])
  })

  it('falls back to role-based template capabilities', () => {
    expect(resolveAgentRunCapabilities(null, 'reviewer')).toEqual([
      'code_read',
      'quality_review',
      'security_audit',
    ])
  })
})

describe('formatCapabilitiesSection', () => {
  it('renders the capabilities block with the expected marker and list', () => {
    const section = formatCapabilitiesSection(['code_write', 'testing'])
    expect(section).toContain(CAPABILITIES_SECTION_MARKER)
    expect(section).toContain('You have access to:')
    expect(section).toContain('- code_write')
    expect(section).toContain('- testing')
  })

  it('returns an empty string when no capabilities are available', () => {
    expect(formatCapabilitiesSection([])).toBe('')
  })
})

describe('prompt capabilities wiring', () => {
  beforeEach(() => {
    generateContextPayloadMock.mockReset()
    generateContextPayloadMock.mockResolvedValue({
      fileTree: [],
      recentFiles: [],
      healthSummary: { overall: 'healthy', score: 100 },
      maintenanceSignals: [],
    })
  })

  it('injects explicit agent capabilities into task prompts', async () => {
    const prompt = await buildTaskPrompt({
      ...baseTask,
      agent_config: JSON.stringify({ capabilities: ['code-review', 'testing'] }),
    })

    expect(prompt).toContain(CAPABILITIES_SECTION_MARKER)
    expect(prompt).toContain('You have access to:')
    expect(prompt).toContain('- code-review')
    expect(prompt).toContain('- testing')
    expect(prompt.indexOf(CAPABILITIES_SECTION_MARKER)).toBeLessThan(
      prompt.indexOf('You have been assigned a task in Mission Control.'),
    )
  })

  it('injects tools.allow capabilities when explicit capabilities are absent', async () => {
    const prompt = await buildTaskPrompt({
      ...baseTask,
      agent_config: JSON.stringify({
        tools: { allow: ['read', 'write', 'exec'], deny: ['cron'] },
      }),
    })

    expect(prompt).toContain('- read')
    expect(prompt).toContain('- write')
    expect(prompt).toContain('- exec')
  })

  it('injects reviewer template capabilities into review prompts', async () => {
    const prompt = await buildReviewPrompt({
      id: baseTask.id,
      title: baseTask.title,
      description: baseTask.description,
      status: 'review',
      priority: baseTask.priority,
      resolution: 'Done.',
      assigned_to: baseTask.assigned_to,
      agent_config: JSON.stringify({
        tools: { allow: ['read', 'write', 'exec'], deny: ['cron'] },
      }),
      workspace_id: baseTask.workspace_id,
      project_id: baseTask.project_id,
      ticket_prefix: baseTask.ticket_prefix,
      project_ticket_no: baseTask.project_ticket_no,
    })

    expect(prompt).toContain(CAPABILITIES_SECTION_MARKER)
    expect(prompt).toContain('- code_read')
    expect(prompt).toContain('- quality_review')
    expect(prompt).toContain('- security_audit')
    expect(prompt).not.toContain('- write')
    expect(prompt.indexOf(CAPABILITIES_SECTION_MARKER)).toBeLessThan(
      prompt.indexOf('You are Aegis, the quality reviewer for Mission Control.'),
    )
  })

  it('omits capabilities block when agent config has no resolvable capabilities', async () => {
    const prompt = await buildTaskPrompt(baseTask)
    expect(prompt).not.toContain(CAPABILITIES_SECTION_MARKER)
  })
})

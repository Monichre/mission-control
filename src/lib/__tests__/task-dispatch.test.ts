import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildReviewPrompt,
  buildTaskPrompt,
  resolveTaskDispatchModelOverride,
} from '@/lib/task-dispatch'
import {
  WORKSPACE_CONTEXT_SECTION_MARKER,
  type ContextPayload,
} from '@/lib/memory-utils'

const generateContextPayloadMock = vi.fn<(baseDir: string) => Promise<ContextPayload>>()

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

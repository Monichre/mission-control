import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { requireRole, logActivity, readFile, writeFile, existsSync, mkdir } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  logActivity: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  existsSync: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/db', () => ({
  db_helpers: { logActivity },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/config', () => ({
  config: { openclawHome: '/tmp/openclaw-home', gatewayHost: '127.0.0.1', gatewayPort: 7010 },
}))
vi.mock('fs/promises', () => ({
  readFile,
  writeFile,
  mkdir,
}))
vi.mock('fs', () => ({
  existsSync,
}))

describe('PUT /api/exec-approvals broadcast', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({
      user: { username: 'operator', role: 'operator', workspace_id: 2 },
    })
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    existsSync.mockReturnValue(true)
    writeFile.mockResolvedValue(undefined)
    mkdir.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('broadcasts activity after allowlist save', async () => {
    const { PUT } = await import('@/app/api/exec-approvals/route')
    const request = new NextRequest('http://localhost/api/exec-approvals', {
      method: 'PUT',
      body: JSON.stringify({
        agents: {
          'agent-a': [{ pattern: 'echo *' }],
          'agent-b': [{ pattern: 'ls *' }],
        },
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await PUT(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(logActivity).toHaveBeenCalledWith(
      'exec_allowlist_updated',
      'exec_approval',
      0,
      'operator',
      'Updated exec approval allowlist for 2 agent(s)',
      expect.objectContaining({
        agentIds: ['agent-a', 'agent-b'],
        action: 'allowlist_save',
      }),
      2,
    )
  })
})

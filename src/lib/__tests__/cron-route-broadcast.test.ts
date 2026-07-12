import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { requireRole, logActivity } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  logActivity: vi.fn(),
}))

let tempStateDir = ''

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/db', () => ({
  db_helpers: { logActivity },
}))
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('@/lib/config', () => ({
  get config() {
    return { openclawStateDir: tempStateDir }
  },
}))

const sampleCronFile = {
  version: 1,
  jobs: [
    {
      id: 'job-1',
      agentId: 'system',
      name: 'daily-report',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { kind: 'agentTurn', message: 'Run daily report' },
      delivery: { mode: 'none' },
      state: {},
    },
  ],
}

function writeCronJobsFile(jobs = sampleCronFile.jobs) {
  const cronDir = join(tempStateDir, 'cron')
  mkdirSync(cronDir, { recursive: true })
  writeFileSync(join(cronDir, 'jobs.json'), JSON.stringify({ version: 1, jobs }, null, 2))
}

describe('POST /api/cron broadcast', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    tempStateDir = join(tmpdir(), `mc-cron-broadcast-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tempStateDir, { recursive: true })
    writeCronJobsFile()
    requireRole.mockReturnValue({
      user: { username: 'admin', role: 'admin', workspace_id: 1 },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (tempStateDir) {
      rmSync(tempStateDir, { recursive: true, force: true })
    }
  })

  it('broadcasts activity after toggle', async () => {
    const { POST } = await import('@/app/api/cron/route')
    const request = new NextRequest('http://localhost/api/cron', {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle', jobId: 'job-1' }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.enabled).toBe(false)
    expect(logActivity).toHaveBeenCalledWith(
      'cron_job_toggled',
      'cron',
      0,
      'admin',
      'Cron job disabled: daily-report',
      expect.objectContaining({ jobId: 'job-1', jobName: 'daily-report', enabled: false, action: 'toggle' }),
      1,
    )
  })

  it('broadcasts activity after remove', async () => {
    const { POST } = await import('@/app/api/cron/route')
    const request = new NextRequest('http://localhost/api/cron', {
      method: 'POST',
      body: JSON.stringify({ action: 'remove', jobId: 'job-1' }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(logActivity).toHaveBeenCalledWith(
      'cron_job_removed',
      'cron',
      0,
      'admin',
      'Removed cron job: daily-report',
      expect.objectContaining({ jobId: 'job-1', jobName: 'daily-report', action: 'remove' }),
      1,
    )
  })

  it('broadcasts activity after add', async () => {
    const { POST } = await import('@/app/api/cron/route')
    const request = new NextRequest('http://localhost/api/cron', {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        name: 'new-job',
        schedule: '0 8 * * *',
        command: 'Do something',
      }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(logActivity).toHaveBeenCalledWith(
      'cron_job_added',
      'cron',
      0,
      'admin',
      'Added cron job: new-job',
      expect.objectContaining({ jobName: 'new-job', schedule: '0 8 * * *', action: 'add' }),
      1,
    )
  })

  it('broadcasts activity after clone', async () => {
    const { POST } = await import('@/app/api/cron/route')
    const request = new NextRequest('http://localhost/api/cron', {
      method: 'POST',
      body: JSON.stringify({ action: 'clone', jobId: 'job-1' }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.clonedName).toBe('daily-report (copy)')
    expect(logActivity).toHaveBeenCalledWith(
      'cron_job_cloned',
      'cron',
      0,
      'admin',
      'Cloned cron job: daily-report → daily-report (copy)',
      expect.objectContaining({
        sourceJobId: 'job-1',
        sourceJobName: 'daily-report',
        jobName: 'daily-report (copy)',
        action: 'clone',
      }),
      1,
    )
  })
})

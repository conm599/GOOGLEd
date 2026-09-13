import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { TransferTask } from '../types'
import { getPlatform } from '../platform'
import { logger } from '../logger'

const DIR = () => path.join(getPlatform().userDataDir(), 'transfers')
const FILE = () => path.join(DIR(), 'tasks.json')

/**
 * 传输任务持久化：断点续传的「断点」就保存在这里。
 * 原子写入（tmp + rename），崩溃/断电后启动时恢复。
 * 异步 + 1 秒合并写：几万个任务时同步整写 JSON 会周期性冻结主进程。
 */
export class TaskStore {
  private pending: TransferTask[] | null = null
  private timer: NodeJS.Timeout | null = null
  private queue: Promise<void> = Promise.resolve()

  load(): TransferTask[] {
    try {
      if (!fs.existsSync(FILE())) return []
      return JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as TransferTask[]
    } catch (e) {
      logger.error('tasks.json 损坏，将重建', e)
      return []
    }
  }

  /** 合并 1 秒内的多次保存；pending 始终保存最新列表，后写覆盖前写 */
  save(tasks: TransferTask[]): void {
    this.pending = tasks
    this.timer ??= setTimeout(() => {
      this.timer = null
      this.flush()
    }, 1000)
  }

  private flush(): void {
    const tasks = this.pending
    this.pending = null
    if (!tasks) return
    this.queue = this.queue
      .then(async () => {
        await fsp.mkdir(DIR(), { recursive: true })
        const tmp = FILE() + '.tmp'
        await fsp.writeFile(tmp, JSON.stringify(tasks), 'utf-8')
        await fsp.rename(tmp, FILE())
      })
      .catch((e) => logger.error('传输任务保存失败', e))
  }
}

import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TransferTask } from '../../shared/types'
import { logger } from '../logger'

const DIR = () => path.join(app.getPath('userData'), 'transfers')
const FILE = () => path.join(DIR(), 'tasks.json')

/**
 * 传输任务持久化：断点续传的「断点」就保存在这里。
 * 原子写入（tmp + rename），崩溃/断电后启动时恢复。
 */
export class TaskStore {
  private writing = false

  load(): TransferTask[] {
    try {
      if (!fs.existsSync(FILE())) return []
      return JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as TransferTask[]
    } catch (e) {
      logger.error('tasks.json 损坏，将重建', e)
      return []
    }
  }

  save(tasks: TransferTask[]): void {
    if (this.writing) return
    this.writing = true
    try {
      fs.mkdirSync(DIR(), { recursive: true })
      const tmp = FILE() + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(tasks, null, 1), 'utf-8')
      fs.renameSync(tmp, FILE())
    } catch (e) {
      logger.error('传输任务保存失败', e)
    } finally {
      this.writing = false
    }
  }
}

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import type { BackupTask } from '../../shared/types'

/** 备份任务持久化：userData/backups.json（含上次同步快照） */
interface StoredBackup extends BackupTask {
  /** 上次同步快照：相对路径 → { size, mtimeMs } */
  files: Record<string, { size: number; mtimeMs: number }>
}

const FILE = () => path.join(app.getPath('userData'), 'backups.json')

export class BackupStore {
  load(): StoredBackup[] {
    try {
      if (!fs.existsSync(FILE())) return []
      return JSON.parse(fs.readFileSync(FILE(), 'utf-8')) as StoredBackup[]
    } catch {
      return []
    }
  }

  save(tasks: StoredBackup[]): void {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE(), JSON.stringify(tasks), 'utf-8')
  }
}

export type { StoredBackup }
